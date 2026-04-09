import React, { useState, useEffect } from 'react';

export function Header({ user, onLogout, uptime, clock }) {
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
  const [uptime, setUptime] = useState(0);

  useEffect(() => {
    const clockInterval = setInterval(() => {
      setClock(new Date().toLocaleTimeString('fr-FR'));
    }, 1000);

    const uptimeInterval = setInterval(() => {
      setUptime((prev) => prev + 1);
    }, 1000);

    return () => {
      clearInterval(clockInterval);
      clearInterval(uptimeInterval);
    };
  }, []);

  return (
    <div className="app-container">
      <Header user={user} onLogout={onLogout} clock={clock} uptime={uptime} />
      <Tabs activeTab={activeTab} onTabChange={onTabChange} />
      <div className="content">
        <div className="container">{children}</div>
      </div>
    </div>
  );
}
