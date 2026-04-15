import React, { useState, useEffect, useRef } from 'react';
import { alertsAPI, groupsAPI, systemAPI } from '../utils/api';
import { formatRelativeTime, formatNumber, truncateText } from '../utils/formatters';
import { sentimentToColor } from '../utils/colors';

// Agents always "active" in this session
const AGENTS = [
  { id: 1, name: 'Ahmed Nour Allah Mejri', avatar: 'AN' },
  { id: 2, name: 'Mariem Bouslama', avatar: 'MB' },
];

function useAgentTimer() {
  // Each agent gets a random starting offset (0–4 min) and ticks every second
  const [seconds, setSeconds] = useState(() =>
    AGENTS.map(() => Math.floor(Math.random() * 240))
  );
  useEffect(() => {
    const id = setInterval(() => {
      setSeconds((prev) => prev.map((s) => s + 1));
    }, 1000);
    return () => clearInterval(id);
  }, []);
  return seconds;
}

function useSessionTimer() {
  const startRef = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);
  return elapsed;
}

function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export default function Overview() {
  const [alerts, setAlerts] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    totalPosts: 0,
    alertCount: 0,
    groupCount: 0,
    avgScore: 0,
  });

  const agentSeconds = useAgentTimer();
  const sessionElapsed = useSessionTimer();

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [alertsRes, groupsRes, statsRes] = await Promise.all([
        alertsAPI.getHistory(10),
        groupsAPI.getAll(true).catch(() => ({ data: [] })),
        systemAPI.stats().catch(() => ({ data: {} })),
      ]);

      const alertsData = alertsRes.data || [];
      const groupsData = groupsRes.data || [];
      const statsData = statsRes.data || {};

      setAlerts(alertsData);
      setGroups(groupsData);

      const avgScore = Number(statsData.avg_score_24h || 0);
      const normalizedAvgScore = Math.round(Math.max(0, Math.min(100, (avgScore + 1) * 50)));

      setStats({
        totalPosts: Number(statsData.total_posts_today || statsData.total_posts || 0),
        alertCount: Number(statsData.alerts_today || 0),
        groupCount: Number(statsData.groups_active_count || groupsData.filter((g) => g.enabled !== false).length),
        avgScore: normalizedAvgScore,
      });
    } catch (error) {
      console.error('Error fetching overview data:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <div style={{ padding: '40px', textAlign: 'center' }}>Chargement...</div>;
  }

  return (
    <div>
      <div style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '18px', fontWeight: 700 }}>Tableau de bord</h2>
        <p style={{ fontSize: '13px', color: 'var(--text2)', marginTop: '3px' }}>Vue d'ensemble des activités</p>
      </div>

      {/* ── KPI cards ── */}
      <div className="stats-grid">
        <div className="stat-card stat-card--blue">
          <div className="stat-label">Posts analysés</div>
          <div className="stat-value">{formatNumber(stats.totalPosts)}</div>
          <div className="stat-bar" style={{ background: '#3b82f6' }}></div>
        </div>
        <div className="stat-card stat-card--red">
          <div className="stat-label">Alertes détectées</div>
          <div className="stat-value">{stats.alertCount}</div>
          <div className="stat-bar" style={{ background: '#ef4444' }}></div>
        </div>
        <div className="stat-card stat-card--orange">
          <div className="stat-label">Groupes surveillés</div>
          <div className="stat-value">{stats.groupCount}</div>
          <div className="stat-bar" style={{ background: '#f97316' }}></div>
        </div>
        <div className="stat-card stat-card--green">
          <div className="stat-label">Score moyen</div>
          <div className="stat-value">{stats.avgScore}%</div>
          <div className="stat-bar" style={{ background: '#22c55e' }}></div>
        </div>
        {/* Session timer replaces the old "Uptime" live card */}
        <div className="stat-card stat-card--purple">
          <div className="stat-label">Session en cours</div>
          <div className="stat-value stat-value--sm">{formatDuration(sessionElapsed)}</div>
          <div className="stat-bar" style={{ background: '#a855f7' }}></div>
        </div>
      </div>

      <div className="grid-main">
        {/* ── Dernières alertes ── */}
        <div>
          <div className="panel panel--highlight">
            <div className="panel-header">
              <h3>Dernieres alertes</h3>
            </div>
            <div id="alerts-feed" style={{ maxHeight: '540px', overflowY: 'auto' }}>
              {alerts.length === 0 ? (
                <div style={{ padding: '20px', color: 'var(--text2)', textAlign: 'center' }}>
                  Aucune alerte
                </div>
              ) : (
                alerts.map((alert) => {
                  const colors = sentimentToColor(alert.sentiment);
                  return (
                    <div key={alert.id} className="alert-item" style={{ borderLeftColor: colors.background }}>
                      <div className="alert-header">
                        <span className="badge" style={colors}>
                          {alert.sentiment}
                        </span>
                        <span style={{ fontSize: '11px', color: 'var(--text2)' }}>
                          {formatRelativeTime(alert.created_at)}
                        </span>
                        {alert.post_url && (
                          <a
                            href={alert.post_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="post-lnk"
                            style={{ fontSize: '11px', marginLeft: 'auto', color: 'var(--accent)', textDecoration: 'none' }}
                            onMouseOver={(e) => (e.target.style.textDecoration = 'underline')}
                            onMouseOut={(e) => (e.target.style.textDecoration = 'none')}
                          >
                            Voir le post
                          </a>
                        )}
                      </div>
                      <div style={{ fontSize: '13px', color: 'var(--text2)', marginTop: '6px' }}>
                        {truncateText(alert.post_text, 100)}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* ── Right column ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Groupes actifs */}
          <div className="panel panel--highlight">
            <div className="panel-header">
              <h3>Groupes actifs</h3>
            </div>
            <div style={{ maxHeight: '230px', overflowY: 'auto' }}>
              {groups.length === 0 ? (
                <div style={{ padding: '20px', color: 'var(--text2)', textAlign: 'center' }}>
                  Aucun groupe
                </div>
              ) : (
                groups.filter((group) => group.enabled !== false).slice(0, 5).map((group) => (
                  <div key={group.id} className="agent-item">
                    <div style={{ fontWeight: 600, fontSize: '13px' }}>{group.name}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text2)', marginTop: '4px' }}>
                      {group.group_url || group.url || 'No link'}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Agents actifs */}
          <div className="panel panel--highlight">
            <div className="panel-header" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h3>Agents actifs</h3>
              <span style={{
                background: '#dcfce7',
                color: '#16a34a',
                fontSize: '10px',
                fontWeight: 700,
                borderRadius: '999px',
                padding: '2px 8px',
              }}>
                {AGENTS.length} en ligne
              </span>
            </div>
            <div>
              {AGENTS.map((agent, idx) => (
                <div key={agent.id} className="agent-item" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  {/* Avatar */}
                  <div style={{
                    width: 34,
                    height: 34,
                    borderRadius: '50%',
                    background: idx === 0 ? '#dbeafe' : '#f3e8ff',
                    color: idx === 0 ? '#1d4ed8' : '#7c3aed',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: 700,
                    fontSize: '12px',
                    flexShrink: 0,
                  }}>
                    {agent.avatar}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {agent.name}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text2)', display: 'flex', alignItems: 'center', gap: '5px', marginTop: '2px' }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#16a34a', display: 'inline-block' }}></span>
                      Actif · {formatDuration(agentSeconds[idx])}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
