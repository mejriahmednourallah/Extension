const state = {
  alerts: [],
  unread_count: 0,
  config: {
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
  },
  last_scan: null,
  activeTab: "alerts",
  activeFilter: "all"
};

const SENTIMENT_LABELS = {
  very_negative: "Tres negatif",
  negative: "Negatif",
  neutral: "Neutre",
  positive: "Positif"
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
  feedback.style.color = isError ? "#fc8181" : "#a0aec0";
}

function relativeTime(isoDate) {
  if (!isoDate) {
    return "unknown";
  }

  const deltaMs = Date.now() - new Date(isoDate).getTime();
  const deltaMinutes = Math.floor(deltaMs / 60000);

  if (Number.isNaN(deltaMinutes) || deltaMinutes < 0) {
    return "unknown";
  }
  if (deltaMinutes < 1) {
    return "just now";
  }
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}h ago`;
  }

  const deltaDays = Math.floor(deltaHours / 24);
  return `${deltaDays}d ago`;
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getSeverityClass(sentiment) {
  switch (sentiment) {
    case "very_negative":
      return "severity-very-negative";
    case "negative":
      return "severity-negative";
    case "positive":
      return "severity-positive";
    default:
      return "severity-neutral";
  }
}

function passesFilter(alert) {
  if (state.activeFilter === "all") {
    return true;
  }
  return String(alert.sentiment || "neutral") === state.activeFilter;
}

function updateHeader() {
  const clientName = state.config.client_name || "Client non configure";
  document.getElementById("clientName").textContent = clientName;

  const active = state.config.auto_scan !== false;
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");

  statusDot.classList.toggle("status-active", active);
  statusDot.classList.toggle("status-inactive", !active);
  statusText.textContent = active ? "Actif" : "Inactif";
}

function renderAlerts() {
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
    card.className = "alert-card";

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
      <p class="alert-meta">${escapeHtml(alert.author || "Unknown")} - ${escapeHtml(
        alert.group_name || "Group"
      )} - ${relativeTime(alert.timestamp)}</p>
      <div class="alert-actions">
        <button class="text-button" data-action="open" data-id="${escapeHtml(alert.id)}" type="button">Voir le post</button>
        <button
          class="mark-read-button"
          data-action="read"
          data-id="${escapeHtml(alert.id)}"
          type="button"
          ${alert.read ? "disabled" : ""}
        >
          ${alert.read ? "Lu" : "Mark as read"}
        </button>
      </div>
      <details class="suggestions">
        <summary>Reponses suggerees</summary>
        <ol>${suggestionItems || "<li>Aucune suggestion disponible.</li>"}</ol>
      </details>
    `;

    alertsList.appendChild(card);
  }
}

function setBar(id, ratio) {
  const target = document.getElementById(id);
  target.style.width = `${Math.max(0, Math.min(100, Math.round(ratio * 100)))}%`;
}

function renderStats() {
  const now = new Date();
  const isToday = (iso) => {
    const date = new Date(iso);
    return (
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate()
    );
  };

  const todayAlerts = state.alerts.filter((item) => isToday(item.timestamp));

  const counts = {
    very_negative: 0,
    negative: 0,
    neutral: 0,
    positive: 0
  };

  for (const alert of todayAlerts) {
    const sentiment = String(alert.sentiment || "neutral");
    if (Object.prototype.hasOwnProperty.call(counts, sentiment)) {
      counts[sentiment] += 1;
    }
  }

  const total = todayAlerts.length;
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

function renderConfig() {
  document.getElementById("clientNameInput").value = state.config.client_name || "";
  document.getElementById("keywordsInput").value = (state.config.keywords || []).join("\n");
  document.getElementById("alertEmailInput").value = state.config.alert_email || "";
  document.getElementById("autoScanInput").checked = state.config.auto_scan !== false;
  document.getElementById("groqKeyInput").value = state.config.groq_api_key || "";
  document.getElementById("geminiKeyInput").value = state.config.gemini_api_key || "";
  document.getElementById("backendUrlInput").value =
    state.config.backend_url || "http://localhost:8000";
}

function renderAll() {
  updateHeader();
  renderAlerts();
  renderConfig();
  renderStats();
}

async function refreshState() {
  const response = await sendMessage({ action: "get_state" });
  state.alerts = Array.isArray(response.alerts) ? response.alerts : [];
  state.unread_count = Number(response.unread_count || 0);
  state.config = response.config || state.config;
  state.last_scan = response.last_scan || null;
  renderAll();
}

function setupTabs() {
  const tabButtons = document.querySelectorAll(".tab-button");
  const panels = {
    alerts: document.getElementById("tab-alerts"),
    config: document.getElementById("tab-config"),
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
      renderAlerts();
    });
  }
}

function setupAlertsActions() {
  const alertsList = document.getElementById("alertsList");

  alertsList.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }

    const alertId = button.dataset.id;
    const alertItem = state.alerts.find((item) => item.id === alertId);
    if (!alertItem) {
      return;
    }

    const action = button.dataset.action;

    try {
      if (action === "open") {
        await sendMessage({ action: "open_post", url: alertItem.post_url });
        return;
      }

      if (action === "read") {
        await sendMessage({ action: "mark_alert_read", id: alertItem.id });
        await refreshState();
      }
    } catch (error) {
      setFeedback(String(error), true);
    }
  });
}

function setupConfigForm() {
  const form = document.getElementById("configForm");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const keywords = document
      .getElementById("keywordsInput")
      .value.split("\n")
      .map((item) => item.trim())
      .filter(Boolean);

    const configPayload = {
      client_name: document.getElementById("clientNameInput").value.trim(),
      keywords,
      alert_email: document.getElementById("alertEmailInput").value.trim(),
      auto_scan: document.getElementById("autoScanInput").checked,
      groq_api_key: document.getElementById("groqKeyInput").value.trim(),
      gemini_api_key: document.getElementById("geminiKeyInput").value.trim(),
      backend_url: document.getElementById("backendUrlInput").value.trim() || "http://localhost:8000"
    };

    try {
      const response = await sendMessage({ action: "save_config", config: configPayload });
      if (!response.ok) {
        throw new Error(response.error || "Could not save config");
      }
      state.config = response.config;
      renderAll();
      setFeedback("Configuration saved.");
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
      if (!response.ok) {
        throw new Error(response.error || "Manual scan failed");
      }

      const count = Number(response.count || 0);
      setFeedback(`Manual scan completed (${count} post(s) extracted).`);
      await refreshState();
    } catch (error) {
      setFeedback(String(error), true);
    } finally {
      button.disabled = false;
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  setupTabs();
  setupFilters();
  setupAlertsActions();
  setupConfigForm();
  setupManualScanButton();

  try {
    await refreshState();
    setFeedback("Ready.");
  } catch (error) {
    setFeedback(String(error), true);
  }
});
