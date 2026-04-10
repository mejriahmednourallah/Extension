const STORAGE_KEYS = {
  alerts: "alerts",
  unreadCount: "unread_count",
  config: "config",
  lastScan: "last_scan",
  dailyMetrics: "daily_metrics",
  installationId: "installation_id",
  groups: "groups",
  groupsSyncedAt: "groups_synced_at",
  extensionStateSyncedAt: "extension_state_synced_at"
};

const DEFAULT_CONFIG = {
  client_name: "Banque biat",
  keywords: [
    "banque",
    "bank",
    "banque tunisie",
    "banque tunisienne",
    "service client banque",
    "agence bancaire",
    "carte bancaire",
    "compte bancaire",
    "credit bancaire",
    "pret bancaire",
    "virement",
    "frais bancaires",
    "application bancaire",
    "rib",
    "iban",
    "atm",
    "guichet automatique",
    "بنك",
    "البنك",
    "بنوك",
    "مصرف",
    "المصرف",
    "خدمة بنكية",
    "وكالة بنكية",
    "بطاقة بنكية",
    "حساب بنكي",
    "قرض",
    "تحويل بنكي",
    "خدمة الحرفاء"
  ],
  alert_email: "client@banque.tn",
  auto_scan: true,
  backend_url: "http://localhost:8000",
  groq_api_key: "",
  gemini_api_key: ""
};

const LEGACY_KEYWORD_VARIANTS = [
  ["banque xyz", "xyz bank", "carte xyz"],
  [
    "banque xyz",
    "xyz bank",
    "carte xyz",
    "biat",
    "banque biat",
    "biat bank",
    "carte biat",
    "compte biat",
    "credit biat",
    "agence biat",
    "application biat",
    "banque",
    "bank",
    "بنك",
    "البنك",
    "مصرف",
    "المصرف",
    "البنوك",
    "بيات",
    "بنك بيات",
    "بطاقة بنكية",
    "حساب بنكي",
    "قرض"
  ]
];

const BRAND_SPECIFIC_KEYWORDS = new Set(
  [
    "banque xyz",
    "xyz bank",
    "carte xyz",
    "xyz",
    "biat",
    "banque biat",
    "biat bank",
    "carte biat",
    "compte biat",
    "credit biat",
    "agence biat",
    "application biat",
    "بيات",
    "بنك بيات"
  ].map((item) => item.toLowerCase())
);

const NEGATIVE_SENTIMENTS = new Set(["negative", "very_negative"]);
const BACKEND_PROBE_MAX_ATTEMPTS = 12;
const BACKEND_PROBE_BASE_DELAY_MS = 1500;
const BACKEND_PROBE_TIMEOUT_MS = 12000;
const ANALYZE_REQUEST_TIMEOUT_MS = 35000;
const ANALYZE_REQUEST_MAX_ATTEMPTS = 2;
const BACKEND_HEALTH_CACHE_TTL_MS = 60000;
const GROUPS_SYNC_TTL_MS = 60000;
const EXTENSION_STATE_SYNC_TTL_MS = 60000;

const analyzeQueue = [];
let analyzeWorkerRunning = false;
const backendHealthyUntilByUrl = new Map();
const groupsSyncedUntilByUrl = new Map();
const extensionStateSyncedUntilByUrl = new Map();

function getTodayKey() {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function buildEmptyDailyMetrics(dateKey = getTodayKey()) {
  return {
    date: dateKey,
    total_posts: 0,
    very_negative: 0,
    negative: 0,
    neutral: 0,
    positive: 0
  };
}

function normalizeDailyMetrics(rawValue) {
  const today = getTodayKey();
  const value = rawValue && typeof rawValue === "object" ? rawValue : {};
  const date = String(value.date || "");

  if (date !== today) {
    return buildEmptyDailyMetrics(today);
  }

  return {
    date: today,
    total_posts: Math.max(0, Number(value.total_posts || 0)),
    very_negative: Math.max(0, Number(value.very_negative || 0)),
    negative: Math.max(0, Number(value.negative || 0)),
    neutral: Math.max(0, Number(value.neutral || 0)),
    positive: Math.max(0, Number(value.positive || 0))
  };
}

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result));
  });
}

function storageSet(values) {
  return new Promise((resolve) => {
    chrome.storage.local.set(values, () => resolve());
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatErrorDetails(error) {
  if (!error) {
    return "Unknown error";
  }

  const name = String(error.name || "Error");
  const message = String(error.message || error);
  const stack = typeof error.stack === "string" ? error.stack : "";
  const details = `${name}: ${message}`;

  return stack ? `${details}\n${stack}` : details;
}

function generateInstallationId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `ext-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function ensureInstallationId() {
  const state = await storageGet([STORAGE_KEYS.installationId]);
  const existing = String(state[STORAGE_KEYS.installationId] || "").trim();
  if (existing) {
    return existing;
  }

  const created = generateInstallationId();
  await storageSet({ [STORAGE_KEYS.installationId]: created });
  return created;
}

function normalizeGroupUrl(url) {
  const value = String(url || "").trim();
  if (!value) {
    return "";
  }

  try {
    const parsed = new URL(value);
    const normalizedPath = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${normalizedPath}`.toLowerCase();
  } catch (error) {
    return value.replace(/\/+$/, "").toLowerCase();
  }
}

function extractFacebookGroupId(url) {
  const value = normalizeGroupUrl(url);
  const match = value.match(/\/groups\/([^/?#]+)/i);
  return match ? String(match[1]).trim().toLowerCase() : "";
}

function filterPostsByMonitoredGroups(posts, groups) {
  const enabledGroups = Array.isArray(groups) ? groups.filter((group) => group && group.enabled !== false) : [];

  if (!enabledGroups.length) {
    // Fail-open default: before any group is configured, analyze all collected posts.
    return Array.isArray(posts) ? posts : [];
  }

  const normalizedGroupUrls = enabledGroups
    .map((group) => normalizeGroupUrl(group.group_url || group.url || ""))
    .filter(Boolean);
  const groupIds = new Set(
    enabledGroups
      .map((group) => extractFacebookGroupId(group.group_url || group.url || ""))
      .filter(Boolean)
  );

  return (Array.isArray(posts) ? posts : []).filter((post) => {
    const postGroupUrl = normalizeGroupUrl(post.group_url || "");
    const postPostUrl = normalizeGroupUrl(post.post_url || "");
    const postGroupId = extractFacebookGroupId(post.group_url || post.post_url || "");

    if (postGroupId && groupIds.has(postGroupId)) {
      return true;
    }

    if (postGroupUrl && normalizedGroupUrls.some((groupUrl) => postGroupUrl.startsWith(groupUrl))) {
      return true;
    }

    if (postPostUrl && normalizedGroupUrls.some((groupUrl) => postPostUrl.includes(groupUrl))) {
      return true;
    }

    return false;
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = BACKEND_PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    const isAbortError =
      String(error && error.name || "").toLowerCase() === "aborterror" ||
      /aborted|aborterror|timed out|timeout/i.test(String(error && error.message || ""));

    if (isAbortError) {
      const wrapped = new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
      wrapped.cause = error;
      throw wrapped;
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeBackendUrl(url) {
  const value = (url || "").trim();
  if (!value) {
    return DEFAULT_CONFIG.backend_url;
  }

  const withScheme = /^https?:\/\//i.test(value)
    ? value
    : `${/^(localhost|127\.0\.0\.1)/i.test(value) ? "http" : "https"}://${value}`;

  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch (error) {
    // Last-resort fallback if URL constructor fails on unusual input.
    return withScheme.replace(/\/$/, "");
  }

  const host = parsed.hostname.toLowerCase();
  const isPinggy = /pinggy(-free)?\.link$/i.test(host);
  const isRender = host === "onrender.com" || host.endsWith(".onrender.com");

  if (isPinggy || isRender) {
    parsed.protocol = "https:";
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, "") || "";
  const lowerPath = normalizedPath.toLowerCase();
  const isDirectEndpoint = ["/analyze", "/history", "/health"].includes(lowerPath);

  if (isRender && (isDirectEndpoint || lowerPath === "" || lowerPath === "/")) {
    parsed.pathname = "";
  } else if (isDirectEndpoint) {
    parsed.pathname = "";
  } else {
    parsed.pathname = normalizedPath;
  }

  parsed.search = "";
  parsed.hash = "";

  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  return `${parsed.origin}${path}`;
}

function countUnreadNegative(alerts) {
  return alerts.filter(
    (item) => !item.read && NEGATIVE_SENTIMENTS.has((item.sentiment || "").toLowerCase())
  ).length;
}

function buildBackendHeaders(backendUrl) {
  const headers = { "Content-Type": "application/json" };
  if (/^https?:\/\/[^/]*pinggy(-free)?\.link/i.test(backendUrl)) {
    headers["X-Pinggy-No-Screen"] = "1";
  }
  return headers;
}

async function probeBackendHealth(backendUrl, headers) {
  const healthyUntil = Number(backendHealthyUntilByUrl.get(backendUrl) || 0);
  if (healthyUntil > Date.now()) {
    return;
  }

  let lastError = null;

  for (let attempt = 1; attempt <= BACKEND_PROBE_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchWithTimeout(`${backendUrl}/health`, {
        method: "GET",
        headers
      });

      if (!response.ok) {
        throw new Error(`Health check failed with status ${response.status}`);
      }

      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      if (contentType.includes("application/json")) {
        const payload = await response.json().catch(() => ({}));
        if (payload && payload.status && String(payload.status).toLowerCase() !== "ok") {
          throw new Error(`Backend reported non-ok status: ${payload.status}`);
        }
      } else {
        const body = await response.text();
        if (/pinggy\.web\.debugger|screen\.html/i.test(body)) {
          throw new Error(
            "Backend URL points to Pinggy debugger page, not API tunnel. Use the direct public tunnel URL that forwards to localhost:8000."
          );
        }
      }

      backendHealthyUntilByUrl.set(backendUrl, Date.now() + BACKEND_HEALTH_CACHE_TTL_MS);
      return;
    } catch (error) {
      lastError = error;

      if (attempt < BACKEND_PROBE_MAX_ATTEMPTS) {
        const delayMs = BACKEND_PROBE_BASE_DELAY_MS * attempt;
        await wait(delayMs);
      }
    }
  }

  throw new Error(
    `Backend is still waking up. Last probe error: ${String(lastError && lastError.message ? lastError.message : lastError)}`
  );
}

async function syncExtensionStateWithBackend(config, backendUrl, headers, installationId) {
  const syncedUntil = Number(extensionStateSyncedUntilByUrl.get(backendUrl) || 0);
  if (syncedUntil > Date.now()) {
    return;
  }

  const payload = {
    installation_id: installationId,
    client_name: config.client_name || "",
    alert_email: config.alert_email || "",
    auto_scan: config.auto_scan !== false,
    keywords: Array.isArray(config.keywords) ? config.keywords : []
  };

  try {
    const response = await fetchWithTimeout(`${backendUrl}/extension/sync-state`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`sync-state failed (${response.status}): ${message}`);
    }

    extensionStateSyncedUntilByUrl.set(backendUrl, Date.now() + EXTENSION_STATE_SYNC_TTL_MS);
    await storageSet({ [STORAGE_KEYS.extensionStateSyncedAt]: new Date().toISOString() });
  } catch (error) {
    console.warn("Could not sync extension state to backend", error);
  }
}

async function refreshGroupsFromBackend(backendUrl, headers) {
  const syncedUntil = Number(groupsSyncedUntilByUrl.get(backendUrl) || 0);
  if (syncedUntil > Date.now()) {
    const cached = await storageGet([STORAGE_KEYS.groups]);
    return Array.isArray(cached[STORAGE_KEYS.groups]) ? cached[STORAGE_KEYS.groups] : [];
  }

  try {
    const response = await fetchWithTimeout(`${backendUrl}/groups?include_disabled=true`, {
      method: "GET",
      headers
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`groups fetch failed (${response.status}): ${message}`);
    }

    const groups = await response.json();
    const safeGroups = Array.isArray(groups) ? groups : [];

    await storageSet({
      [STORAGE_KEYS.groups]: safeGroups,
      [STORAGE_KEYS.groupsSyncedAt]: new Date().toISOString()
    });
    groupsSyncedUntilByUrl.set(backendUrl, Date.now() + GROUPS_SYNC_TTL_MS);

    return safeGroups;
  } catch (error) {
    console.warn("Could not refresh groups from backend", error);
    const cached = await storageGet([STORAGE_KEYS.groups]);
    return Array.isArray(cached[STORAGE_KEYS.groups]) ? cached[STORAGE_KEYS.groups] : [];
  }
}

async function updateBadge(unreadCount) {
  const text = unreadCount > 0 ? String(unreadCount) : "";
  await chrome.action.setBadgeBackgroundColor({ color: "#e53e3e" });
  await chrome.action.setBadgeText({ text });
}

function buildAlertEntry(post, result) {
  const sentiment = String(result.sentiment || "neutral").toLowerCase();
  const reactionsCount = Math.max(0, Number(post.reactions_count || 0));
  const commentsCount = Math.max(0, Number(post.comments_count || 0));
  const sharesCount = Math.max(0, Number(post.shares_count || 0));

  return {
    id: post.id,
    text: post.text,
    author: post.author,
    post_url: post.post_url,
    group_name: post.group_name,
    group_url: post.group_url,
    sentiment,
    score: Number(result.score || 0),
    category: result.category || "other",
    keywords_matched: Array.isArray(result.keywords_matched) ? result.keywords_matched : [],
    bad_buzz_suggestions: Array.isArray(result.bad_buzz_suggestions)
      ? result.bad_buzz_suggestions
      : [],
    reactions_count: reactionsCount,
    comments_count: commentsCount,
    shares_count: sharesCount,
    engagement_total: Math.max(0, Number(result.engagement_total || reactionsCount + commentsCount + sharesCount)),
    priority_score: Number(result.priority_score || 0),
    timestamp: new Date().toISOString(),
    read: !NEGATIVE_SENTIMENTS.has(sentiment)
  };
}

function showNotification(alert) {
  if (!NEGATIVE_SENTIMENTS.has(alert.sentiment)) {
    return;
  }

  const label = alert.sentiment === "very_negative" ? "Tres negatif" : "Negatif";
  chrome.notifications.create(`alert-${alert.id}-${Date.now()}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: `${label} - ${alert.group_name || "Facebook Group"}`,
    message: (alert.text || "").slice(0, 180)
  });
}

async function ensureStorageDefaults() {
  const state = await storageGet([
    STORAGE_KEYS.alerts,
    STORAGE_KEYS.unreadCount,
    STORAGE_KEYS.config,
    STORAGE_KEYS.dailyMetrics,
    STORAGE_KEYS.installationId,
    STORAGE_KEYS.groups
  ]);

  const updates = {};
  if (!Array.isArray(state[STORAGE_KEYS.alerts])) {
    updates[STORAGE_KEYS.alerts] = [];
  }
  if (typeof state[STORAGE_KEYS.unreadCount] !== "number") {
    updates[STORAGE_KEYS.unreadCount] = 0;
  }
  if (!Array.isArray(state[STORAGE_KEYS.groups])) {
    updates[STORAGE_KEYS.groups] = [];
  }

  updates[STORAGE_KEYS.dailyMetrics] = normalizeDailyMetrics(state[STORAGE_KEYS.dailyMetrics]);

  const storedConfig = state[STORAGE_KEYS.config] || {};
  const config = { ...DEFAULT_CONFIG, ...storedConfig };

  if (Array.isArray(config.keywords)) {
    const normalizedKeywords = config.keywords
      .map((item) => String(item || "").trim())
      .filter(Boolean);

    const normalizedSet = new Set(normalizedKeywords.map((item) => item.toLowerCase()));
    const looksLegacyOnly = LEGACY_KEYWORD_VARIANTS.some((legacyKeywords) => {
      const legacySet = new Set(legacyKeywords.map((item) => item.toLowerCase()));
      return (
        normalizedSet.size === legacySet.size &&
        [...legacySet].every((item) => normalizedSet.has(item))
      );
    });

    const cleanedKeywords = normalizedKeywords.filter(
      (item) => !BRAND_SPECIFIC_KEYWORDS.has(item.toLowerCase())
    );

    if (looksLegacyOnly) {
      config.keywords = [...DEFAULT_CONFIG.keywords];
    } else if (cleanedKeywords.length === 0) {
      config.keywords = [...DEFAULT_CONFIG.keywords];
    } else {
      config.keywords = cleanedKeywords;
    }
  }

  // Backfill defaults for first-run experience.
  if (!String(config.client_name || "").trim()) {
    config.client_name = DEFAULT_CONFIG.client_name;
  }
  if (!Array.isArray(config.keywords) || config.keywords.length === 0) {
    config.keywords = [...DEFAULT_CONFIG.keywords];
  }
  if (!String(config.alert_email || "").trim()) {
    config.alert_email = DEFAULT_CONFIG.alert_email;
  }
  if (!String(config.backend_url || "").trim()) {
    config.backend_url = DEFAULT_CONFIG.backend_url;
  }
  if (!String(config.groq_api_key || "").trim()) {
    config.groq_api_key = DEFAULT_CONFIG.groq_api_key;
  }
  if (!String(config.gemini_api_key || "").trim()) {
    config.gemini_api_key = DEFAULT_CONFIG.gemini_api_key;
  }

  updates[STORAGE_KEYS.config] = config;

  const installationId = String(state[STORAGE_KEYS.installationId] || "").trim();
  if (!installationId) {
    updates[STORAGE_KEYS.installationId] = generateInstallationId();
  }

  await storageSet(updates);
  await updateBadge(state[STORAGE_KEYS.unreadCount] || 0);
}

async function callAnalyzeApi(posts) {
  const {
    [STORAGE_KEYS.config]: configFromStorage,
    [STORAGE_KEYS.installationId]: installationIdFromStorage
  } = await storageGet([STORAGE_KEYS.config, STORAGE_KEYS.installationId]);

  const config = { ...DEFAULT_CONFIG, ...(configFromStorage || {}) };
  const installationId = String(installationIdFromStorage || "").trim() || (await ensureInstallationId());

  const payload = {
    posts,
    client_name: config.client_name || "",
    keywords: Array.isArray(config.keywords) ? config.keywords : [],
    alert_email: config.alert_email || "",
    installation_id: installationId
  };

  const backendUrl = sanitizeBackendUrl(config.backend_url);
  const headers = buildBackendHeaders(backendUrl);

  // Render free services can be cold; probe health with retries before analyze.
  await probeBackendHealth(backendUrl, headers);

  await syncExtensionStateWithBackend(config, backendUrl, headers, installationId);
  const monitoredGroups = await refreshGroupsFromBackend(backendUrl, headers);

  const filteredPosts = filterPostsByMonitoredGroups(posts, monitoredGroups);
  if (!filteredPosts.length) {
    return { results: [], alerts_sent: 0 };
  }

  payload.posts = filteredPosts;

  let response = null;
  let lastAnalyzeError = null;
  for (let attempt = 1; attempt <= ANALYZE_REQUEST_MAX_ATTEMPTS; attempt += 1) {
    try {
      response = await fetchWithTimeout(
        `${backendUrl}/analyze`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(payload)
        },
        ANALYZE_REQUEST_TIMEOUT_MS
      );
      break;
    } catch (error) {
      lastAnalyzeError = error;
      if (attempt < ANALYZE_REQUEST_MAX_ATTEMPTS) {
        await wait(500 * attempt);
      }
    }
  }

  if (!response) {
    throw new Error(
      `Analyze request failed after ${ANALYZE_REQUEST_MAX_ATTEMPTS} attempt(s): ${formatErrorDetails(lastAnalyzeError)}`
    );
  }

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Backend error ${response.status}: ${message}`);
  }

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    const body = await response.text();
    if (/pinggy\.web\.debugger|screen\.html/i.test(body)) {
      throw new Error(
        "Backend URL points to Pinggy debugger page, not API tunnel. Use the direct public tunnel URL that forwards to localhost:8000."
      );
    }

    throw new Error(
      `Unexpected backend response type: ${contentType || "unknown"}. Expected JSON from /analyze.`
    );
  }

  return response.json();
}

async function handleAnalyzePosts(posts) {
  if (!Array.isArray(posts) || !posts.length) {
    return { count: 0, alerts_sent: 0, results: [] };
  }

  const apiResponse = await callAnalyzeApi(posts);
  const results = Array.isArray(apiResponse.results) ? apiResponse.results : [];
  const postMap = new Map(posts.map((post) => [post.id, post]));

  const newEntries = [];
  for (const result of results) {
    const post = postMap.get(result.post_id);
    if (!post) {
      continue;
    }
    newEntries.push(buildAlertEntry(post, result));
  }

  const state = await storageGet([STORAGE_KEYS.alerts, STORAGE_KEYS.dailyMetrics]);
  const existingAlerts = Array.isArray(state[STORAGE_KEYS.alerts])
    ? state[STORAGE_KEYS.alerts]
    : [];
  const dailyMetrics = normalizeDailyMetrics(state[STORAGE_KEYS.dailyMetrics]);

  dailyMetrics.total_posts += Math.max(0, results.length);
  for (const result of results) {
    const sentiment = String(result && result.sentiment ? result.sentiment : "neutral").toLowerCase();
    if (Object.prototype.hasOwnProperty.call(dailyMetrics, sentiment)) {
      dailyMetrics[sentiment] += 1;
    }
  }

  const mergedAlerts = [...newEntries, ...existingAlerts]
    .filter((item, index, arr) => arr.findIndex((entry) => entry.id === item.id) === index)
    .slice(0, 100);

  const unreadCount = countUnreadNegative(mergedAlerts);

  await storageSet({
    [STORAGE_KEYS.alerts]: mergedAlerts,
    [STORAGE_KEYS.unreadCount]: unreadCount,
    [STORAGE_KEYS.lastScan]: new Date().toISOString(),
    [STORAGE_KEYS.dailyMetrics]: dailyMetrics
  });

  await updateBadge(unreadCount);
  newEntries.forEach(showNotification);

  return {
    count: newEntries.length,
    alerts_sent: Number(apiResponse.alerts_sent || 0),
    results
  };
}

async function processAnalyzeQueue() {
  if (analyzeWorkerRunning) {
    return;
  }

  analyzeWorkerRunning = true;
  try {
    while (analyzeQueue.length) {
      const posts = analyzeQueue.shift();
      if (!Array.isArray(posts) || !posts.length) {
        continue;
      }

      try {
        await handleAnalyzePosts(posts);
      } catch (error) {
        console.error("analyze_posts processing failed", formatErrorDetails(error));
      }
    }
  } finally {
    analyzeWorkerRunning = false;
  }
}

function enqueueAnalyzePosts(posts) {
  const normalizedPosts = Array.isArray(posts)
    ? posts.filter((item) => item && item.id && item.text)
    : [];

  if (!normalizedPosts.length) {
    return 0;
  }

  analyzeQueue.push(normalizedPosts);
  processAnalyzeQueue().catch((error) => {
    console.error("analyze queue worker crashed", error);
  });
  return normalizedPosts.length;
}

async function markAlertRead(alertId) {
  const state = await storageGet([STORAGE_KEYS.alerts]);
  const alerts = Array.isArray(state[STORAGE_KEYS.alerts]) ? state[STORAGE_KEYS.alerts] : [];

  const updatedAlerts = alerts.map((item) =>
    item.id === alertId ? { ...item, read: true } : item
  );

  const unreadCount = countUnreadNegative(updatedAlerts);
  await storageSet({
    [STORAGE_KEYS.alerts]: updatedAlerts,
    [STORAGE_KEYS.unreadCount]: unreadCount
  });
  await updateBadge(unreadCount);

  return { ok: true, unread_count: unreadCount };
}

async function getState() {
  const state = await storageGet([
    STORAGE_KEYS.alerts,
    STORAGE_KEYS.unreadCount,
    STORAGE_KEYS.config,
    STORAGE_KEYS.lastScan,
    STORAGE_KEYS.dailyMetrics,
    STORAGE_KEYS.groups
  ]);

  return {
    alerts: Array.isArray(state[STORAGE_KEYS.alerts]) ? state[STORAGE_KEYS.alerts] : [],
    unread_count: Number(state[STORAGE_KEYS.unreadCount] || 0),
    config: { ...DEFAULT_CONFIG, ...(state[STORAGE_KEYS.config] || {}) },
    last_scan: state[STORAGE_KEYS.lastScan] || null,
    daily_metrics: normalizeDailyMetrics(state[STORAGE_KEYS.dailyMetrics]),
    groups: Array.isArray(state[STORAGE_KEYS.groups]) ? state[STORAGE_KEYS.groups] : []
  };
}

async function saveConfig(partialConfig) {
  const { [STORAGE_KEYS.config]: currentConfig } = await storageGet([STORAGE_KEYS.config]);
  const mergedConfig = { ...DEFAULT_CONFIG, ...(currentConfig || {}), ...(partialConfig || {}) };

  if (!Array.isArray(mergedConfig.keywords)) {
    mergedConfig.keywords = [];
  }

  mergedConfig.backend_url = sanitizeBackendUrl(mergedConfig.backend_url);

  await storageSet({ [STORAGE_KEYS.config]: mergedConfig });

  try {
    await syncCurrentConfigToBackend();
  } catch (error) {
    console.warn("Config saved but backend sync failed", error);
  }

  return mergedConfig;
}

async function syncCurrentConfigToBackend() {
  const {
    [STORAGE_KEYS.config]: configFromStorage,
    [STORAGE_KEYS.installationId]: installationIdFromStorage
  } = await storageGet([STORAGE_KEYS.config, STORAGE_KEYS.installationId]);

  const config = { ...DEFAULT_CONFIG, ...(configFromStorage || {}) };
  const installationId = String(installationIdFromStorage || "").trim() || (await ensureInstallationId());
  const backendUrl = sanitizeBackendUrl(config.backend_url);
  const headers = buildBackendHeaders(backendUrl);

  await probeBackendHealth(backendUrl, headers);
  await syncExtensionStateWithBackend(config, backendUrl, headers, installationId);
  await refreshGroupsFromBackend(backendUrl, headers);
}

function isFacebookGroupUrl(url) {
  return /^https:\/\/(www|web|m)\.facebook\.com\/groups\//i.test(String(url || ""));
}

function sendTabActionMessage(tabId, payload) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message || "Unknown runtime error" });
        return;
      }

      resolve({ ok: true, response: response || {} });
    });
  });
}

async function injectContentScript(tabId) {
  if (!chrome.scripting || typeof chrome.scripting.executeScript !== "function") {
    return false;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
    return true;
  } catch (error) {
    console.warn("Failed to inject content script", error);
    return false;
  }
}

async function manualScanActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length || !tabs[0].id) {
    return { ok: false, error: "No active tab" };
  }

  const activeTab = tabs[0];
  const tabId = activeTab.id;

  if (!isFacebookGroupUrl(activeTab.url)) {
    return {
      ok: false,
      error: "Open a Facebook group page first (www/web/m.facebook.com/groups/...)"
    };
  }

  const firstAttempt = await sendTabActionMessage(tabId, { action: "manual_scan" });
  if (firstAttempt.ok) {
    return { ok: true, ...(firstAttempt.response || {}) };
  }

  const missingReceiver = /receiving end does not exist|could not establish connection/i.test(
    firstAttempt.error || ""
  );

  if (!missingReceiver) {
    return { ok: false, error: firstAttempt.error };
  }

  const injected = await injectContentScript(tabId);
  if (!injected) {
    return {
      ok: false,
      error: "Content script not ready. Reload the Facebook tab and retry."
    };
  }

  const secondAttempt = await sendTabActionMessage(tabId, { action: "manual_scan" });
  if (secondAttempt.ok) {
    return { ok: true, ...(secondAttempt.response || {}) };
  }

  return {
    ok: false,
    error: secondAttempt.error || "Could not connect to page context. Reload tab and retry."
  };
}

async function sendActionToActiveFacebookGroup(messagePayload) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length || !tabs[0].id) {
    return { ok: false, error: "No active tab" };
  }

  const activeTab = tabs[0];
  const tabId = activeTab.id;

  if (!isFacebookGroupUrl(activeTab.url)) {
    return {
      ok: false,
      error: "Open a Facebook group page first (www/web/m.facebook.com/groups/...)"
    };
  }

  const firstAttempt = await sendTabActionMessage(tabId, messagePayload);
  if (firstAttempt.ok) {
    return { ok: true, ...(firstAttempt.response || {}) };
  }

  const missingReceiver = /receiving end does not exist|could not establish connection/i.test(
    firstAttempt.error || ""
  );

  if (!missingReceiver) {
    return { ok: false, error: firstAttempt.error };
  }

  const injected = await injectContentScript(tabId);
  if (!injected) {
    return {
      ok: false,
      error: "Content script not ready. Reload the Facebook tab and retry."
    };
  }

  const secondAttempt = await sendTabActionMessage(tabId, messagePayload);
  if (secondAttempt.ok) {
    return { ok: true, ...(secondAttempt.response || {}) };
  }

  return {
    ok: false,
    error: secondAttempt.error || "Could not connect to page context. Reload tab and retry."
  };
}

async function startAutoScrollActiveTab() {
  const state = await getState();
  const autoScrollConfig = {
    interval_ms: 1300,
    step_min_px: 450,
    step_max_px: 900,
    max_steps_per_run: 45,
    max_idle_rounds: 6,
    ...(state.config && state.config.auto_scroll_config ? state.config.auto_scroll_config : {})
  };

  return sendActionToActiveFacebookGroup({
    action: "auto_scroll_start",
    config: autoScrollConfig
  });
}

async function stopAutoScrollActiveTab() {
  return sendActionToActiveFacebookGroup({ action: "auto_scroll_stop" });
}

async function getAutoScrollStatusActiveTab() {
  return sendActionToActiveFacebookGroup({ action: "auto_scroll_status" });
}

chrome.runtime.onInstalled.addListener(() => {
  (async () => {
    await ensureStorageDefaults();
    await syncCurrentConfigToBackend();
  })().catch((error) => {
    console.error("Failed during extension install bootstrap", error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  (async () => {
    await ensureStorageDefaults();
    await syncCurrentConfigToBackend();
  })().catch((error) => {
    console.error("Failed during extension startup bootstrap", error);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      await ensureStorageDefaults();

      switch (message.action) {
        case "analyze_posts": {
          const queued = enqueueAnalyzePosts(message.posts || []);
          sendResponse({ ok: true, queued });
          return;
        }

        case "get_state": {
          const state = await getState();
          sendResponse(state);
          return;
        }

        case "save_config": {
          const config = await saveConfig(message.config || {});
          sendResponse({ ok: true, config });
          return;
        }

        case "mark_alert_read": {
          const result = await markAlertRead(message.id);
          sendResponse(result);
          return;
        }

        case "clear_alerts": {
          await storageSet({
            [STORAGE_KEYS.alerts]: [],
            [STORAGE_KEYS.unreadCount]: 0
          });
          await updateBadge(0);
          sendResponse({ ok: true });
          return;
        }

        case "manual_scan_active_tab": {
          const response = await manualScanActiveTab();
          sendResponse(response);
          return;
        }

        case "auto_scroll_start": {
          const response = await startAutoScrollActiveTab();
          sendResponse(response);
          return;
        }

        case "auto_scroll_stop": {
          const response = await stopAutoScrollActiveTab();
          sendResponse(response);
          return;
        }

        case "auto_scroll_status": {
          const response = await getAutoScrollStatusActiveTab();
          sendResponse(response);
          return;
        }

        case "open_post": {
          if (message.url) {
            await chrome.tabs.create({ url: message.url });
          }
          sendResponse({ ok: true });
          return;
        }

        default:
          sendResponse({ ok: false, error: "Unknown action" });
      }
    } catch (error) {
      console.error("background message handler failed", error);
      sendResponse({ ok: false, error: String(error) });
    }
  })();

  return true;
});
