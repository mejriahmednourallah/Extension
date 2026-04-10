(() => {
if (globalThis.__ereputationWatcherContentLoaded) {
  return;
}

globalThis.__ereputationWatcherContentLoaded = true;

const MIN_POST_LENGTH = 20;
const SEND_INTERVAL_MS = 3000;

const DEFAULT_KEYWORD_GATE = {
  min_anchor_hits: 1,
  min_strong_generic_hits: 2,
  min_combo_strong_hits: 1,
  min_combo_weak_hits: 1,
  allow_single_keyword_hit: true
};

const WEAK_GENERIC_KEYWORDS = new Set(
  [
    // French
    "banque",
    "bank",
    "carte",
    "compte",
    "credit",
    "pret",
    "argent",
    "monnaie",
    "paiement",
    "transaction",
    "retrait",
    "depot",
    "transfert",
    "remboursement",
    "plainte",
    "reclamation",
    "service client",
    "atm",
    "rib",
    "iban",
    // Darija (Tunisian Arabic)
    "banka",
    "banki",
    "karta",
    "kart",
    "flous",
    "flousse",
    "flousi",
    "flousna",
    "masraf",
    "7sab",
    "7isab",
    "tnajem",
    // Arabic
    "بنك",
    "البنك",
    "بنوك",
    "مصرف",
    "المصرف",
    "فلوس",
    "فلوسي",
    "حسابي",
    "بطاقتي",
    "تحويل",
    "سحب",
    "ايداع",
    "رصيد",
    "قرض",
    "atm",
    "rib",
    "iban"
  ].map((item) => item.toLowerCase())
);

const CLIENT_NAME_STOPWORDS = new Set(
  ["banque", "bank", "the", "de", "la", "le", "du", "des", "el", "al"]
);

const BRAND_SPECIFIC_KEYWORDS = new Set(
  [
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

const processedPostIds = new Set();
const queuedPostsById = new Map();

const extractionDebug = {
  article_nodes_seen: 0,
  article_nodes_processed: 0,
  accepted_posts: 0,
  dropped_short_text: 0,
  dropped_keyword_gate: 0,
  dropped_duplicate_or_invalid: 0,
  scanned_posts: []
};

let observer = null;
let autoScanEnabled = true;
let sendTimer = null;
let lastSentAt = 0;
let runtimeDetectionConfig = {
  client_name: "",
  keywords: [],
  keyword_tiers: {},
  keyword_gate: { ...DEFAULT_KEYWORD_GATE }
};

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

function resetExtractionDebug() {
  extractionDebug.article_nodes_seen = 0;
  extractionDebug.article_nodes_processed = 0;
  extractionDebug.accepted_posts = 0;
  extractionDebug.dropped_short_text = 0;
  extractionDebug.dropped_keyword_gate = 0;
  extractionDebug.dropped_duplicate_or_invalid = 0;
  extractionDebug.scanned_posts = [];
}

function getExtractionDebugSnapshot() {
  return {
    article_nodes_seen: extractionDebug.article_nodes_seen,
    article_nodes_processed: extractionDebug.article_nodes_processed,
    accepted_posts: extractionDebug.accepted_posts,
    dropped_short_text: extractionDebug.dropped_short_text,
    dropped_keyword_gate: extractionDebug.dropped_keyword_gate,
    dropped_duplicate_or_invalid: extractionDebug.dropped_duplicate_or_invalid,
    scanned_posts: Array.isArray(extractionDebug.scanned_posts)
      ? extractionDebug.scanned_posts.slice()
      : []
  };
}

function pushScannedPostDebug(entry) {
  extractionDebug.scanned_posts.push({
    index: Number(entry.index || 0),
    reason: String(entry.reason || "unknown"),
    text_length: Math.max(0, Number(entry.text_length || 0)),
    text_preview: String(entry.text_preview || ""),
    post_id: entry.post_id ? String(entry.post_id) : null,
    author: String(entry.author || "")
  });
}

function stripEmoji(value) {
  return String(value || "").replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "");
}

function cleanText(value) {
  return normalizeWhitespace(stripEmoji(value));
}

function normalizeKeywordText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u00A0\s]+/g, " ")
    .trim();
}

function uniqueItems(items) {
  return Array.from(new Set((items || []).filter(Boolean)));
}

function normalizeTierLabel(value) {
  const normalized = normalizeKeywordText(value);
  if (normalized === "brand" || normalized === "anchor") {
    return "anchor";
  }
  if (normalized === "strong" || normalized === "strong_generic" || normalized === "domain") {
    return "strong";
  }
  if (normalized === "weak" || normalized === "weak_generic" || normalized === "generic") {
    return "weak";
  }
  return "";
}

function normalizeKeywordTiersMap(value) {
  if (!value || typeof value !== "object") {
    return {};
  }

  const out = {};
  for (const [rawKey, rawTier] of Object.entries(value)) {
    const key = normalizeKeywordText(rawKey);
    const tier = normalizeTierLabel(rawTier);
    if (!key || !tier) {
      continue;
    }
    out[key] = tier;
  }

  return out;
}

function buildClientAnchorHints(clientName) {
  const normalized = normalizeKeywordText(clientName);
  if (!normalized) {
    return [];
  }

  const tokens = normalized
    .split(" ")
    .map((item) => item.trim())
    .filter((item) => item.length >= 3 && !CLIENT_NAME_STOPWORDS.has(item));

  return uniqueItems([normalized, ...tokens]);
}

function classifyKeywordTier(keyword, clientAnchorHints, keywordTiers) {
  const normalized = normalizeKeywordText(keyword);
  if (!normalized) {
    return null;
  }

  const explicitTier = normalizeTierLabel(keywordTiers && keywordTiers[normalized]);
  if (explicitTier) {
    return explicitTier;
  }

  if (BRAND_SPECIFIC_KEYWORDS.has(normalized)) {
    return "anchor";
  }

  const matchesClientAnchor = clientAnchorHints.some((hint) => {
    if (!hint) {
      return false;
    }
    return (
      normalized === hint ||
      normalized.startsWith(`${hint} `) ||
      normalized.endsWith(` ${hint}`) ||
      normalized.includes(` ${hint} `)
    );
  });

  if (matchesClientAnchor) {
    return "anchor";
  }

  const wordCount = normalized.split(" ").filter(Boolean).length;
  if (WEAK_GENERIC_KEYWORDS.has(normalized) || wordCount <= 1) {
    return "weak";
  }

  return "strong";
}

function evaluateKeywordGate(text, config) {
  const source = config && typeof config === "object" ? config : {};
  const normalizedKeywordTiers = normalizeKeywordTiersMap(source.keyword_tiers);
  const keywordGate = {
    ...DEFAULT_KEYWORD_GATE,
    ...(source.keyword_gate && typeof source.keyword_gate === "object" ? source.keyword_gate : {})
  };

  const normalizedText = normalizeKeywordText(text);
  const anchorHints = buildClientAnchorHints(source.client_name || "");
  const normalizedKeywords = uniqueItems([
    ...(Array.isArray(source.keywords) ? source.keywords.map((item) => normalizeKeywordText(item)) : []),
    ...Object.keys(normalizedKeywordTiers),
    ...anchorHints,
  ]);

  if (!normalizedText || !normalizedKeywords.length) {
    return {
      pass: true,
      anchor_hits: 0,
      strong_generic_hits: 0,
      weak_generic_hits: 0,
      matched_keywords: []
    };
  }

  const anchorMatches = [];
  const strongMatches = [];
  const weakMatches = [];

  for (const keyword of normalizedKeywords) {
    if (!keyword || !normalizedText.includes(keyword)) {
      continue;
    }

    const tier = classifyKeywordTier(keyword, anchorHints, normalizedKeywordTiers);
    if (tier === "anchor") {
      anchorMatches.push(keyword);
      continue;
    }
    if (tier === "strong") {
      strongMatches.push(keyword);
      continue;
    }
    weakMatches.push(keyword);
  }

  const anchorHits = uniqueItems(anchorMatches).length;
  const strongHits = uniqueItems(strongMatches).length;
  const weakHits = uniqueItems(weakMatches).length;
  const matchedKeywords = uniqueItems([...anchorMatches, ...strongMatches, ...weakMatches]);

  const passByThresholds =
    anchorHits >= Math.max(1, Number(keywordGate.min_anchor_hits || 1)) ||
    strongHits >= Math.max(1, Number(keywordGate.min_strong_generic_hits || 2)) ||
    (
      strongHits >= Math.max(1, Number(keywordGate.min_combo_strong_hits || 1)) &&
      weakHits >= Math.max(1, Number(keywordGate.min_combo_weak_hits || 1))
    );

  const allowSingleKeywordHit = keywordGate.allow_single_keyword_hit !== false;
  const passBySingleKeywordHit = allowSingleKeywordHit && matchedKeywords.length >= 1;

  const pass = passByThresholds || passBySingleKeywordHit;
  const passReason = passByThresholds
    ? "threshold"
    : passBySingleKeywordHit
      ? "single_keyword_hit"
      : "none";

  return {
    pass,
    pass_reason: passReason,
    anchor_hits: anchorHits,
    strong_generic_hits: strongHits,
    weak_generic_hits: weakHits,
    matched_keywords: matchedKeywords
  };
}

function updateRuntimeDetectionConfig(config) {
  const source = config && typeof config === "object" ? config : {};
  runtimeDetectionConfig = {
    client_name: String(source.client_name || "").trim(),
    keywords: Array.isArray(source.keywords)
      ? source.keywords.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
    keyword_tiers: normalizeKeywordTiersMap(source.keyword_tiers),
    keyword_gate: {
      ...DEFAULT_KEYWORD_GATE,
      ...(source.keyword_gate && typeof source.keyword_gate === "object" ? source.keyword_gate : {})
    }
  };
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

function stableHashFNV1a(value) {
  const input = String(value || "");
  let hash = 0x811c9dc5;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

function extractCanonicalPostLocator(url) {
  const value = String(url || "").trim();
  if (!value) {
    return "";
  }

  try {
    const parsed = new URL(value, window.location.origin);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    const pathMatch = pathname.match(/\/groups\/([^/]+)\/posts\/([^/?#]+)/i);
    if (pathMatch) {
      return `groups/${pathMatch[1].toLowerCase()}/posts/${pathMatch[2].toLowerCase()}`;
    }

    const groupMatch = pathname.match(/\/groups\/([^/?#]+)/i);
    const groupId = groupMatch ? String(groupMatch[1]).trim().toLowerCase() : "";
    const postId =
      parsed.searchParams.get("story_fbid") ||
      parsed.searchParams.get("fbid") ||
      parsed.searchParams.get("fb_id") ||
      parsed.searchParams.get("v") ||
      "";

    if (postId) {
      return groupId
        ? `groups/${groupId}/post/${String(postId).trim().toLowerCase()}`
        : `post/${String(postId).trim().toLowerCase()}`;
    }

    if (groupId) {
      return `groups/${groupId}${pathname.toLowerCase()}`;
    }

    return `${parsed.origin.toLowerCase()}${pathname.toLowerCase()}`;
  } catch (_) {
    const normalized = value.replace(/\/+$/, "").toLowerCase();
    const pathMatch = normalized.match(/\/groups\/([^/]+)\/posts\/([^/?#]+)/i);
    if (pathMatch) {
      return `groups/${pathMatch[1]}/posts/${pathMatch[2]}`;
    }

    const fbidMatch = normalized.match(/[?&](?:story_fbid|fbid|fb_id|v)=([^&#]+)/i);
    const groupMatch = normalized.match(/\/groups\/([^/?#]+)/i);
    if (fbidMatch && groupMatch) {
      return `groups/${groupMatch[1]}/post/${fbidMatch[1]}`;
    }

    return normalized;
  }
}

function buildPostId({ text, author, postUrl, canonicalPostLocator }) {
  const stablePostUrl = canonicalPostLocator ? normalizeWhitespace(postUrl || "") : "";
  const payload = [
    cleanText(author || ""),
    cleanText(text || ""),
    normalizeWhitespace(canonicalPostLocator || ""),
    stablePostUrl
  ].join("\n");

  const primaryHash = stableHashFNV1a(payload);
  const secondaryHash = stableHashFNV1a(`${payload.length}:${payload.slice(-160)}`);
  return `p_${primaryHash}${secondaryHash}`;
}

// Matches /groups/ID/search/ — classic group search
function isFacebookGroupSearchPath(pathname) {
  return /\/groups\/[^/]+\/search(?:\/|$)/i.test(String(pathname || ""));
}

// Matches /groups/ID/keyword/WORD — Facebook's keyword-browse tab
function isFacebookGroupKeywordPath(pathname) {
  return /\/groups\/[^/]+\/keyword(?:\/|$)/i.test(String(pathname || ""));
}

// Matches /groups/ID/hashtag/WORD — Facebook hashtag filter within a group
function isFacebookGroupHashtagPath(pathname) {
  return /\/groups\/[^/]+\/hashtag(?:\/|$)/i.test(String(pathname || ""));
}

/**
 * Returns the active search/keyword/hashtag term for the current page, or ""
 * for normal group feed pages. Any non-empty return value means two things:
 *   1. The keyword gate bypass (search_results) can apply.
 *   2. collectArticleNodes switches to its search-page DOM fallback strategies.
 */
function getSearchQueryFromUrl(url = window.location.href) {
  try {
    const parsed = new URL(String(url || ""));
    const pathname = parsed.pathname;

    // /groups/ID/search/?q=WORD
    if (isFacebookGroupSearchPath(pathname)) {
      return normalizeKeywordText(parsed.searchParams.get("q") || "");
    }

    // /groups/ID/keyword/WORD  →  extract slug from path
    if (isFacebookGroupKeywordPath(pathname)) {
      const match = pathname.match(/\/groups\/[^/]+\/keyword\/([^/?#]+)/i);
      if (match && match[1]) {
        return normalizeKeywordText(decodeURIComponent(match[1]));
      }
      // path ends at /keyword/ with no slug — page is still a keyword browse view
      return "keyword_browse";
    }

    // /groups/ID/hashtag/WORD  →  extract slug from path
    if (isFacebookGroupHashtagPath(pathname)) {
      const match = pathname.match(/\/groups\/[^/]+\/hashtag\/([^/?#]+)/i);
      if (match && match[1]) {
        return normalizeKeywordText(decodeURIComponent(match[1]));
      }
      return "hashtag_browse";
    }

    return "";
  } catch (_) {
    return "";
  }
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
    const postUrl = (link && link.href) || window.location.href;
    return {
      timestamp: cleanText(abbr.textContent),
      post_url: postUrl,
      canonical_post_locator: extractCanonicalPostLocator(postUrl)
    };
  }

  const postLinks = Array.from(article.querySelectorAll(POST_LINK_SELECTOR));
  const rankedLink = postLinks
    .map((link) => ({
      link,
      href: String(link && link.href || ""),
    }))
    .sort((left, right) => {
      const scoreHref = (href) => {
        if (/story_fbid=|[?&]fbid=|[?&]fb_id=|[?&]v=/i.test(href)) return 4;
        if (/\/groups\/[^/]+\/posts\//i.test(href)) return 3;
        if (/permalink/i.test(href)) return 2;
        if (/\/posts\//i.test(href)) return 1;
        return 0;
      };

      return scoreHref(right.href) - scoreHref(left.href);
    })[0];

  const link = rankedLink ? rankedLink.link : article.querySelector("a[href*='/groups/']");
  const postUrl = (link && link.href) || window.location.href;

  return {
    timestamp: cleanText(link && link.textContent) || new Date().toISOString(),
    post_url: postUrl,
    canonical_post_locator: extractCanonicalPostLocator(postUrl)
  };
}

const WRAPPER_REVIEW_TEXT_LENGTH = 5000;
const HARD_WRAPPER_TEXT_LENGTH = 25000;

/**
 * Remove Facebook page-chrome noise that bleeds into containers grabbed by
 * nuclear fallback strategies. This keeps post IDs stable across scroll positions
 * (virtual scrolling changes what's visible, altering innerText of large wrappers).
 */
function stripFacebookUINoise(text) {
  return text
    // Leading navigation bursts: "Facebook Facebook Facebook ..."
    .replace(/^(\s*Facebook\s*){2,}/i, "")
    // Trailing navigation bursts
    .replace(/(\s*Facebook\s*){2,}$/i, "")
    // Inline UI chrome: Like · Reply · Share buttons and notification counts
    .replace(/\b(Like|Reply|Share|Comment|Voir plus|See more|J'aime|Commenter|Partager)\b[\s·•\d]*/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function isLikelyWrapperContainer(article, rawText, searchResultsMode) {
  const textLength = String(rawText || "").length;
  if (textLength < WRAPPER_REVIEW_TEXT_LENGTH) {
    return false;
  }

  const descendantArticles = article.querySelectorAll("div[role='article']").length;
  const feedUnits = article.querySelectorAll("div[data-pagelet^='FeedUnit_']").length;
  const postLinks = article.querySelectorAll(POST_LINK_SELECTOR).length;
  const authorLinks = article.querySelectorAll("h2 a[role='link'], h3 a[role='link']").length;
  const feedContainers = article.querySelectorAll("[role='feed']").length;

  if (descendantArticles > 0 || feedUnits > 0 || feedContainers > 0) {
    return true;
  }

  if (!searchResultsMode && (postLinks >= 3 || authorLinks >= 3)) {
    return true;
  }

  return textLength >= HARD_WRAPPER_TEXT_LENGTH && (postLinks >= 2 || authorLinks >= 2);
}

function extractPostFromArticle(article) {
  const rawText = cleanText(article.innerText || article.textContent || "");
  const currentPageUrl = window.location.href;
  const searchQuery = getSearchQueryFromUrl(currentPageUrl);
  const searchResultsMode = Boolean(searchQuery);

  if (isLikelyWrapperContainer(article, rawText, searchResultsMode)) {
    extractionDebug.dropped_short_text += 1; // reuse counter — close enough
    return null;
  }

  // Strip Facebook navigation noise before any processing so the post ID
  // is stable regardless of what page elements are visible at scroll time.
  const text = stripFacebookUINoise(rawText);

  if (text.length < MIN_POST_LENGTH) {
    extractionDebug.dropped_short_text += 1;
    return null;
  }

  const keywordGate = evaluateKeywordGate(text, runtimeDetectionConfig);
  if (!keywordGate.pass && !searchResultsMode) {
    extractionDebug.dropped_keyword_gate += 1;
    return null;
  }

  const author = extractAuthor(article);
  const {
    timestamp,
    post_url: postUrl,
    canonical_post_locator: canonicalPostLocator,
  } = extractTimestampAndUrl(article);
  const groupUrl = currentPageUrl;
  const postId = buildPostId({
    text,
    author,
    postUrl,
    canonicalPostLocator
  });

  if (!postId || processedPostIds.has(postId)) {
    extractionDebug.dropped_duplicate_or_invalid += 1;
    return null;
  }

  const engagement = extractEngagementCounts(article);
  const matchedKeywordsLocal = uniqueItems([
    ...keywordGate.matched_keywords,
    ...(searchQuery ? [searchQuery] : [])
  ]);
  const keywordGateOverride = !keywordGate.pass && searchResultsMode ? "search_results" : "";

  const post = {
    id: postId,
    text,
    author,
    post_url: postUrl,
    group_name: resolveGroupName(),
    group_url: groupUrl,
    timestamp: timestamp || new Date().toISOString(),
    reactions_count: engagement.reactions_count,
    comments_count: engagement.comments_count,
    shares_count: engagement.shares_count,
    source_page_url: currentPageUrl,
    search_query: searchQuery,
    keywords_matched_local: matchedKeywordsLocal,
    keyword_gate_passed: keywordGate.pass || searchResultsMode,
    keyword_gate_pass_reason: String(keywordGate.pass_reason || "none"),
    keyword_gate_override: keywordGateOverride,
    keyword_gate_anchor_hits: keywordGate.anchor_hits,
    keyword_gate_strong_hits: keywordGate.strong_generic_hits,
    keyword_gate_weak_hits: keywordGate.weak_generic_hits
  };

  processedPostIds.add(postId);
  extractionDebug.accepted_posts += 1;
  return post;
}

// POST_LINK_SELECTOR — covers the many URL formats Facebook uses for post links.
// Facebook search results often use ?fbid= or ?id= instead of /posts/ paths.
const POST_LINK_SELECTOR = [
  "a[href*='/posts/']",
  "a[href*='/permalink/']",
  "a[href*='story_fbid']",
  "a[href*='fbid=']",
  "a[href*='fb_id=']",
  "a[href*='?v=']",
  "a[href*='&v=']"
].join(", ");

// Minimum text length for a container to be considered a post card on search pages.
const SEARCH_CARD_MIN_TEXT = 60;

// Aria-label patterns that identify Facebook engagement buttons (Like/Comment/Share).
const ENGAGEMENT_ARIA_RE = /like|j'aime|aime|comment|share|partag|react|mention|إعجاب|تعليق|مشاركة/i;

/**
 * Given an anchor element that points to a post, walk up the DOM to find the
 * outermost container that is still a single "post card" — i.e., the element
 * right before the feed/list container that holds all cards.
 */
function findPostCardContainer(link) {
  const STOP_ROLES = new Set(["feed", "main", "navigation", "banner", "contentinfo", "complementary"]);
  const STOP_TAGS = new Set(["BODY", "HTML", "MAIN", "HEADER", "FOOTER", "NAV"]);

  let best = null;
  let el = link.parentElement;

  for (let depth = 0; depth < 40 && el; depth += 1) {
    if (STOP_TAGS.has(el.tagName)) break;
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (STOP_ROLES.has(role)) break;

    const text = cleanText(el.innerText || el.textContent || "");
    if (text.length >= SEARCH_CARD_MIN_TEXT) {
      // Stop before absorbing multiple cards: tighter 1.8x multiplier so we
      // don't climb into a 2-card wrapper when only 2 posts are on screen.
      if (best) {
        const parentText = cleanText((el.parentElement && (el.parentElement.innerText || el.parentElement.textContent)) || "");
        const parentRole = el.parentElement ? (el.parentElement.getAttribute("role") || "").toLowerCase() : "";
        if (STOP_ROLES.has(parentRole) || parentText.length > text.length * 1.8) {
          break; // parent is a multi-card container — stop here
        }
      }
      best = el;
    }

    el = el.parentElement;
  }

  return best;
}

function collectArticleNodes(root) {
  const nodes = [];
  const isSearchPage = Boolean(getSearchQueryFromUrl());

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

  // Standard fallback — covers normal group feed.
  if (!nodes.length) {
    nodes.push(...document.querySelectorAll("div[data-pagelet^='FeedUnit_'], div[role='article']"));
  }

  // ── Search-page fallback ──────────────────────────────────────────────────
  // Facebook group search results (/groups/ID/search/?q=...) do NOT use
  // div[role='article'] or FeedUnit_ pagelets. We use three escalating strategies.
  if (isSearchPage && !nodes.length) {
    // Strategy 1: direct children of any feed container that contain a post link.
    const feedContainers = document.querySelectorAll("[role='feed']");
    for (const feed of feedContainers) {
      for (const child of feed.children) {
        if (!(child instanceof Element)) continue;
        const text = cleanText(child.innerText || child.textContent || "");
        if (text.length < SEARCH_CARD_MIN_TEXT) continue;
        if (child.querySelector(POST_LINK_SELECTOR)) {
          nodes.push(child);
        }
      }
    }
  }

  if (isSearchPage && !nodes.length) {
    // Strategy 2: look for any pagelet containers other than FeedUnit_.
    const pagelets = document.querySelectorAll("div[data-pagelet]");
    for (const pagelet of pagelets) {
      if (!pagelet.querySelector(POST_LINK_SELECTOR)) continue;
      const text = cleanText(pagelet.innerText || pagelet.textContent || "");
      if (text.length < SEARCH_CARD_MIN_TEXT) continue;
      // Only use direct children that look like cards, not the full pagelet.
      for (const child of pagelet.children) {
        if (!(child instanceof Element)) continue;
        const childText = cleanText(child.innerText || child.textContent || "");
        if (childText.length >= SEARCH_CARD_MIN_TEXT && child.querySelector(POST_LINK_SELECTOR)) {
          nodes.push(child);
        }
      }
    }
  }

  if (isSearchPage && !nodes.length) {
    // Strategy 3 (broadest): walk up from every visible post link to find its card container.
    const postLinks = document.querySelectorAll(POST_LINK_SELECTOR);
    for (const link of postLinks) {
      if (!(link instanceof Element)) continue;
      const card = findPostCardContainer(link);
      if (card) nodes.push(card);
    }
  }

  if (isSearchPage && !nodes.length) {
    // Strategy 4: anchor on engagement buttons (Like/Comment/Share) that have aria-labels.
    // Facebook always renders these on every post card regardless of DOM structure.
    const engagementBtns = document.querySelectorAll("[role='button'][aria-label]");
    for (const btn of engagementBtns) {
      if (!(btn instanceof Element)) continue;
      const label = btn.getAttribute("aria-label") || "";
      if (!ENGAGEMENT_ARIA_RE.test(label)) continue;
      const card = findPostCardContainer(btn);
      if (!card) continue;
      const text = cleanText(card.innerText || card.textContent || "");
      if (text.length >= SEARCH_CARD_MIN_TEXT) nodes.push(card);
    }
  }

  if (isSearchPage && !nodes.length) {
    // Strategy 5 (nuclear): find ANY div that has 2+ role=button descendants and enough text.
    // No selector assumptions — purely structural. Grabs the smallest such container.
    const allButtons = Array.from(document.querySelectorAll("[role='button']"));
    // Group buttons by their nearest substantial ancestor.
    for (const btn of allButtons) {
      if (!(btn instanceof Element)) continue;
      const card = findPostCardContainer(btn);
      if (!card) continue;
      const btnsInCard = card.querySelectorAll("[role='button']").length;
      if (btnsInCard < 2) continue;
      const text = cleanText(card.innerText || card.textContent || "");
      if (text.length >= SEARCH_CARD_MIN_TEXT) nodes.push(card);
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  const uniqueNodes = [];
  const seen = new Set();
  for (const node of nodes) {
    if (!node || seen.has(node)) {
      continue;
    }
    // Skip nodes that are ancestors/descendants of already-seen nodes (dedup nested).
    let dominated = false;
    for (const existing of uniqueNodes) {
      if (existing.contains(node) || node.contains(existing)) {
        dominated = true;
        break;
      }
    }
    if (dominated) continue;
    seen.add(node);
    uniqueNodes.push(node);
  }

  return uniqueNodes;
}

function extractPostsFromPage(root = document.body) {
  const posts = [];
  const seenIds = new Set();
  const articleNodes = collectArticleNodes(root);
  extractionDebug.article_nodes_seen += articleNodes.length;

  for (const article of articleNodes) {
    const articleIndex = extractionDebug.article_nodes_processed + 1;
    const rawText = cleanText(article && (article.innerText || article.textContent || ""));
    const preview = rawText.slice(0, 220);
    const beforeShort = extractionDebug.dropped_short_text;
    const beforeKeyword = extractionDebug.dropped_keyword_gate;
    const beforeDup = extractionDebug.dropped_duplicate_or_invalid;

    extractionDebug.article_nodes_processed += 1;
    const post = extractPostFromArticle(article);

    if (!post) {
      let reason = "dropped_unknown";
      if (extractionDebug.dropped_short_text > beforeShort) {
        reason = "dropped_short_text";
      } else if (extractionDebug.dropped_keyword_gate > beforeKeyword) {
        reason = "dropped_keyword_gate";
      } else if (extractionDebug.dropped_duplicate_or_invalid > beforeDup) {
        reason = "dropped_duplicate_or_invalid";
      }

      pushScannedPostDebug({
        index: articleIndex,
        reason,
        text_length: rawText.length,
        text_preview: preview,
        post_id: null,
        author: ""
      });
      continue;
    }

    if (seenIds.has(post.id)) {
      extractionDebug.dropped_duplicate_or_invalid += 1;
      pushScannedPostDebug({
        index: articleIndex,
        reason: "dropped_duplicate_in_batch",
        text_length: rawText.length,
        text_preview: preview,
        post_id: post.id,
        author: post.author || ""
      });
      continue;
    }

    seenIds.add(post.id);
    posts.push(post);

    pushScannedPostDebug({
      index: articleIndex,
      reason: post.keyword_gate_override
        ? "accepted_search_override"
        : post.keyword_gate_pass_reason === "single_keyword_hit"
          ? "accepted_relaxed_keyword_hit"
          : "accepted",
      text_length: rawText.length,
      text_preview: preview,
      post_id: post.id,
      author: post.author || ""
    });
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

function isElementScrollable(element) {
  if (!(element instanceof Element)) {
    return false;
  }

  const style = window.getComputedStyle(element);
  const overflowY = String(style.overflowY || "").toLowerCase();
  const canScrollByStyle = overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
  return canScrollByStyle && element.scrollHeight > element.clientHeight + 24;
}

function findActiveScrollContainer() {
  const candidates = [];
  const scrollingElement = document.scrollingElement || document.documentElement || document.body;
  if (scrollingElement) {
    candidates.push(scrollingElement);
  }

  const feed = document.querySelector("[role='feed']");
  if (feed instanceof Element) {
    let current = feed;
    for (let depth = 0; depth < 8 && current; depth += 1) {
      candidates.unshift(current);
      current = current.parentElement;
    }
  }

  const main = document.querySelector("[role='main']");
  if (main instanceof Element) {
    candidates.push(main);
  }

  for (const candidate of candidates) {
    if (candidate === document.body || candidate === document.documentElement || candidate === document.scrollingElement) {
      continue;
    }
    if (isElementScrollable(candidate)) {
      return candidate;
    }
  }

  return scrollingElement;
}

function getScrollMetrics(target = findActiveScrollContainer()) {
  const element = target || document.scrollingElement || document.documentElement || document.body;
  const isRootScroller =
    element === window ||
    element === document.body ||
    element === document.documentElement ||
    element === document.scrollingElement;

  if (isRootScroller) {
    const root = document.scrollingElement || document.documentElement || document.body;
    return {
      target: root,
      top: Math.max(0, Math.round(window.scrollY || root.scrollTop || 0)),
      height: Math.max(root.scrollHeight || 0, document.body ? document.body.scrollHeight : 0, window.innerHeight || 0),
      viewport: Math.max(window.innerHeight || 0, document.documentElement ? document.documentElement.clientHeight : 0),
    };
  }

  return {
    target: element,
    top: Math.max(0, Math.round(element.scrollTop || 0)),
    height: Math.max(0, element.scrollHeight || 0),
    viewport: Math.max(0, element.clientHeight || 0),
  };
}

function performScrollStep(target, scrollStep) {
  const element = target || findActiveScrollContainer();
  const isRootScroller =
    element === window ||
    element === document.body ||
    element === document.documentElement ||
    element === document.scrollingElement;

  if (isRootScroller) {
    const root = document.scrollingElement || document.documentElement || document.body;
    const nextTop = Math.max(0, (window.scrollY || root.scrollTop || 0) + scrollStep);
    window.scrollTo({ top: nextTop, left: 0, behavior: "auto" });
    root.scrollTop = nextTop;
    if (document.body && document.body !== root) {
      document.body.scrollTop = nextTop;
    }
    return;
  }

  element.scrollTop = Math.max(0, Number(element.scrollTop || 0) + scrollStep);
}

function getScrollHeight() {
  return getScrollMetrics().height;
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
  const scrollTarget = findActiveScrollContainer();
  const beforeMetrics = getScrollMetrics(scrollTarget);
  const scrollStep = randomInt(config.step_min_px, config.step_max_px);

  performScrollStep(scrollTarget, scrollStep);
  await delay(config.interval_ms);

  const discoveredPosts = extractPostsFromPage(document.body);
  if (discoveredPosts.length) {
    autoScrollState.newPosts += discoveredPosts.length;
    queuePosts(discoveredPosts);
  }

  const afterMetrics = getScrollMetrics(scrollTarget);
  const atBottom = afterMetrics.top + afterMetrics.viewport >= afterMetrics.height - 8;
  const progressed =
    discoveredPosts.length > 0 ||
    afterMetrics.height > beforeMetrics.height ||
    afterMetrics.top > beforeMetrics.top;

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
    updateRuntimeDetectionConfig(config);
    applyAutoScan(config.auto_scan !== false);
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.config) {
    return;
  }

  const newConfig = changes.config.newValue || {};
  updateRuntimeDetectionConfig(newConfig);
  applyAutoScan(newConfig.auto_scan !== false);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) {
    return false;
  }

  if (message.action === "manual_scan") {
    // Reload config first so runtimeDetectionConfig is current even on a
    // freshly-injected content script (loadAutoScanSetting may not have
    // fired yet because it is async).
    chrome.storage.local.get(["config"], (storageData) => {
      const cfg = storageData.config || {};
      updateRuntimeDetectionConfig(cfg);
      resetExtractionDebug();
      const posts = extractPostsFromPage(document.body);
      if (posts.length) {
        queuePosts(posts);
      }
      sendResponse({
        count: posts.length,
        debug: getExtractionDebugSnapshot(),
        page_url: window.location.href
      });
    });
    return true; // keep message channel open for async sendResponse
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
