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
const analyzeQueue = [];
let analyzeWorkerRunning = false;

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

function sanitizeBackendUrl(url) {
  const value = (url || "").trim();
  if (!value) {
    return DEFAULT_CONFIG.backend_url;
  }

  if (!/^https?:\/\//i.test(value)) {
    const lowerValue = value.toLowerCase();
    const inferredScheme =
      lowerValue.startsWith("localhost") || lowerValue.startsWith("127.0.0.1")
        ? "http"
        : "https";
    return `${inferredScheme}://${value}`.replace(/\/$/, "");
  }

  const normalized = value.replace(/\/$/, "");

  // If user pasted a full endpoint URL, keep only the API base URL.
  const endpointStripped = normalized.replace(/\/(analyze|history|health)$/i, "");

  // Pinggy links generally operate over HTTPS and HTTP can redirect, which
  // may break CORS preflight in browser extensions.
  if (/^http:\/\/[^/]*pinggy(-free)?\.link/i.test(endpointStripped)) {
    return endpointStripped.replace(/^http:\/\//i, "https://");
  }

  // Render services are HTTPS-only in production.
  if (/^http:\/\/[^/]*\.onrender\.com/i.test(endpointStripped)) {
    return endpointStripped.replace(/^http:\/\//i, "https://");
  }

  return endpointStripped;
}

function countUnreadNegative(alerts) {
  return alerts.filter(
    (item) => !item.read && NEGATIVE_SENTIMENTS.has((item.sentiment || "").toLowerCase())
  ).length;
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
  const headers = { "Content-Type": "application/json" };
  if (/^https?:\/\/[^/]*pinggy(-free)?\.link/i.test(backendUrl)) {
    headers["X-Pinggy-No-Screen"] = "1";
  }

  const response = await fetch(`${backendUrl}/analyze`, {
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
