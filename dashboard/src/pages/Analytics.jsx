import React from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

export default function Analytics() {
  const weekData = [
    { day: 'Lundi', positif: 45, neutre: 30, négatif: 15 },
    { day: 'Mardi', positif: 52, neutre: 28, négatif: 20 },
    { day: 'Mercredi', positif: 48, neutre: 35, négatif: 17 },
    { day: 'Jeudi', positif: 61, neutre: 25, négatif: 14 },
    { day: 'Vendredi', positif: 55, neutre: 32, négatif: 13 },
    { day: 'Samedi', positif: 67, neutre: 28, négatif: 5 },
    { day: 'Dimanche', positif: 72, neutre: 20, négatif: 8 },
  ];

  return (
    <div>
      <div style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '18px', fontWeight: 700 }}>Analyse et tendances</h2>
        <p style={{ fontSize: '13px', color: 'var(--text2)', marginTop: '3px' }}>Vue détaillée des données</p>
      </div>

      <div className="grid-main">
        <div>
          <div className="panel">
            <div className="panel-header">
              <h3>Distribution par jour</h3>
            </div>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={weekData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="day" stroke="var(--text2)" />
                <YAxis stroke="var(--text2)" />
                <Tooltip contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)' }} />
                <Legend />
                <Bar dataKey="positif" stackId="a" fill="#22c55e" />
                <Bar dataKey="neutre" stackId="a" fill="#9ca3af" />
                <Bar dataKey="négatif" stackId="a" fill="#ef4444" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div>
          <div className="panel">
            <div className="panel-header">
              <h3>Score e-réputation</h3>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '300px' }}>
              <div style={{ fontSize: '64px', fontWeight: 700, color: '#f97316' }}>48</div>
              <div style={{ marginLeft: '20px', color: 'var(--text2)' }}>
                <div style={{ fontSize: '12px' }}>/ 100</div>
                <div style={{ fontSize: '11px', marginTop: '8px' }}>Moyen</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: '20px' }}>
        <div className="panel-header">
          <h3>Distribution des langues</h3>
        </div>
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-label">Darija</div>
            <div className="stat-value">54%</div>
            <div className="stat-bar" style={{ background: '#334155' }}></div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Français</div>
            <div className="stat-value">28%</div>
            <div className="stat-bar" style={{ background: '#22c55e' }}></div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Arabe</div>
            <div className="stat-value">12%</div>
            <div className="stat-bar" style={{ background: '#f97316' }}></div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Mixte</div>
            <div className="stat-value">6%</div>
            <div className="stat-bar" style={{ background: '#a855f7' }}></div>
          </div>
        </div>
      </div>
    </div>
  );
}
