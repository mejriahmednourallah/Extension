const STORAGE_KEYS = {
  alerts: "alerts",
  unreadCount: "unread_count",
  config: "config",
  lastScan: "last_scan"
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
const BACKEND_HEALTH_CACHE_TTL_MS = 60000;

const analyzeQueue = [];
let analyzeWorkerRunning = false;
const backendHealthyUntilByUrl = new Map();

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

async function fetchWithTimeout(url, options = {}, timeoutMs = BACKEND_PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
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

async function updateBadge(unreadCount) {
  const text = unreadCount > 0 ? String(unreadCount) : "";
  await chrome.action.setBadgeBackgroundColor({ color: "#e53e3e" });
  await chrome.action.setBadgeText({ text });
}

function buildAlertEntry(post, result) {
  const sentiment = String(result.sentiment || "neutral").toLowerCase();
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
    STORAGE_KEYS.config
  ]);

  const updates = {};
  if (!Array.isArray(state[STORAGE_KEYS.alerts])) {
    updates[STORAGE_KEYS.alerts] = [];
  }
  if (typeof state[STORAGE_KEYS.unreadCount] !== "number") {
    updates[STORAGE_KEYS.unreadCount] = 0;
  }

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

  await storageSet(updates);
  await updateBadge(state[STORAGE_KEYS.unreadCount] || 0);
}

async function callAnalyzeApi(posts) {
  const { [STORAGE_KEYS.config]: configFromStorage } = await storageGet([STORAGE_KEYS.config]);
  const config = { ...DEFAULT_CONFIG, ...(configFromStorage || {}) };

  const payload = {
    posts,
    client_name: config.client_name || "",
    keywords: Array.isArray(config.keywords) ? config.keywords : [],
    alert_email: config.alert_email || ""
  };

  const backendUrl = sanitizeBackendUrl(config.backend_url);
  const headers = buildBackendHeaders(backendUrl);

  // Render free services can be cold; probe health with retries before analyze.
  await probeBackendHealth(backendUrl, headers);

  const response = await fetchWithTimeout(`${backendUrl}/analyze`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

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

  const state = await storageGet([STORAGE_KEYS.alerts]);
  const existingAlerts = Array.isArray(state[STORAGE_KEYS.alerts])
    ? state[STORAGE_KEYS.alerts]
    : [];

  const mergedAlerts = [...newEntries, ...existingAlerts]
    .filter((item, index, arr) => arr.findIndex((entry) => entry.id === item.id) === index)
    .slice(0, 100);

  const unreadCount = countUnreadNegative(mergedAlerts);

  await storageSet({
    [STORAGE_KEYS.alerts]: mergedAlerts,
    [STORAGE_KEYS.unreadCount]: unreadCount,
    [STORAGE_KEYS.lastScan]: new Date().toISOString()
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
        console.error("analyze_posts processing failed", error);
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
    STORAGE_KEYS.lastScan
  ]);

  return {
    alerts: Array.isArray(state[STORAGE_KEYS.alerts]) ? state[STORAGE_KEYS.alerts] : [],
    unread_count: Number(state[STORAGE_KEYS.unreadCount] || 0),
    config: { ...DEFAULT_CONFIG, ...(state[STORAGE_KEYS.config] || {}) },
    last_scan: state[STORAGE_KEYS.lastScan] || null
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
  return mergedConfig;
}

function isFacebookGroupUrl(url) {
  return /^https:\/\/(www|web|m)\.facebook\.com\/groups\//i.test(String(url || ""));
}

function sendManualScanMessage(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: "manual_scan" }, (response) => {
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

  const firstAttempt = await sendManualScanMessage(tabId);
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

  const secondAttempt = await sendManualScanMessage(tabId);
  if (secondAttempt.ok) {
    return { ok: true, ...(secondAttempt.response || {}) };
  }

  return {
    ok: false,
    error: secondAttempt.error || "Could not connect to page context. Reload tab and retry."
  };
}

chrome.runtime.onInstalled.addListener(() => {
  ensureStorageDefaults().catch((error) => {
    console.error("Failed during extension install bootstrap", error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  ensureStorageDefaults().catch((error) => {
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

        case "manual_scan_active_tab": {
          const response = await manualScanActiveTab();
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
