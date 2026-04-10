import React, { useState, useEffect } from 'react';

const DEBUG_ENDPOINTS = [
  { label: 'Health', path: '/health' },
  { label: 'Stats', path: '/stats' },
  { label: 'Groups', path: '/groups?include_disabled=true' },
  { label: 'History', path: '/history?limit=3' },
  { label: 'Extension State', path: '/extension/state' },
];

function withTimeout(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timer };
}

function formatPreview(raw) {
  const value = String(raw || '').trim();
  if (!value) {
    return '';
  }

  if (value.length <= 220) {
    return value;
  }

  return `${value.slice(0, 220)}...`;
}

async function probeEndpoint(baseUrl, endpointPath) {
  const startedAt = performance.now();
  const { controller, timer } = withTimeout(10000);

  try {
    const response = await fetch(`${baseUrl}${endpointPath}`, {
      method: 'GET',
      headers: { 'Cache-Control': 'no-cache' },
      signal: controller.signal,
    });

    const text = await response.text();
    let preview = formatPreview(text);

    try {
      const parsed = JSON.parse(text);
      preview = formatPreview(JSON.stringify(parsed));
    } catch (err) {
      // Keep plain text preview when body is not JSON.
    }

    return {
      path: endpointPath,
      ok: response.ok,
      status: response.status,
      durationMs: Math.round(performance.now() - startedAt),
      preview,
      error: '',
    };
  } catch (error) {
    return {
      path: endpointPath,
      ok: false,
      status: 'network_error',
      durationMs: Math.round(performance.now() - startedAt),
      preview: '',
      error: String(error && error.message ? error.message : error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function Header({ user, onLogout, clock, onOpenDebug }) {
  return (
    <header>
      <div className="container">
        <div className="header-inner">
          <div className="logo">
            <div className="logo-icon">ER</div>
            <div>
              <h1>E-Reputation</h1>
              <p>Monitoring dashboard</p>
            </div>
          </div>
          <div className="header-right">
            <div className="status-badge">
              <div className="status-dot"></div>
              Système actif
            </div>
            <button className="debug-btn" onClick={onOpenDebug}>Debug connexion</button>
            <div className="clock">{clock}</div>
            <button className="logout-btn" onClick={onLogout}>Deconnexion</button>
          </div>
        </div>
      </div>
    </header>
  );
}

export function Tabs({ activeTab, onTabChange }) {
  const tabs = [
    { id: 'overview', label: 'Apercu' },
    { id: 'analytics', label: 'Analytics' },
    { id: 'groups', label: 'Groupes' },
    { id: 'keywords', label: 'Mots-cles' },
    { id: 'badbuzz', label: 'Bad Buzz' },
  ];

  return (
    <div className="tabs-bar">
      <div className="tabs-inner">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function Layout({ children, activeTab, onTabChange, user, onLogout }) {
  const [clock, setClock] = useState(new Date().toLocaleTimeString('fr-FR'));
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugResults, setDebugResults] = useState([]);
  const [debugRunAt, setDebugRunAt] = useState('');

  const backendBaseUrl = (process.env.REACT_APP_API_URL || 'http://localhost:8000').replace(/\/+$/, '');

  useEffect(() => {
    const clockInterval = setInterval(() => {
      setClock(new Date().toLocaleTimeString('fr-FR'));
    }, 1000);

    return () => {
      clearInterval(clockInterval);
    };
  }, []);

  const runDebugCheck = async () => {
    setDebugLoading(true);
    try {
      const probes = await Promise.all(
        DEBUG_ENDPOINTS.map((item) => probeEndpoint(backendBaseUrl, item.path))
      );

      const merged = DEBUG_ENDPOINTS.map((item) => {
        const found = probes.find((probe) => probe.path === item.path);
        return {
          label: item.label,
          ...(found || {
            path: item.path,
            ok: false,
            status: 'unknown',
            durationMs: 0,
            preview: '',
            error: 'No result',
          }),
        };
      });

      setDebugResults(merged);
      setDebugRunAt(new Date().toLocaleString('fr-FR'));
    } finally {
      setDebugLoading(false);
    }
  };

  const openDebug = () => {
    setDebugOpen(true);
    if (!debugResults.length) {
      runDebugCheck();
    }
  };

  const closeDebug = () => setDebugOpen(false);

  const okCount = debugResults.filter((item) => item.ok).length;

  return (
    <div className="app-container">
      <Header user={user} onLogout={onLogout} clock={clock} onOpenDebug={openDebug} />
      <Tabs activeTab={activeTab} onTabChange={onTabChange} />
      <div className="content">
        <div className="container">{children}</div>
      </div>

      <div className={`modal-overlay ${debugOpen ? 'open' : ''}`}>
        <div className="modal debug-modal">
          <button className="modal-close" onClick={closeDebug}>×</button>
          <h3>Diagnostic backend</h3>
          <p className="modal-sub">Verifie l'accessibilite des endpoints backend depuis le navigateur.</p>

          <div className="debug-meta">
            <div><strong>Base URL:</strong> {backendBaseUrl}</div>
            <div><strong>Dernier test:</strong> {debugRunAt || 'jamais'}</div>
            <div><strong>Endpoints OK:</strong> {okCount} / {DEBUG_ENDPOINTS.length}</div>
          </div>

          <div className="debug-actions">
            <button className="btn-primary" onClick={runDebugCheck} disabled={debugLoading}>
              {debugLoading ? 'Verification...' : 'Relancer le test'}
            </button>
            <button className="btn-secondary" onClick={closeDebug}>Fermer</button>
          </div>

          <div className="debug-list">
            {debugResults.map((item) => (
              <div key={item.path} className="debug-item">
                <div className="debug-item-head">
                  <strong>{item.label}</strong>
                  <span className={`debug-pill ${item.ok ? 'ok' : 'ko'}`}>
                    {item.ok ? `OK (${item.status})` : `KO (${item.status})`}
                  </span>
                  <span className="debug-latency">{item.durationMs} ms</span>
                </div>
                {item.error ? (
                  <div className="debug-error">{item.error}</div>
                ) : (
                  <pre className="debug-preview">{item.preview || 'No response body'}</pre>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
