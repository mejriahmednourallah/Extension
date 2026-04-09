import React, { useState, useEffect } from 'react';
import { alertsAPI, groupsAPI } from '../utils/api';
import { formatRelativeTime, formatNumber, truncateText } from '../utils/formatters';
import { sentimentToColor } from '../utils/colors';

export default function Overview() {
  const [alerts, setAlerts] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    totalPosts: 0,
    alertCount: 0,
    groupCount: 0,
    avgScore: 0,
    uptime: '99.8%',
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [alertsRes, groupsRes] = await Promise.all([
        alertsAPI.getHistory(10),
        groupsAPI.getAll().catch(() => ({ data: [] })),
      ]);

      const alertsData = alertsRes.data || [];
      const groupsData = groupsRes.data || [];

      setAlerts(alertsData);
      setGroups(groupsData);

      const totalPosts = alertsData.length;
      const avgScore = alertsData.length > 0
        ? (alertsData.reduce((sum, a) => sum + (a.score || 0), 0) / alertsData.length * 100).toFixed(0)
        : 0;

      setStats({
        totalPosts,
        alertCount: alertsData.length,
        groupCount: groupsData.length,
        avgScore,
        uptime: '99.8%',
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

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">Posts analysés</div>
          <div className="stat-value">{formatNumber(stats.totalPosts)}</div>
          <div className="stat-bar" style={{ background: '#334155' }}></div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Alertes détectées</div>
          <div className="stat-value">{stats.alertCount}</div>
          <div className="stat-bar" style={{ background: '#ef4444' }}></div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Groupes surveillés</div>
          <div className="stat-value">{stats.groupCount}</div>
          <div className="stat-bar" style={{ background: '#f97316' }}></div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Score moyen</div>
          <div className="stat-value">{stats.avgScore}%</div>
          <div className="stat-bar" style={{ background: '#22c55e' }}></div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Uptime système</div>
          <div className="stat-value">{stats.uptime}</div>
          <div className="stat-bar" style={{ background: '#a855f7' }}></div>
        </div>
      </div>

      <div className="grid-main">
        <div>
          <div className="panel">
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

        <div>
          <div className="panel">
            <div className="panel-header">
              <h3>Groupes actifs</h3>
            </div>
            <div style={{ maxHeight: '540px', overflowY: 'auto' }}>
              {groups.length === 0 ? (
                <div style={{ padding: '20px', color: 'var(--text2)', textAlign: 'center' }}>
                  Aucun groupe
                </div>
              ) : (
                groups.slice(0, 5).map((group) => (
                  <div key={group.id} className="agent-item">
                    <div style={{ fontWeight: 600, fontSize: '13px' }}>{group.name}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text2)', marginTop: '4px' }}>
                      {group.post_count || 0} posts
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
