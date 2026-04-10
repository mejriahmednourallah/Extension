const state = {
  alerts: [],
  unread_count: 0,
  config: {
    client_name: "Banque biat",
    keywords: [
      "banque", "bank", "banque tunisie", "banque tunisienne",
      "service client banque", "agence bancaire", "carte bancaire",
      "compte bancaire", "credit bancaire", "pret bancaire", "virement",
      "frais bancaires", "application bancaire", "rib", "iban", "atm",
      "guichet automatique", "بنك", "البنك", "بنوك", "مصرف", "المصرف",
      "خدمة بنكية", "وكالة بنكية", "بطاقة بنكية", "حساب بنكي",
      "قرض", "تحويل بنكي", "خدمة الحرفاء"
    ],
    alert_email: "client@banque.tn",
    auto_scan: true,
    keyword_tiers: {},
    keyword_gate: {
      min_anchor_hits: 1,
      min_strong_generic_hits: 2,
      min_combo_strong_hits: 1,
      min_combo_weak_hits: 1
    },
    backend_url: "http://localhost:8000",
    groq_api_key: "",
    gemini_api_key: ""
  },
  last_scan: null,
  daily_metrics: null,
  groups: [],
  keywords_editor: [],
  keyword_gate_editor: {
    min_anchor_hits: 1,
    min_strong_generic_hits: 2,
    min_combo_strong_hits: 1,
    min_combo_weak_hits: 1
  },
  auto_scroll_status: null,
  activeTab: "alerts",
  activeFilter: "all"
};

let autoScrollStatusPollId = null;
let autoScrollStatusPollInFlight = false;

const AUTO_SCROLL_POLL_INTERVALS_MS = {
  running: 1500,
  idle: 4000,
  hidden: 10000,
  error: 5000
};

const SENTIMENT_LABELS = {
  very_negative: "Tres negatif",
  negative: "Negatif",
  neutral: "Neutre",
  positive: "Positif"
};

const KEYWORD_TIER_OPTIONS = {
  anchor: "Brand",
  strong: "Strong generic",
  weak: "Weak generic"
};

function sendMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response || {});
    });
  });
}

function setFeedback(message, isError = false) {
  const feedback = document.getElementById("feedbackText");
  feedback.textContent = message || "";
  feedback.style.color = isError ? "#ef4444" : "#94a3b8";
}

function relativeTime(isoDate) {
  if (!isoDate) return "unknown";
  const deltaMs = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(deltaMs / 60000);
  if (Number.isNaN(mins) || mins < 0) return "unknown";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeKeywordTerm(value) {
  return String(value || "")
    .replace(/[\u00A0\s]+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeTierValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "brand" || normalized === "anchor") return "anchor";
  if (normalized === "strong" || normalized === "strong_generic" || normalized === "domain") return "strong";
  if (normalized === "weak" || normalized === "weak_generic" || normalized === "generic") return "weak";
  return "weak";
}

function inferDefaultTier(term, clientName) {
  const normalizedTerm = normalizeKeywordTerm(term);
  const normalizedClient = normalizeKeywordTerm(clientName);
  if (!normalizedTerm) {
    return "weak";
  }

  if (normalizedClient && (
    normalizedTerm === normalizedClient ||
    normalizedTerm.startsWith(`${normalizedClient} `) ||
    normalizedTerm.endsWith(` ${normalizedClient}`) ||
    normalizedTerm.includes(` ${normalizedClient} `)
  )) {
    return "anchor";
  }

  const tokenCount = normalizedTerm.split(" ").filter(Boolean).length;
  return tokenCount > 1 ? "strong" : "weak";
}

function syncKeywordsEditorFromConfig() {
  const cfg = state.config || {};
  const terms = Array.isArray(cfg.keywords) ? cfg.keywords : [];
  const tiers = cfg.keyword_tiers && typeof cfg.keyword_tiers === "object" ? cfg.keyword_tiers : {};

  const seen = new Set();
  const editor = [];
  for (const rawTerm of terms) {
    const term = String(rawTerm || "").trim();
    const key = normalizeKeywordTerm(term);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);

    editor.push({
      term,
      tier: normalizeTierValue(tiers[key] || inferDefaultTier(term, cfg.client_name || ""))
    });
  }

  state.keywords_editor = editor;
  state.keyword_gate_editor = {
    min_anchor_hits: Math.max(1, Number((cfg.keyword_gate || {}).min_anchor_hits || 1)),
    min_strong_generic_hits: Math.max(1, Number((cfg.keyword_gate || {}).min_strong_generic_hits || 2)),
    min_combo_strong_hits: Math.max(1, Number((cfg.keyword_gate || {}).min_combo_strong_hits || 1)),
    min_combo_weak_hits: Math.max(1, Number((cfg.keyword_gate || {}).min_combo_weak_hits || 1))
  };
}

function getSeverityClass(sentiment) {
  const map = {
    very_negative: "severity-very-negative",
    negative: "severity-negative",
    positive: "severity-positive"
  };
  return map[sentiment] || "severity-neutral";
}

function getCardSentimentClass(sentiment) {
  const map = {
    very_negative: "sent-very-negative",
    negative: "sent-negative",
    positive: "sent-positive",
    neutral: "sent-neutral"
  };
  return map[sentiment] || "sent-neutral";
}

function passesFilter(alert) {
  if (state.activeFilter === "all") return true;
  return String(alert.sentiment || "neutral") === state.activeFilter;
}

function updateHeader() {
  document.getElementById("clientName").textContent =
    state.config.client_name || "Client non configure";

  const active = state.config.auto_scan !== false;
  document.getElementById("statusDot").className =
    `status-dot ${active ? "status-active" : "status-inactive"}`;
  document.getElementById("statusText").textContent = active ? "Actif" : "Inactif";
}

function renderAlerts(scrollToTop = false) {
  const alertsList = document.getElementById("alertsList");
  const emptyState = document.getElementById("emptyState");

  const items = state.alerts.filter(passesFilter);
  alertsList.innerHTML = "";

  if (!items.length) {
    emptyState.classList.remove("hidden");
    return;
  }

  emptyState.classList.add("hidden");

  for (const alert of items) {
    const card = document.createElement("article");
    card.className = `alert-card ${getCardSentimentClass(alert.sentiment)}`;

    const label = SENTIMENT_LABELS[alert.sentiment] || "Neutre";
    const suggestions = Array.isArray(alert.bad_buzz_suggestions)
      ? alert.bad_buzz_suggestions
      : [];
    const suggestionItems = suggestions
      .slice(0, 3)
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join("");

    card.innerHTML = `
      <div class="alert-top">
        <span class="severity-badge ${getSeverityClass(alert.sentiment)}">${escapeHtml(label)}</span>
        <span class="alert-score">${Number(alert.score || 0).toFixed(2)}</span>
      </div>
      <p class="alert-text">${escapeHtml(alert.text || "")}</p>
      <p class="alert-meta">${escapeHtml(alert.author || "Unknown")} · ${escapeHtml(alert.group_name || "Group")} · ${relativeTime(alert.timestamp)}</p>
      <div class="alert-actions">
        <button class="text-button" data-action="open" data-id="${escapeHtml(alert.id)}" type="button">Voir le post</button>
        <button
          class="mark-read-button"
          data-action="read"
          data-id="${escapeHtml(alert.id)}"
          type="button"
          ${alert.read ? "disabled" : ""}
        >${alert.read ? "Lu" : "Marquer lu"}</button>
      </div>
      <details class="suggestions">
        <summary>Reponses suggerees</summary>
        <ol>${suggestionItems || "<li>Aucune suggestion disponible.</li>"}</ol>
      </details>
    `;

    alertsList.appendChild(card);
  }

  if (scrollToTop) {
    alertsList.scrollTop = 0;
  }
}

function setBar(id, ratio) {
  const target = document.getElementById(id);
  if (target) {
    target.style.width = `${Math.max(0, Math.min(100, Math.round(ratio * 100)))}%`;
  }
}

function renderStats() {
  const counts = { very_negative: 0, negative: 0, neutral: 0, positive: 0 };
  let total = 0;

  const metric = state.daily_metrics && typeof state.daily_metrics === "object"
    ? state.daily_metrics
    : null;

  if (metric) {
    total = Math.max(0, Number(metric.total_posts || 0));
    counts.very_negative = Math.max(0, Number(metric.very_negative || 0));
    counts.negative = Math.max(0, Number(metric.negative || 0));
    counts.neutral = Math.max(0, Number(metric.neutral || 0));
    counts.positive = Math.max(0, Number(metric.positive || 0));
  } else {
    const now = new Date();
    const isToday = (iso) => {
      const d = new Date(iso);
      return (
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate()
      );
    };

    const todayAlerts = state.alerts.filter((item) => isToday(item.timestamp));
    for (const alert of todayAlerts) {
      const s = String(alert.sentiment || "neutral");
      if (Object.prototype.hasOwnProperty.call(counts, s)) counts[s] += 1;
    }
    total = todayAlerts.length;
  }

  document.getElementById("totalToday").textContent = String(total);
  document.getElementById("countVeryNegative").textContent = String(counts.very_negative);
  document.getElementById("countNegative").textContent = String(counts.negative);
  document.getElementById("countNeutral").textContent = String(counts.neutral);
  document.getElementById("countPositive").textContent = String(counts.positive);

  const safeTotal = total || 1;
  setBar("barVeryNegative", counts.very_negative / safeTotal);
  setBar("barNegative", counts.negative / safeTotal);
  setBar("barNeutral", counts.neutral / safeTotal);
  setBar("barPositive", counts.positive / safeTotal);

  document.getElementById("lastScanText").textContent = state.last_scan
    ? new Date(state.last_scan).toLocaleString()
    : "Never";
}

function renderAutoScrollStatus(status) {
  const textNode = document.getElementById("autoScrollStatusText");
  const startButton = document.getElementById("autoScrollStartButton");
  const stopButton = document.getElementById("autoScrollStopButton");

  if (!textNode || !startButton || !stopButton) {
    return;
  }

  if (!status) {
    textNode.textContent = "Inconnu";
    startButton.disabled = false;
    stopButton.disabled = true;
    return;
  }

  const running = Boolean(status.running);
  const steps = Number(status.steps || 0);
  const newPosts = Number(status.new_posts || 0);
  const reason = String(status.last_reason || "stopped").replace(/_/g, " ");

  textNode.textContent = running
    ? `Actif (${steps} steps, ${newPosts} posts)`
    : `Inactif (${reason})`;

  startButton.disabled = running;
  stopButton.disabled = !running;
}

function resolveGroupName(group, fallbackIndex) {
  const directName = String(group && (group.group_name || group.name || "")).trim();
  if (directName) {
    return directName;
  }

  const rawUrl = String(group && (group.group_url || group.url || "")).trim();
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      const match = parsed.pathname.match(/\/groups\/([^/?#]+)/i);
      if (match && match[1]) {
        return `Groupe ${match[1]}`;
      }
      return parsed.hostname;
    } catch (_) {
      return rawUrl;
    }
  }

  return `Groupe ${fallbackIndex + 1}`;
}

function renderRelevantGroups() {
  const listNode = document.getElementById("relevantGroupsList");
  const emptyNode = document.getElementById("relevantGroupsEmpty");
  const countNode = document.getElementById("relevantGroupsCount");
  if (!listNode || !emptyNode || !countNode) {
    return;
  }

  const groups = Array.isArray(state.groups) ? state.groups : [];
  const relevantGroups = groups.filter((group) => {
    if (!group || group.enabled === false) {
      return false;
    }
    const url = String(group.group_url || group.url || "").trim();
    return Boolean(url);
  });

  countNode.textContent = String(relevantGroups.length);
  listNode.innerHTML = "";

  if (!relevantGroups.length) {
    emptyNode.classList.remove("hidden");
    return;
  }

  emptyNode.classList.add("hidden");
  relevantGroups.forEach((group, index) => {
    const name = resolveGroupName(group, index);
    const url = String(group.group_url || group.url || "").trim();

    const row = document.createElement("article");
    row.className = "group-row";
    row.innerHTML = `
      <div>
        <p class="group-name">${escapeHtml(name)}</p>
        <p class="group-url" title="${escapeHtml(url)}">${escapeHtml(url)}</p>
      </div>
      <button class="text-button group-open-button" data-action="open-group" data-url="${escapeHtml(url)}" type="button">Ouvrir</button>
    `;

    listNode.appendChild(row);
  });
}

function renderKeywordsPage() {
  const listNode = document.getElementById("keywordsList");
  const emptyNode = document.getElementById("keywordsEmpty");
  if (!listNode || !emptyNode) {
    return;
  }

  listNode.innerHTML = "";
  const items = Array.isArray(state.keywords_editor) ? state.keywords_editor : [];

  if (!items.length) {
    emptyNode.classList.remove("hidden");
  } else {
    emptyNode.classList.add("hidden");
  }

  items.forEach((item, index) => {
    const row = document.createElement("article");
    row.className = "keywords-row";
    row.innerHTML = `
      <p class="keyword-term" title="${escapeHtml(item.term)}">${escapeHtml(item.term)}</p>
      <select data-action="tier" data-index="${index}">
        <option value="anchor" ${item.tier === "anchor" ? "selected" : ""}>${KEYWORD_TIER_OPTIONS.anchor}</option>
        <option value="strong" ${item.tier === "strong" ? "selected" : ""}>${KEYWORD_TIER_OPTIONS.strong}</option>
        <option value="weak" ${item.tier === "weak" ? "selected" : ""}>${KEYWORD_TIER_OPTIONS.weak}</option>
      </select>
      <button class="text-button keyword-remove-button" data-action="remove-keyword" data-index="${index}" type="button">Supprimer</button>
    `;
    listNode.appendChild(row);
  });

  const gateValues = state.keyword_gate_editor || {};
  const anchorInput = document.getElementById("gateMinAnchorInput");
  const strongInput = document.getElementById("gateMinStrongInput");
  const comboStrongInput = document.getElementById("gateMinComboStrongInput");
  const comboWeakInput = document.getElementById("gateMinComboWeakInput");

  if (anchorInput) anchorInput.value = String(gateValues.min_anchor_hits || 1);
  if (strongInput) strongInput.value = String(gateValues.min_strong_generic_hits || 2);
  if (comboStrongInput) comboStrongInput.value = String(gateValues.min_combo_strong_hits || 1);
  if (comboWeakInput) comboWeakInput.value = String(gateValues.min_combo_weak_hits || 1);
}

function renderConfig() {
  document.getElementById("clientNameInput").value = state.config.client_name || "";
  document.getElementById("alertEmailInput").value = state.config.alert_email || "";
  document.getElementById("autoScanInput").checked = state.config.auto_scan !== false;
  document.getElementById("groqKeyInput").value = state.config.groq_api_key || "";
  document.getElementById("geminiKeyInput").value = state.config.gemini_api_key || "";
  document.getElementById("backendUrlInput").value =
    state.config.backend_url || "http://localhost:8000";
}

function renderAll(scrollToTop = false) {
  updateHeader();
  renderAlerts(scrollToTop);
  renderConfig();
  renderKeywordsPage();
  renderStats();
  renderRelevantGroups();
  renderAutoScrollStatus(state.auto_scroll_status);
}

async function refreshState(scrollToTop = false) {
  const response = await sendMessage({ action: "get_state" });
  state.alerts = Array.isArray(response.alerts) ? response.alerts : [];
  state.unread_count = Number(response.unread_count || 0);
  state.config = response.config || state.config;
  syncKeywordsEditorFromConfig();
  state.last_scan = response.last_scan || null;
  state.daily_metrics = response.daily_metrics || null;
  state.groups = Array.isArray(response.groups) ? response.groups : [];
  renderAll(scrollToTop);
}

async function refreshAutoScrollStatus() {
  try {
    const response = await sendMessage({ action: "auto_scroll_status" });
    if (response.ok === false) {
      state.auto_scroll_status = null;
    } else {
      state.auto_scroll_status = response.status || null;
    }
  } catch (error) {
    state.auto_scroll_status = null;
  }

  renderAutoScrollStatus(state.auto_scroll_status);
}

function setupTabs() {
  const tabButtons = document.querySelectorAll(".tab-button");
  const panels = {
    alerts: document.getElementById("tab-alerts"),
    config: document.getElementById("tab-config"),
    keywords: document.getElementById("tab-keywords"),
    stats: document.getElementById("tab-stats")
  };

  for (const button of tabButtons) {
    button.addEventListener("click", () => {
      state.activeTab = button.dataset.tab;
      tabButtons.forEach((item) => item.classList.remove("active"));
      button.classList.add("active");

      Object.entries(panels).forEach(([name, panel]) => {
        panel.classList.toggle("active", name === state.activeTab);
      });

      // Scroll to top of alerts when switching to the tab.
      if (state.activeTab === "alerts") {
        const list = document.getElementById("alertsList");
        if (list) list.scrollTop = 0;
      }
    });
  }
}

function setupFilters() {
  const filterButtons = document.querySelectorAll(".filter-button");
  for (const button of filterButtons) {
    button.addEventListener("click", () => {
      state.activeFilter = button.dataset.filter;
      filterButtons.forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      renderAlerts(true);
    });
  }
}

function setupScrollTop() {
  const list = document.getElementById("alertsList");
  const btn = document.getElementById("scrollTopBtn");
  if (!list || !btn) return;

  list.addEventListener("scroll", () => {
    btn.classList.toggle("visible", list.scrollTop > 80);
  }, { passive: true });

  btn.addEventListener("click", () => {
    list.scrollTop = 0;
  });
}

function setupClearButton() {
  const btn = document.getElementById("clearAlertsBtn");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    if (!window.confirm("Effacer toutes les alertes ?")) return;

    try {
      const response = await sendMessage({ action: "clear_alerts" });
      if (!response.ok) throw new Error(response.error || "Could not clear alerts");
      await refreshState();
      setFeedback("Alertes effacees.");
    } catch (error) {
      setFeedback(String(error), true);
    }
  });
}

function setupAlertsActions() {
  const alertsList = document.getElementById("alertsList");

  alertsList.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;

    const alertId = button.dataset.id;
    const alertItem = state.alerts.find((item) => item.id === alertId);
    if (!alertItem) return;

    try {
      if (button.dataset.action === "open") {
        await sendMessage({ action: "open_post", url: alertItem.post_url });
        return;
      }
      if (button.dataset.action === "read") {
        await sendMessage({ action: "mark_alert_read", id: alertItem.id });
        await refreshState();
      }
    } catch (error) {
      setFeedback(String(error), true);
    }
  });
}

function setupConfigForm() {
  document.getElementById("configForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    const configPayload = {
      client_name: document.getElementById("clientNameInput").value.trim(),
      alert_email: document.getElementById("alertEmailInput").value.trim(),
      auto_scan: document.getElementById("autoScanInput").checked,
      groq_api_key: document.getElementById("groqKeyInput").value.trim(),
      gemini_api_key: document.getElementById("geminiKeyInput").value.trim(),
      backend_url:
        document.getElementById("backendUrlInput").value.trim() || "http://localhost:8000"
    };

    try {
      const response = await sendMessage({ action: "save_config", config: configPayload });
      if (!response.ok) throw new Error(response.error || "Could not save config");
      state.config = response.config;
      syncKeywordsEditorFromConfig();
      renderAll();
      setFeedback("Configuration saved.");
    } catch (error) {
      setFeedback(String(error), true);
    }
  });
}

function setupKeywordsPageActions() {
  const newInput = document.getElementById("keywordNewInput");
  const newTier = document.getElementById("keywordNewTier");
  const addButton = document.getElementById("keywordAddButton");
  const listNode = document.getElementById("keywordsList");
  const saveButton = document.getElementById("saveKeywordsButton");

  if (!newInput || !newTier || !addButton || !listNode || !saveButton) {
    return;
  }

  addButton.addEventListener("click", () => {
    const term = String(newInput.value || "").replace(/[\u00A0\s]+/g, " ").trim();
    if (!term) {
      return;
    }

    const normalized = normalizeKeywordTerm(term);
    const exists = state.keywords_editor.some((item) => normalizeKeywordTerm(item.term) === normalized);
    if (exists) {
      setFeedback("Ce mot-cle existe deja.", true);
      return;
    }

    state.keywords_editor.push({
      term,
      tier: normalizeTierValue(newTier.value)
    });

    state.keywords_editor.sort((a, b) => a.term.localeCompare(b.term, "fr", { sensitivity: "base" }));
    newInput.value = "";
    renderKeywordsPage();
  });

  newInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addButton.click();
    }
  });

  listNode.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) || target.dataset.action !== "tier") {
      return;
    }

    const index = Number(target.dataset.index || -1);
    if (!Number.isInteger(index) || index < 0 || index >= state.keywords_editor.length) {
      return;
    }

    state.keywords_editor[index].tier = normalizeTierValue(target.value);
  });

  listNode.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action='remove-keyword']");
    if (!button) {
      return;
    }

    const index = Number(button.dataset.index || -1);
    if (!Number.isInteger(index) || index < 0 || index >= state.keywords_editor.length) {
      return;
    }

    state.keywords_editor.splice(index, 1);
    renderKeywordsPage();
  });

  saveButton.addEventListener("click", async () => {
    const anchorInput = document.getElementById("gateMinAnchorInput");
    const strongInput = document.getElementById("gateMinStrongInput");
    const comboStrongInput = document.getElementById("gateMinComboStrongInput");
    const comboWeakInput = document.getElementById("gateMinComboWeakInput");

    state.keyword_gate_editor = {
      min_anchor_hits: Math.max(1, Number(anchorInput && anchorInput.value || 1)),
      min_strong_generic_hits: Math.max(1, Number(strongInput && strongInput.value || 2)),
      min_combo_strong_hits: Math.max(1, Number(comboStrongInput && comboStrongInput.value || 1)),
      min_combo_weak_hits: Math.max(1, Number(comboWeakInput && comboWeakInput.value || 1))
    };

    const keywords = state.keywords_editor
      .map((item) => String(item.term || "").trim())
      .filter(Boolean);

    const keywordTiers = {};
    for (const item of state.keywords_editor) {
      const key = normalizeKeywordTerm(item.term);
      if (!key) {
        continue;
      }
      keywordTiers[key] = normalizeTierValue(item.tier);
    }

    try {
      const response = await sendMessage({
        action: "save_config",
        config: {
          keywords,
          keyword_tiers: keywordTiers,
          keyword_gate: state.keyword_gate_editor
        }
      });

      if (!response.ok) {
        throw new Error(response.error || "Could not save keywords config");
      }

      state.config = response.config || state.config;
      syncKeywordsEditorFromConfig();
      renderKeywordsPage();
      setFeedback("Keywords config saved.");
    } catch (error) {
      setFeedback(String(error), true);
    }
  });
}

function setupManualScanButton() {
  const button = document.getElementById("manualScanButton");
  button.addEventListener("click", async () => {
    button.disabled = true;
    setFeedback("Manual scan in progress...");

    try {
      const response = await sendMessage({ action: "manual_scan_active_tab" });
      if (!response.ok) throw new Error(response.error || "Manual scan failed");
      const count = Number(response.count || 0);
      setFeedback(`Scan termine — ${count} post(s) extraits.`);
      await refreshState(true);
    } catch (error) {
      setFeedback(String(error), true);
    } finally {
      button.disabled = false;
    }
  });
}

function setupAutoScrollButtons() {
  const startButton = document.getElementById("autoScrollStartButton");
  const stopButton = document.getElementById("autoScrollStopButton");
  if (!startButton || !stopButton) {
    return;
  }

  startButton.addEventListener("click", async () => {
    startButton.disabled = true;
    stopButton.disabled = true;
    setFeedback("Demarrage auto-scroll...");

    try {
      const response = await sendMessage({ action: "auto_scroll_start" });
      if (!response.ok) throw new Error(response.error || "Auto-scroll start failed");
      state.auto_scroll_status = response.status || null;
      renderAutoScrollStatus(state.auto_scroll_status);
      setFeedback("Auto-scroll lance.");
    } catch (error) {
      renderAutoScrollStatus(state.auto_scroll_status);
      setFeedback(String(error), true);
    }
  });

  stopButton.addEventListener("click", async () => {
    startButton.disabled = true;
    stopButton.disabled = true;
    setFeedback("Arret auto-scroll...");

    try {
      const response = await sendMessage({ action: "auto_scroll_stop" });
      if (!response.ok) throw new Error(response.error || "Auto-scroll stop failed");
      state.auto_scroll_status = response.status || null;
      renderAutoScrollStatus(state.auto_scroll_status);
      setFeedback("Auto-scroll arrete.");
    } catch (error) {
      renderAutoScrollStatus(state.auto_scroll_status);
      setFeedback(String(error), true);
    }
  });
}

function setupRelevantGroupsActions() {
  const groupsList = document.getElementById("relevantGroupsList");
  if (!groupsList) {
    return;
  }

  groupsList.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action='open-group']");
    if (!button) {
      return;
    }

    const url = String(button.dataset.url || "").trim();
    if (!url) {
      return;
    }

    try {
      await sendMessage({ action: "open_post", url });
    } catch (error) {
      setFeedback(String(error), true);
    }
  });
}

function setupAutoScrollStatusPolling() {
  if (autoScrollStatusPollId) {
    clearTimeout(autoScrollStatusPollId);
    autoScrollStatusPollId = null;
  }

  const scheduleNextPoll = (delayMs) => {
    if (autoScrollStatusPollId) {
      clearTimeout(autoScrollStatusPollId);
      autoScrollStatusPollId = null;
    }

    autoScrollStatusPollId = setTimeout(() => {
      void pollOnce();
    }, Math.max(400, Number(delayMs) || AUTO_SCROLL_POLL_INTERVALS_MS.idle));
  };

  const pollOnce = async () => {
    if (document.hidden) {
      scheduleNextPoll(AUTO_SCROLL_POLL_INTERVALS_MS.hidden);
      return;
    }

    if (autoScrollStatusPollInFlight) {
      scheduleNextPoll(AUTO_SCROLL_POLL_INTERVALS_MS.running);
      return;
    }

    autoScrollStatusPollInFlight = true;
    try {
      await refreshAutoScrollStatus();
      const running = Boolean(state.auto_scroll_status && state.auto_scroll_status.running);
      scheduleNextPoll(running ? AUTO_SCROLL_POLL_INTERVALS_MS.running : AUTO_SCROLL_POLL_INTERVALS_MS.idle);
    } catch (_) {
      // Ignore polling failures and keep the last visible state.
      scheduleNextPoll(AUTO_SCROLL_POLL_INTERVALS_MS.error);
    } finally {
      autoScrollStatusPollInFlight = false;
    }
  };

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      scheduleNextPoll(AUTO_SCROLL_POLL_INTERVALS_MS.hidden);
      return;
    }

    void pollOnce();
  });

  void pollOnce();

  window.addEventListener("beforeunload", () => {
    if (autoScrollStatusPollId) {
      clearTimeout(autoScrollStatusPollId);
      autoScrollStatusPollId = null;
    }

    autoScrollStatusPollInFlight = false;
  });
}

function setupStorageAutoRefresh() {
  // Auto-refresh the popup when background writes new alerts.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    if (!changes.alerts && !changes.unread_count && !changes.last_scan && !changes.daily_metrics && !changes.groups) return;

    try {
      const prevCount = state.alerts.length;
      await refreshState(false);
      // Scroll to top only when new items have arrived.
      if (state.activeTab === "alerts" && state.alerts.length > prevCount) {
        const list = document.getElementById("alertsList");
        if (list) list.scrollTop = 0;
      }
    } catch (_) {
      // Popup may be closing; ignore.
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  syncKeywordsEditorFromConfig();
  setupTabs();
  setupFilters();
  setupScrollTop();
  setupClearButton();
  setupAlertsActions();
  setupConfigForm();
  setupKeywordsPageActions();
  setupManualScanButton();
  setupAutoScrollButtons();
  setupRelevantGroupsActions();
  setupAutoScrollStatusPolling();
  setupStorageAutoRefresh();

  try {
    await refreshState(true);
    await refreshAutoScrollStatus();
    setFeedback("Ready.");
  } catch (error) {
    setFeedback(String(error), true);
  }
});
