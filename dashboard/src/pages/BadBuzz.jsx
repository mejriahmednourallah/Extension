import React, { useState, useEffect } from 'react';
import { alertsAPI } from '../utils/api';
import { formatRelativeTime, formatScore } from '../utils/formatters';
import { sentimentToColor } from '../utils/colors';

export default function BadBuzz() {
  const [alerts, setAlerts] = useState([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAlerts();
  }, []);

  const fetchAlerts = async () => {
    try {
      setLoading(true);
      const response = await alertsAPI.getHistory(50).catch(() => ({ data: [] }));
      const filtered = response.data?.filter((a) => a.sentiment === 'très_négatif' || a.sentiment === 'négatif') || [];
      setAlerts(filtered);
    } catch (error) {
      console.error('Error fetching alerts:', error);
    } finally {
      setLoading(false);
    }
  };

  const filteredAlerts = filter === 'all' ? alerts : alerts.filter((a) => a.sentiment === filter);

  const handleCopyResponse = (text) => {
    navigator.clipboard.writeText(text);
    alert('Réponse copiée au presse-papiers!');
  };

  return (
    <div>
      <div style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '18px', fontWeight: 700 }}>Gestion des Bad Buzz</h2>
        <p style={{ fontSize: '13px', color: 'var(--text2)', marginTop: '3px' }}>
          Propositions de réponses générées par IA pour chaque alerte négative
        </p>
      </div>

      <div className="bb-filter-bar">
        <button
          className={`bb-filter ${filter === 'all' ? 'active' : ''}`}
          onClick={() => setFilter('all')}
        >
          Tous les cas
        </button>
        <button
          className={`bb-filter ${filter === 'très_négatif' ? 'active' : ''}`}
          onClick={() => setFilter('très_négatif')}
        >
          Tres negatif
        </button>
        <button
          className={`bb-filter ${filter === 'négatif' ? 'active' : ''}`}
          onClick={() => setFilter('négatif')}
        >
          Negatif
        </button>
      </div>

      <div id="bb-feed">
        {loading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text2)' }}>
            Chargement...
          </div>
        ) : filteredAlerts.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text2)' }}>
            Aucune alerte négative pour le moment
          </div>
        ) : (
          filteredAlerts.map((alert) => {
            const colors = sentimentToColor(alert.sentiment);
            return (
              <div key={alert.id} className="bb-block">
                <div className="bb-block-header">
                  <span className="badge" style={{ ...colors }}>
                    {alert.sentiment}
                  </span>
                  {alert.score < -0.7 && <span className="badge b-urg">Urgent</span>}
                  <span style={{ fontSize: '13px', fontWeight: 600 }}>
                    {alert.group_name}
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--text2)', marginLeft: 'auto' }}>
                    {formatRelativeTime(alert.created_at)}
                  </span>
                  {alert.post_url && (
                    <a
                      href={alert.post_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="post-lnk"
                      style={{ fontSize: '11px', marginLeft: '8px' }}
                    >
                      Voir le post
                    </a>
                  )}
                </div>

                <div className="bb-ctx">
                  {alert.post_text
                    ? alert.post_text.substring(0, 200) + (alert.post_text.length > 200 ? '...' : '')
                    : 'Aucun contenu disponible'}
                </div>

                <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text2)', padding: '0 20px 10px' }}>
                  Propositions de reponse suggerees:
                </div>

                <div className="bb-responses">
                  <div className="resp-card">
                    <div className="resp-head">
                      <span className="strat-pill sp-esc">
                        {alert.score < -0.8 ? 'Escalade critique' : 'Escalade recommandee'}
                      </span>
                      <button
                        className="copy-btn"
                        onClick={() =>
                          handleCopyResponse(
                            `[INTERNE] Alerte ${alert.sentiment}. Score: ${formatScore(alert.score)}. Source: ${alert.group_name}. Escalader immédiatement.`
                          )
                        }
                      >
                        Copier
                      </button>
                    </div>
                    <div className="resp-text">
                      {alert.score < -0.8
                        ? '[CRITIQUE] Contacter immédiatement la direction. Post viral détecté. Déclencher cellule de crise.'
                        : 'Escalader au directeur des opérations. Préparer réponse publique et interne.'}
                    </div>
                    <div className="resp-why">
                      {alert.score < -0.8 ? 'Post a forte viralite' : 'Sentiment tres negatif detecte'}
                    </div>
                  </div>

                  <div className="resp-card">
                    <div className="resp-head">
                      <span className="strat-pill sp-emp">Reponse empathique publique</span>
                      <button
                        className="copy-btn"
                        onClick={() =>
                          handleCopyResponse(
                            `Bonjour,\n\nNous comprenons votre frustration et prenons note de votre retour. \n\nPouvez-vous nous contacter en message privé avec plus de détails ? Notre équipe prioritaire vous aidera sous les 24 heures.\n\nCordialement,\nService Client`
                          )
                        }
                      >
                        Copier
                      </button>
                    </div>
                    <div className="resp-text">
                      Bonjour,<br />
                      <br />
                      Nous comprenons votre frustration et prenons note de votre retour. La satisfaction client est notre priorité.
                      <br />
                      <br />
                      Pouvez-vous nous contacter en message privé avec plus de détails ? Notre équipe prioritaire vous répondra sous 24h.
                      <br />
                      <br />
                      Merci de votre patience.
                    </div>
                    <div className="resp-why">
                      Montre reactivite et empathie. Deplace la discussion en prive.
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
