const MIN_POST_LENGTH = 20;
const SEND_INTERVAL_MS = 3000;

const processedPostIds = new Set();
const queuedPostsById = new Map();

let observer = null;
let autoScanEnabled = true;
let sendTimer = null;
let lastSentAt = 0;

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

  const post = {
    id: postId,
    text,
    author: extractAuthor(article),
    post_url: postUrl,
    group_name: resolveGroupName(),
    group_url: window.location.href,
    timestamp: timestamp || new Date().toISOString()
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
  if (message.action !== "manual_scan") {
    return false;
  }

  const posts = extractPostsFromPage(document.body);
  if (posts.length) {
    queuePosts(posts);
  }
  sendResponse({ count: posts.length });
  return true;
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", loadAutoScanSetting, { once: true });
} else {
  loadAutoScanSetting();
}
