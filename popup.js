const Config = {
	COOKIE_FETCH_TIMEOUT_MS: 2500,
	LONG_LIVED_COOKIE_DAYS: 90,
	STORAGE_KEY_THEME: 'popupTheme'
};

const Messages = {
	NO_COOKIES: 'No cookies found. Some sites block extension cookie access. Try interacting with the page first.',
	NO_ISSUES: 'No notable cookie issues detected in this quick check.',
	SCANNING: 'Scanning...',
	SCAN_COMPLETE: 'Scan complete.',
	SCAN_ERROR: 'Something went wrong while scanning.',
	CANNOT_SCAN: 'Cannot scan this page.'
};

const CookieCategory = {
	UNCLASSIFIED: 'Unclassified'
};

const SameSiteValues = {
	NO_RESTRICTION: 'no_restriction'
};

const TwoPartTopLevelDomains = new Set([
	'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'co.jp', 'ne.jp', 'or.jp', 'co.kr',
	'com.au', 'net.au', 'org.au', 'com.br', 'com.mx', 'com.tr', 'co.in', 'com.sg',
	'com.cn', 'com.hk', 'com.tw'
]);

const CategoryToPillClass = {
	analytics: 'pill-cat-analytics',
	marketing: 'pill-cat-marketing',
	advertising: 'pill-cat-marketing',
	necessary: 'pill-cat-necessary',
	functional: 'pill-cat-functional',
	default: 'pill-cat-unclassified'
};


// State

let cookieDatabaseIndex = null;
let userHasScanned = false;

const cookieDatabaseReady = loadCookieDatabase();


// DOM Elements

const elements = {
	statusText: document.getElementById('statusText'),
	cookiesCount: document.getElementById('cookiesCount'),
	httpsState: document.getElementById('httpsState'),
	scanButton: document.getElementById('scanBtn'),
	categoryList: document.getElementById('cookieCategoryList'),
	summaryPanel: document.getElementById('whyPanel'),
	summaryList: document.getElementById('whyList'),
	themeToggle: document.getElementById('themeToggle')
};


// Initialisation

elements.scanButton.addEventListener('click', scanCurrentPage);
setupThemeToggle();


// Cookie Database

async function loadCookieDatabase() {
	try {
		const databaseUrl = chrome.runtime.getURL('assets/open-cookie-database.json');
		const response = await fetch(databaseUrl);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		
		const rawDatabase = await response.json();
		cookieDatabaseIndex = buildDatabaseIndex(rawDatabase);
		return cookieDatabaseIndex;
	} catch (error) {
		console.warn('Could not load cookie database', error);
		cookieDatabaseIndex = null;
		return null;
	}
}

function buildDatabaseIndex(rawDatabase) {
	const exactMatches = new Map();
	const wildcardMatches = [];

	for (const [provider, entries] of Object.entries(rawDatabase || {})) {
		if (!Array.isArray(entries)) continue;

		for (const entry of entries) {
			if (!entry?.cookie) continue;

			const cookieName = String(entry.cookie).trim();
			if (!cookieName) continue;

			const record = {
				name: cookieName,
				nameLower: cookieName.toLowerCase(),
				category: entry.category || null,
				description: entry.description || null,
				dataController: entry.dataController || provider || null,
				privacyLink: entry.privacyLink || null,
				retentionPeriod: entry.retentionPeriod || null,
				provider: provider || entry.dataController || null,
				isWildcard: entry.wildcardMatch === '1' || entry.wildcardMatch === 1
			};

			if (record.isWildcard) {
				wildcardMatches.push(record);
			} else {
				const bucket = exactMatches.get(record.nameLower) || [];
				bucket.push(record);
				exactMatches.set(record.nameLower, bucket);
			}
		}
	}

	wildcardMatches.sort((a, b) => b.nameLower.length - a.nameLower.length);

	return { exactMatches, wildcardMatches };
}

function findCookieInDatabase(cookieName) {
	if (!cookieDatabaseIndex || !cookieName) return null;

	const normalisedName = cookieName.trim().toLowerCase();
	if (!normalisedName) return null;

	const exactMatch = cookieDatabaseIndex.exactMatches.get(normalisedName);
	if (exactMatch?.length) return exactMatch[0];

	for (const wildcardEntry of cookieDatabaseIndex.wildcardMatches) {
		if (normalisedName.startsWith(wildcardEntry.nameLower)) {
			return wildcardEntry;
		}
	}

	return null;
}


// Page Scanning

async function scanCurrentPage() {
	updateScanStatus(Messages.SCANNING, true);
	showSummaryPanel();

	await cookieDatabaseReady.catch(() => null);

	const activeTab = await getActiveTab();
	if (!activeTab) {
		updateScanStatus(Messages.CANNOT_SCAN, false);
		return;
	}

	try {
		const scanResults = await collectPageData(activeTab);
		const pageHost = extractHostname(activeTab.url);

		displayResults(scanResults, pageHost);
		userHasScanned = true;
		updateScanStatus(Messages.SCAN_COMPLETE, false);
	} catch (error) {
		console.error('Scan error', error);
		updateScanStatus(Messages.SCAN_ERROR, false);
	}
}

async function getActiveTab() {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	const isValidTab = tab?.id && tab?.url && !tab.url.startsWith('chrome://');
	return isValidTab ? tab : null;
}

async function collectPageData(tab) {
	const cookies = await fetchCookiesWithTimeout(tab.url);

	return {
		url: tab.url,
		isHttps: tab.url.startsWith('https:'),
		cookies: cookies
	};
}

async function fetchCookiesWithTimeout(url) {
	try {
		const fetchPromise = chrome.cookies.getAll({ url });
		const timeoutPromise = new Promise(resolve => 
			setTimeout(() => resolve(null), Config.COOKIE_FETCH_TIMEOUT_MS)
		);

		const rawCookies = await Promise.race([fetchPromise, timeoutPromise]);
		
		if (!Array.isArray(rawCookies)) return [];

		return rawCookies.map(cookie => ({
			name: cookie.name,
			value: truncateValue(cookie.value),
			domain: cookie.domain || 'unknown',
			secure: cookie.secure,
			httpOnly: cookie.httpOnly,
			sameSite: cookie.sameSite?.toLowerCase() || 'unknown',
			expiresAt: cookie.expirationDate || null
		}));
	} catch (error) {
		console.warn('Could not fetch cookies', error);
		return [];
	}
}

function truncateValue(value) {
	if (!value) return '(empty)';
	return value.length > 30 ? value.slice(0, 30) + '…' : value;
}


// Cookie Analysis

function groupCookiesByCategory(cookies) {
	const categoryMap = new Map();

	for (const cookie of cookies) {
		const databaseInfo = findCookieInDatabase(cookie.name);
		const categoryName = databaseInfo?.category?.trim() || CookieCategory.UNCLASSIFIED;

		cookie.databaseInfo = databaseInfo;
		cookie.categoryName = categoryName;

		const categoryKey = categoryName.toLowerCase();
		const existingCategory = categoryMap.get(categoryKey) || {
			key: categoryKey,
			label: categoryName,
			cookies: []
		};
		existingCategory.cookies.push(cookie);
		categoryMap.set(categoryKey, existingCategory);
	}

	return sortCategoriesWithUnclassifiedLast(Array.from(categoryMap.values()));
}

function sortCategoriesWithUnclassifiedLast(categories) {
	return categories.sort((a, b) => {
		const aIsUnclassified = a.label.toLowerCase() === CookieCategory.UNCLASSIFIED.toLowerCase();
		const bIsUnclassified = b.label.toLowerCase() === CookieCategory.UNCLASSIFIED.toLowerCase();

		if (aIsUnclassified !== bIsUnclassified) {
			return aIsUnclassified ? 1 : -1;
		}
		return b.cookies.length - a.cookies.length;
	});
}

function analyseCookies(cookies, isHttps) {
	const totalCount = cookies.length;
	const insecureCount = cookies.filter(c => !c.secure).length;
	const unclassifiedCount = cookies.filter(c => 
		(c.categoryName || CookieCategory.UNCLASSIFIED).toLowerCase() === CookieCategory.UNCLASSIFIED.toLowerCase()
	).length;

	const longLivedThreshold = Date.now() / 1000 + (Config.LONG_LIVED_COOKIE_DAYS * 86400);
	const longLivedCount = cookies.filter(c => c.expiresAt > longLivedThreshold).length;

	const findings = [
		`${totalCount} cookie${totalCount === 1 ? '' : 's'} detected on this page.`,
		`${insecureCount} ${insecureCount === 1 ? 'cookie lacks' : 'cookies lack'} the Secure flag.`,
		`${unclassifiedCount} ${unclassifiedCount === 1 ? 'is' : 'are'} unclassified (no trusted info yet).`
	];

	if (longLivedCount > 0) {
		findings.push(`${longLivedCount} last longer than ${Config.LONG_LIVED_COOKIE_DAYS} days.`);
	}

	if (!isHttps) {
		findings.push('Connection is not HTTPS.');
	}

	return findings;
}


// Rendering

function displayResults(scanResults, pageHost) {
	const categories = groupCookiesByCategory(scanResults.cookies);
	const findings = analyseCookies(scanResults.cookies, scanResults.isHttps);

	elements.cookiesCount.textContent = scanResults.cookies.length;
	elements.httpsState.textContent = scanResults.isHttps ? 'HTTPS' : 'Not HTTPS';

	renderFindingsList(findings);
	renderCategoryList(categories, pageHost);
}

function renderFindingsList(findings) {
	if (!elements.summaryList) return;

	elements.summaryList.innerHTML = '';

	const itemsToShow = findings.length ? findings : [Messages.NO_ISSUES];
	for (const finding of itemsToShow) {
		const listItem = document.createElement('li');
		listItem.textContent = finding;
		elements.summaryList.appendChild(listItem);
	}

	showSummaryPanel();
}

function renderCategoryList(categories, pageHost) {
	elements.categoryList.innerHTML = '';

	if (!categories.length) {
		elements.categoryList.innerHTML = `<li>${Messages.NO_COOKIES}</li>`;
		return;
	}

	for (const category of categories) {
		elements.categoryList.appendChild(
			createCategorySection(category, pageHost)
		);
	}
}

function createCategorySection(category, pageHost) {
	const details = document.createElement('details');
	details.className = 'details segment-details';

	const summary = document.createElement('summary');
	summary.textContent = `${category.label} (${category.cookies.length})`;
	details.appendChild(summary);

	const cookieList = document.createElement('ul');
	cookieList.className = 'cookie-list';
	
	for (const cookie of category.cookies) {
		cookieList.appendChild(createCookieCard(cookie, pageHost));
	}

	details.appendChild(cookieList);
	return details;
}

function createCookieCard(cookie, pageHost) {
	const card = document.createElement('li');
	card.className = 'cookie-entry';

	const databaseInfo = cookie.databaseInfo;
	const isThirdParty = checkIfThirdPartyCookie(cookie.domain, pageHost);
	const isPersistent = !!cookie.expiresAt;
	const isVerified = !!databaseInfo;

	card.appendChild(createBadgeRow(isThirdParty, isPersistent, cookie.categoryName, isVerified));

	const metadata = [
		['Cookie Name', cookie.name],
		['Purpose', databaseInfo?.description || 'Unknown'],
		['Category', cookie.categoryName],
		['Retention Period', databaseInfo?.retentionPeriod || 'Unknown'],
		['Expires on', cookie.expiresAt ? formatDate(cookie.expiresAt) : 'Unknown'],
		['Data Controller', databaseInfo?.dataController || databaseInfo?.provider || 'Unknown'],
		['Domain', cookie.domain],
		['Read more', databaseInfo?.privacyLink || 'Unknown'],
		['Flags', formatCookieFlags(cookie)]
	];

	for (const [label, value] of metadata) {
		card.appendChild(createLabelValueRow(label, value));
	}

	return card;
}

function createBadgeRow(isThirdParty, isPersistent, category, isVerified) {
	const row = document.createElement('div');
	row.className = 'badge-row';

	const badges = [
		{
			text: isThirdParty ? 'Third-party' : 'First-party',
			className: isThirdParty ? 'pill-third' : 'pill-first',
			tooltip: isThirdParty ? 'Set by another domain than the one you visited.' : 'Set by the site you visited.'
		},
		{
			text: isPersistent ? 'Persistent' : 'Session',
			className: isPersistent ? 'pill-persistent' : 'pill-session',
			tooltip: isPersistent ? 'Stays after the browser is closed.' : 'Goes away when the browser is closed.'
		},
		{
			text: category,
			className: getPillClassForCategory(category),
			tooltip: 'Category from the cookie database when available.'
		},
		{
			text: isVerified ? 'Verified' : 'Inferred',
			className: isVerified ? 'pill-verified' : 'pill-inferred',
			tooltip: isVerified ? 'Matched in the cookie database.' : 'Estimated because no match was found.'
		}
	];

	for (const badge of badges) {
		row.appendChild(createPill(badge.text, badge.className, badge.tooltip));
	}

	return row;
}

function createPill(text, className, tooltip) {
	const pill = document.createElement('span');
	pill.className = `pill ${className}`.trim();
	pill.textContent = text;
	if (tooltip) pill.title = tooltip;
	return pill;
}

function getPillClassForCategory(category) {
	if (!category) return CategoryToPillClass.default;

	const normalizedCategory = category.toLowerCase();

	for (const [keyword, className] of Object.entries(CategoryToPillClass)) {
		if (keyword !== 'default' && normalizedCategory.includes(keyword)) {
			return className;
		}
	}

	return CategoryToPillClass.default;
}

function createLabelValueRow(label, value) {
	const row = document.createElement('div');
	row.className = 'cookie-line';

	const labelSpan = document.createElement('span');
	labelSpan.className = 'meta-label';
	labelSpan.textContent = `${label}:`;

	const valueSpan = document.createElement('span');
	valueSpan.textContent = value;

	row.appendChild(labelSpan);
	row.appendChild(valueSpan);
	return row;
}


// UI State

function updateScanStatus(message, isScanning) {
	elements.statusText.textContent = message;
	elements.scanButton.disabled = isScanning;
	elements.scanButton.textContent = isScanning ? 'Scanning...' : (userHasScanned ? 'Scan again?' : 'Scan page');
	elements.scanButton.classList.toggle('scanned', userHasScanned);
}

function showSummaryPanel() {
	elements.summaryPanel?.removeAttribute('hidden');
}


// Theme

async function setupThemeToggle() {
	if (!elements.themeToggle) return;

	const savedTheme = await readFromStorage(Config.STORAGE_KEY_THEME);
	applyTheme(savedTheme === 'light' ? 'light' : 'dark');

	elements.themeToggle.addEventListener('click', async () => {
		const currentTheme = document.documentElement.dataset.theme;
		const newTheme = currentTheme === 'light' ? 'dark' : 'light';
		applyTheme(newTheme);
		await writeToStorage(Config.STORAGE_KEY_THEME, newTheme);
	});
}

function applyTheme(theme) {
	const isLightTheme = theme === 'light';
	document.documentElement.dataset.theme = theme;

	if (elements.themeToggle) {
		elements.themeToggle.textContent = isLightTheme ? 'Dark mode' : 'Light mode';
		elements.themeToggle.setAttribute('aria-pressed', String(isLightTheme));
		elements.themeToggle.title = isLightTheme ? 'Switch to dark mode' : 'Switch to light mode';
	}
}


// Storage

function isChromeStorageAvailable() {
	return typeof chrome !== 'undefined' && !!chrome.storage?.local;
}

async function readFromStorage(key) {
	if (!key) return null;

	if (isChromeStorageAvailable()) {
		try {
			const result = await chrome.storage.local.get(key);
			return result?.[key] ?? null;
		} catch { /* fall through */ }
	}

	try {
		const raw = localStorage.getItem(key);
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

async function writeToStorage(key, value) {
	if (!key) return;

	if (isChromeStorageAvailable()) {
		try {
			await chrome.storage.local.set({ [key]: value });
			return;
		} catch { /* fall through */ }
	}

	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch { /* ignore */ }
}


// Domain Utilities

function extractHostname(url) {
	try {
		return new URL(url).hostname;
	} catch {
		return '';
	}
}

function getRegistrableDomain(hostname) {
	if (!hostname) return '';

	const normalisedHost = hostname.toLowerCase();
	const domainParts = normalisedHost.split('.').filter(Boolean);

	if (domainParts.length <= 2) return normalisedHost;

	const lastTwoParts = domainParts.slice(-2).join('.');

	if (TwoPartTopLevelDomains.has(lastTwoParts) && domainParts.length >= 3) {
		return domainParts.slice(-3).join('.');
	}

	return lastTwoParts;
}

function checkIfThirdPartyCookie(cookieDomain, pageHost) {
	if (!cookieDomain || !pageHost) return false;

	const normalisedCookieDomain = cookieDomain.replace(/^\./, '').toLowerCase();
	const cookieRegistrableDomain = getRegistrableDomain(normalisedCookieDomain);
	const pageRegistrableDomain = getRegistrableDomain(pageHost.toLowerCase());

	return cookieRegistrableDomain !== pageRegistrableDomain;
}


// Formatting

function formatDate(epochSeconds) {
	if (!epochSeconds) return 'unknown';

	try {
		return new Date(epochSeconds * 1000).toLocaleDateString();
	} catch {
		return 'unknown';
	}
}

function formatCookieFlags(cookie) {
	const flags = [];

	if (cookie.secure) flags.push('Secure');
	if (cookie.httpOnly) flags.push('HttpOnly');
	if (cookie.sameSite && cookie.sameSite !== SameSiteValues.NO_RESTRICTION) {
		flags.push(`SameSite=${cookie.sameSite}`);
	}

	return flags.length ? flags.join(', ') : 'None';
}
