import React, { useState, useEffect } from 'react';
import { alertsAPI } from '../utils/api';
import { formatRelativeTime } from '../utils/formatters';
import { sentimentToColor } from '../utils/colors';

export default function BadBuzz() {
  const [alerts, setAlerts] = useState([]);
  const [filter, setFilter] = useState('all');
  const [sortBy, setSortBy] = useState('priority');
  const [loading, setLoading] = useState(true);
  const [expandedSuggestions, setExpandedSuggestions] = useState({});

  useEffect(() => {
    fetchAlerts();
  }, []);

  const fetchAlerts = async () => {
    try {
      setLoading(true);
      const response = await alertsAPI.getBadBuzz(100).catch(() => ({ data: [] }));
      const filtered = response.data?.filter((a) => a.sentiment === 'very_negative' || a.sentiment === 'negative') || [];
      setAlerts(filtered);
    } catch (error) {
      console.error('Error fetching alerts:', error);
    } finally {
      setLoading(false);
    }
  };

  const filteredAlerts = (filter === 'all' ? alerts : alerts.filter((a) => a.sentiment === filter)).sort((a, b) => {
    if (sortBy === 'engagement') {
      return Number(b.engagement_total || 0) - Number(a.engagement_total || 0);
    }
    if (sortBy === 'recent') {
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    }
    return Number(b.priority_score || 0) - Number(a.priority_score || 0);
  });

  const handleCopyResponse = (text) => {
    navigator.clipboard.writeText(text);
    alert('Réponse copiée au presse-papiers!');
  };

  const toggleSuggestion = (key) => {
    setExpandedSuggestions((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
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
          className={`bb-filter ${filter === 'very_negative' ? 'active' : ''}`}
          onClick={() => setFilter('very_negative')}
        >
          Tres negatif
        </button>
        <button
          className={`bb-filter ${filter === 'negative' ? 'active' : ''}`}
          onClick={() => setFilter('negative')}
        >
          Negatif
        </button>
        <button
          className={`bb-filter ${sortBy === 'priority' ? 'active' : ''}`}
          onClick={() => setSortBy('priority')}
        >
          Par risque
        </button>
        <button
          className={`bb-filter ${sortBy === 'engagement' ? 'active' : ''}`}
          onClick={() => setSortBy('engagement')}
        >
          Engagement
        </button>
        <button
          className={`bb-filter ${sortBy === 'recent' ? 'active' : ''}`}
          onClick={() => setSortBy('recent')}
        >
          Recent
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
            const llmSuggestions = Array.isArray(alert.bad_buzz_suggestions)
              ? alert.bad_buzz_suggestions.map((item) => String(item || '').trim()).filter(Boolean)
              : [];
            const fallbackSuggestions = [
              'Nous comprenons votre frustration et prenons votre retour tres au serieux. Merci de nous contacter en message prive avec vos coordonnees pour un traitement prioritaire.',
              'Merci pour votre signalement. Notre equipe va verifier cette situation immediatement et revenir vers vous rapidement avec une solution concrete.'
            ];
            const responses = llmSuggestions.length ? llmSuggestions : fallbackSuggestions;
            const useFallbackResponses = llmSuggestions.length === 0;

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

                <div style={{ padding: '0 20px 10px', fontSize: 12, color: 'var(--text2)', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <span>Priority: {Number(alert.priority_score || 0).toFixed(2)}</span>
                  <span>Reactions: {Number(alert.reactions_count || 0)}</span>
                  <span>Comments: {Number(alert.comments_count || 0)}</span>
                  <span>Shares: {Number(alert.shares_count || 0)}</span>
                  <span>Total: {Number(alert.engagement_total || 0)}</span>
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
                  {responses.map((responseText, index) => (
                    <div className="resp-card" key={`${alert.id}-resp-${index}`}>
                      {(() => {
                        const suggestionKey = `${alert.id}-resp-${index}`;
                        const isExpanded = Boolean(expandedSuggestions[suggestionKey]);
                        const canExpand = String(responseText || '').length > 190;
                        const previewText = canExpand && !isExpanded
                          ? `${String(responseText).slice(0, 190)}...`
                          : responseText;

                        return (
                          <>
                            <div className="resp-head">
                              <span className={`strat-pill ${useFallbackResponses ? (index === 0 ? 'sp-esc' : 'sp-emp') : 'sp-emp'}`}>
                                {useFallbackResponses
                                  ? (index === 0 ? 'Template escalation' : 'Template empathique')
                                  : `Suggestion IA ${index + 1}`}
                              </span>
                              <button
                                className="copy-btn"
                                onClick={() => handleCopyResponse(responseText)}
                              >
                                Copier
                              </button>
                            </div>
                            <div className="resp-text">{previewText}</div>
                            {canExpand && (
                              <button
                                type="button"
                                className="resp-toggle"
                                onClick={() => toggleSuggestion(suggestionKey)}
                              >
                                {isExpanded ? 'Voir moins' : 'Voir plus'}
                              </button>
                            )}
                            <div className="resp-why">
                              {useFallbackResponses
                                ? 'Template local utilise car aucune suggestion LLM n\'a ete retournee.'
                                : 'Suggestion generee et retournee par le backend LLM.'}
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
