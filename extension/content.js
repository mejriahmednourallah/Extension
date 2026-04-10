(() => {
if (globalThis.__ereputationWatcherContentLoaded) {
  return;
}

globalThis.__ereputationWatcherContentLoaded = true;

const MIN_POST_LENGTH = 20;
const SEND_INTERVAL_MS = 3000;

const processedPostIds = new Set();
const queuedPostsById = new Map();

let observer = null;
let autoScanEnabled = true;
let sendTimer = null;
let lastSentAt = 0;

const AUTO_SCROLL_DEFAULTS = {
  interval_ms: 1300,
  step_min_px: 450,
  step_max_px: 900,
  max_steps_per_run: 45,
  max_idle_rounds: 6
};

const autoScrollState = {
  running: false,
  timer: null,
  steps: 0,
  idleRounds: 0,
  newPosts: 0,
  lastReason: "not_started",
  startedAt: null,
  stoppedAt: null,
  config: { ...AUTO_SCROLL_DEFAULTS }
};

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripEmoji(value) {
  return String(value || "").replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "");
}

function cleanText(value) {
  return normalizeWhitespace(stripEmoji(value));
}

function parseCountToken(rawValue) {
  if (!rawValue) {
    return 0;
  }

  const compact = String(rawValue)
    .replace(/[\u00A0\s]/g, "")
    .replace(/,/g, ".")
    .trim()
    .toLowerCase();

  const match = compact.match(/^(\d+(?:\.\d+)?)([kmb])?$/i);
  if (!match) {
    const fallback = compact.match(/\d+/);
    return fallback ? Number.parseInt(fallback[0], 10) : 0;
  }

  const base = Number.parseFloat(match[1]);
  const suffix = match[2] || "";
  const multiplier = suffix === "k" ? 1000 : suffix === "m" ? 1000000 : suffix === "b" ? 1000000000 : 1;

  if (!Number.isFinite(base)) {
    return 0;
  }

  return Math.max(0, Math.round(base * multiplier));
}

function pickCountByPatterns(text, patterns) {
  if (!text) {
    return 0;
  }

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) {
      continue;
    }

    const captured = match[1] || match[2] || "";
    const parsed = parseCountToken(captured);
    if (parsed > 0) {
      return parsed;
    }
  }

  return 0;
}

function extractEngagementCounts(article) {
  const text = cleanText(article && (article.innerText || article.textContent || ""));

  const reactions = pickCountByPatterns(text, [
    /(\d+[\d\s.,]*\s*[kKmMbB]?)\s*(?:reactions?|reaction|j['’]?aime|likes?)/i,
    /(?:reactions?|reaction|j['’]?aime|likes?)\s*[:\-]?\s*(\d+[\d\s.,]*\s*[kKmMbB]?)/i,
    /(\d+[\d\s.,]*\s*[kKmMbB]?)\s*(?:إعجابات|إعجاب|اعجابات|اعجاب)/i,
    /(?:إعجابات|إعجاب|اعجابات|اعجاب)\s*[:\-]?\s*(\d+[\d\s.,]*\s*[kKmMbB]?)/i
  ]);

  const comments = pickCountByPatterns(text, [
    /(\d+[\d\s.,]*\s*[kKmMbB]?)\s*(?:commentaires?|comments?)/i,
    /(?:commentaires?|comments?)\s*[:\-]?\s*(\d+[\d\s.,]*\s*[kKmMbB]?)/i,
    /(\d+[\d\s.,]*\s*[kKmMbB]?)\s*(?:تعليقات|تعليق)/i,
    /(?:تعليقات|تعليق)\s*[:\-]?\s*(\d+[\d\s.,]*\s*[kKmMbB]?)/i
  ]);

  const shares = pickCountByPatterns(text, [
    /(\d+[\d\s.,]*\s*[kKmMbB]?)\s*(?:partages?|shares?)/i,
    /(?:partages?|shares?)\s*[:\-]?\s*(\d+[\d\s.,]*\s*[kKmMbB]?)/i,
    /(\d+[\d\s.,]*\s*[kKmMbB]?)\s*(?:مشاركات|مشاركة)/i,
    /(?:مشاركات|مشاركة)\s*[:\-]?\s*(\d+[\d\s.,]*\s*[kKmMbB]?)/i
  ]);

  return {
    reactions_count: reactions,
    comments_count: comments,
    shares_count: shares
  };
}

function safeBase64(value) {
  try {
    return btoa(unescape(encodeURIComponent(value)));
  } catch (error) {
    const fallback = Array.from(String(value || ""))
      .map((char) => char.charCodeAt(0).toString(16))
      .join("");
    return btoa(fallback);
  }
}

function buildPostId(text) {
  const key = cleanText(text).slice(0, 50).toLowerCase();
  return safeBase64(key).replace(/=+$/g, "").slice(0, 80);
}

function resolveGroupName() {
  const title = document.title || "Facebook Group";
  return cleanText(title.replace(/\s*\|\s*Facebook\s*$/i, ""));
}

function extractAuthor(article) {
  const selectors = [
    "h2 a[role='link']",
    "h3 a[role='link']",
    "strong a[role='link']",
    "a[role='link']"
  ];

  for (const selector of selectors) {
    const element = article.querySelector(selector);
    if (element && cleanText(element.textContent)) {
      return cleanText(element.textContent);
    }
  }

  return "Unknown";
}

function extractTimestampAndUrl(article) {
  const abbr = article.querySelector("a[role='link'] abbr");
  if (abbr) {
    const link = abbr.closest("a");
    return {
      timestamp: cleanText(abbr.textContent),
      post_url: (link && link.href) || window.location.href
    };
  }

  const link = article.querySelector(
    "a[href*='/posts/'], a[href*='permalink'], a[href*='/groups/']"
  );

  return {
    timestamp: cleanText(link && link.textContent) || new Date().toISOString(),
    post_url: (link && link.href) || window.location.href
  };
}

function extractPostFromArticle(article) {
  const text = cleanText(article.innerText || article.textContent || "");
  if (text.length < MIN_POST_LENGTH) {
    return null;
  }

  const postId = buildPostId(text);
  if (!postId || processedPostIds.has(postId)) {
    return null;
  }

  const { timestamp, post_url: postUrl } = extractTimestampAndUrl(article);
  const engagement = extractEngagementCounts(article);

  const post = {
    id: postId,
    text,
    author: extractAuthor(article),
    post_url: postUrl,
    group_name: resolveGroupName(),
    group_url: window.location.href,
    timestamp: timestamp || new Date().toISOString(),
    reactions_count: engagement.reactions_count,
    comments_count: engagement.comments_count,
    shares_count: engagement.shares_count
  };

  processedPostIds.add(postId);
  return post;
}

function collectArticleNodes(root) {
  const nodes = [];

  if (root instanceof Element) {
    if (root.matches("div[role='article']")) {
      nodes.push(root);
    }
    nodes.push(...root.querySelectorAll("div[role='article']"));

    const feedUnits = root.querySelectorAll("div[data-pagelet^='FeedUnit_']");
    for (const feedUnit of feedUnits) {
      const article = feedUnit.querySelector("div[role='article']");
      if (article) {
        nodes.push(article);
      }
    }
  }

  if (!nodes.length) {
    nodes.push(...document.querySelectorAll("div[data-pagelet^='FeedUnit_'], div[role='article']"));
  }

  const uniqueNodes = [];
  const seen = new Set();
  for (const node of nodes) {
    if (!node || seen.has(node)) {
      continue;
    }
    seen.add(node);
    uniqueNodes.push(node);
  }

  return uniqueNodes;
}

function extractPostsFromPage(root = document.body) {
  const posts = [];
  const seenIds = new Set();
  const articleNodes = collectArticleNodes(root);

  for (const article of articleNodes) {
    const post = extractPostFromArticle(article);
    if (!post || seenIds.has(post.id)) {
      continue;
    }
    seenIds.add(post.id);
    posts.push(post);
  }

  return posts;
}

function scheduleSend() {
  if (sendTimer || !queuedPostsById.size) {
    return;
  }

  const elapsed = Date.now() - lastSentAt;
  const delay = Math.max(0, SEND_INTERVAL_MS - elapsed);

  sendTimer = setTimeout(() => {
    sendTimer = null;
    flushQueue();
  }, delay);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

function getScrollHeight() {
  const bodyHeight = document.body ? document.body.scrollHeight : 0;
  const docHeight = document.documentElement ? document.documentElement.scrollHeight : 0;
  return Math.max(bodyHeight, docHeight, window.innerHeight || 0);
}

function normalizeAutoScrollConfig(config) {
  const source = config && typeof config === "object" ? config : {};
  const interval = Number(source.interval_ms);
  const stepMin = Number(source.step_min_px);
  const stepMax = Number(source.step_max_px);
  const maxSteps = Number(source.max_steps_per_run);
  const maxIdle = Number(source.max_idle_rounds);

  return {
    interval_ms: Number.isFinite(interval) ? Math.max(400, Math.min(5000, Math.round(interval))) : AUTO_SCROLL_DEFAULTS.interval_ms,
    step_min_px: Number.isFinite(stepMin) ? Math.max(100, Math.min(3000, Math.round(stepMin))) : AUTO_SCROLL_DEFAULTS.step_min_px,
    step_max_px: Number.isFinite(stepMax) ? Math.max(150, Math.min(3500, Math.round(stepMax))) : AUTO_SCROLL_DEFAULTS.step_max_px,
    max_steps_per_run: Number.isFinite(maxSteps) ? Math.max(5, Math.min(300, Math.round(maxSteps))) : AUTO_SCROLL_DEFAULTS.max_steps_per_run,
    max_idle_rounds: Number.isFinite(maxIdle) ? Math.max(2, Math.min(30, Math.round(maxIdle))) : AUTO_SCROLL_DEFAULTS.max_idle_rounds
  };
}

function getAutoScrollStatus() {
  return {
    running: autoScrollState.running,
    steps: autoScrollState.steps,
    idle_rounds: autoScrollState.idleRounds,
    new_posts: autoScrollState.newPosts,
    last_reason: autoScrollState.lastReason,
    started_at: autoScrollState.startedAt,
    stopped_at: autoScrollState.stoppedAt,
    config: { ...autoScrollState.config }
  };
}

function stopAutoScroller(reason = "stopped") {
  if (autoScrollState.timer) {
    clearTimeout(autoScrollState.timer);
    autoScrollState.timer = null;
  }

  autoScrollState.running = false;
  autoScrollState.lastReason = reason;
  autoScrollState.stoppedAt = new Date().toISOString();
  return getAutoScrollStatus();
}

function scheduleAutoScrollTick(delayMs) {
  if (!autoScrollState.running) {
    return;
  }

  if (autoScrollState.timer) {
    clearTimeout(autoScrollState.timer);
  }

  autoScrollState.timer = setTimeout(() => {
    autoScrollState.timer = null;
    runAutoScrollTick().catch((error) => {
      console.warn("Auto-scroller failed:", error);
      stopAutoScroller("error");
    });
  }, delayMs);
}

async function runAutoScrollTick() {
  if (!autoScrollState.running) {
    return;
  }

  const config = autoScrollState.config;
  const beforeHeight = getScrollHeight();
  const beforeY = Math.max(0, Math.round(window.scrollY || 0));
  const scrollStep = randomInt(config.step_min_px, config.step_max_px);

  window.scrollBy({ top: scrollStep, left: 0, behavior: "smooth" });
  await delay(config.interval_ms);

  const discoveredPosts = extractPostsFromPage(document.body);
  if (discoveredPosts.length) {
    autoScrollState.newPosts += discoveredPosts.length;
    queuePosts(discoveredPosts);
  }

  const afterHeight = getScrollHeight();
  const afterY = Math.max(0, Math.round(window.scrollY || 0));
  const atBottom = afterY + window.innerHeight >= afterHeight - 8;
  const progressed = discoveredPosts.length > 0 || afterHeight > beforeHeight || afterY > beforeY;

  autoScrollState.steps += 1;
  autoScrollState.idleRounds = progressed && !atBottom ? 0 : autoScrollState.idleRounds + 1;

  if (autoScrollState.steps >= config.max_steps_per_run) {
    stopAutoScroller("max_steps_reached");
    return;
  }

  if (autoScrollState.idleRounds >= config.max_idle_rounds) {
    stopAutoScroller(atBottom ? "end_of_feed" : "idle_limit_reached");
    return;
  }

  const jitter = randomInt(120, 260);
  scheduleAutoScrollTick(config.interval_ms + jitter);
}

function startAutoScroller(config) {
  if (autoScrollState.running) {
    return getAutoScrollStatus();
  }

  autoScrollState.config = normalizeAutoScrollConfig(config);
  autoScrollState.running = true;
  autoScrollState.steps = 0;
  autoScrollState.idleRounds = 0;
  autoScrollState.newPosts = 0;
  autoScrollState.lastReason = "running";
  autoScrollState.startedAt = new Date().toISOString();
  autoScrollState.stoppedAt = null;

  const initialPosts = extractPostsFromPage(document.body);
  if (initialPosts.length) {
    autoScrollState.newPosts += initialPosts.length;
    queuePosts(initialPosts);
  }

  scheduleAutoScrollTick(250);
  return getAutoScrollStatus();
}

function queuePosts(posts) {
  for (const post of posts) {
    if (!post || !post.id || queuedPostsById.has(post.id)) {
      continue;
    }
    queuedPostsById.set(post.id, post);
  }

  scheduleSend();
}

function flushQueue() {
  if (!queuedPostsById.size) {
    return;
  }

  const posts = Array.from(queuedPostsById.values());
  queuedPostsById.clear();
  lastSentAt = Date.now();

  try {
    chrome.runtime.sendMessage({ action: "analyze_posts", posts }, (response) => {
      if (chrome.runtime.lastError) {
        const message = chrome.runtime.lastError.message || "Unknown runtime error";
        if (!/receiving end does not exist|extension context invalidated/i.test(message)) {
          console.warn("Failed to send posts to background:", message);
        }

        // Do not lose posts if the extension worker is temporarily unavailable.
        queuePosts(posts);
        return;
      }

      if (response && response.ok === false) {
        console.warn("Background rejected analyze_posts:", response.error || "unknown error");
        queuePosts(posts);
      }
    });
  } catch (error) {
    const message = String(error && error.message ? error.message : error || "");
    if (!/extension context invalidated/i.test(message)) {
      console.warn("sendMessage threw unexpectedly:", error);
    }
    queuePosts(posts);
  }
}

function handleMutations(mutations) {
  if (!autoScanEnabled) {
    return;
  }

  const discoveredPosts = [];
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (!(node instanceof Element)) {
        continue;
      }
      const posts = extractPostsFromPage(node);
      if (posts.length) {
        discoveredPosts.push(...posts);
      }
    }
  }

  if (discoveredPosts.length) {
    queuePosts(discoveredPosts);
  }
}

function startObserver() {
  if (observer || !document.body) {
    return;
  }

  observer = new MutationObserver(handleMutations);
  observer.observe(document.body, { childList: true, subtree: true });
}

function stopObserver() {
  if (!observer) {
    return;
  }
  observer.disconnect();
  observer = null;
}

function applyAutoScan(enabled) {
  autoScanEnabled = Boolean(enabled);

  if (autoScanEnabled) {
    startObserver();
    const initialPosts = extractPostsFromPage(document.body);
    if (initialPosts.length) {
      queuePosts(initialPosts);
    }
  } else {
    stopAutoScroller("auto_scan_disabled");
    stopObserver();
  }
}

function loadAutoScanSetting() {
  chrome.storage.local.get(["config"], (data) => {
    const config = data.config || {};
    applyAutoScan(config.auto_scan !== false);
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.config) {
    return;
  }

  const newConfig = changes.config.newValue || {};
  applyAutoScan(newConfig.auto_scan !== false);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) {
    return false;
  }

  if (message.action === "manual_scan") {
    const posts = extractPostsFromPage(document.body);
    if (posts.length) {
      queuePosts(posts);
    }
    sendResponse({ count: posts.length });
    return true;
  }

  if (message.action === "auto_scroll_start") {
    const status = startAutoScroller(message.config || {});
    sendResponse({ ok: true, status });
    return true;
  }

  if (message.action === "auto_scroll_stop") {
    const status = stopAutoScroller("stopped_by_user");
    sendResponse({ ok: true, status });
    return true;
  }

  if (message.action === "auto_scroll_status") {
    sendResponse({ ok: true, status: getAutoScrollStatus() });
    return true;
  }

  return false;
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", loadAutoScanSetting, { once: true });
} else {
  loadAutoScanSetting();
}

})();
