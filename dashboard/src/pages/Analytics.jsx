import React, { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { systemAPI } from '../utils/api';

export default function Analytics() {
  const [weekData, setWeekData] = useState([]);
  const [score, setScore] = useState(0);
  const [languagePct, setLanguagePct] = useState({
    darija: 0,
    french: 0,
    arabic: 0,
    mixte: 0,
  });

  useEffect(() => {
    (async () => {
      const response = await systemAPI.stats();
      const data = response.data || {};
      const chart = Array.isArray(data.daily_sentiment_7d)
        ? data.daily_sentiment_7d.map((item) => ({
            day: String(item.day || '').slice(5),
            positif: Number(item.positive || 0),
            neutre: Number(item.neutral || 0),
            negatif: Number(item.negative || 0) + Number(item.very_negative || 0),
          }))
        : [];

      setWeekData(chart);
      const avgScore24h = Number(data.avg_score_24h || 0);
      setScore(Math.round(Math.max(0, Math.min(100, (avgScore24h + 1) * 50))));

      const dist = data.language_distribution_24h || {};
      const counts = {
        darija: Number(dist.darija || 0),
        french: Number(dist.french || 0),
        arabic: Number(dist.arabic || 0),
        mixte: Number(dist.mixte || 0),
      };
      const total = counts.darija + counts.french + counts.arabic + counts.mixte;

      if (total <= 0) {
        setLanguagePct({ darija: 0, french: 0, arabic: 0, mixte: 0 });
      } else {
        setLanguagePct({
          darija: Math.round((counts.darija / total) * 100),
          french: Math.round((counts.french / total) * 100),
          arabic: Math.round((counts.arabic / total) * 100),
          mixte: Math.round((counts.mixte / total) * 100),
        });
      }
    })();
  }, []);

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
                <Bar dataKey="negatif" stackId="a" fill="#ef4444" />
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
              <div style={{ fontSize: '64px', fontWeight: 700, color: '#f97316' }}>{score}</div>
              <div style={{ marginLeft: '20px', color: 'var(--text2)' }}>
                <div style={{ fontSize: '12px' }}>/ 100</div>
                <div style={{ fontSize: '11px', marginTop: '8px' }}>{score >= 65 ? 'Bon' : score >= 40 ? 'Moyen' : 'A risque'}</div>
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
            <div className="stat-value">{languagePct.darija}%</div>
            <div className="stat-bar" style={{ background: '#334155' }}></div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Français</div>
            <div className="stat-value">{languagePct.french}%</div>
            <div className="stat-bar" style={{ background: '#22c55e' }}></div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Arabe</div>
            <div className="stat-value">{languagePct.arabic}%</div>
            <div className="stat-bar" style={{ background: '#f97316' }}></div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Mixte</div>
            <div className="stat-value">{languagePct.mixte}%</div>
            <div className="stat-bar" style={{ background: '#a855f7' }}></div>
          </div>
        </div>
      </div>
    </div>
  );
}
