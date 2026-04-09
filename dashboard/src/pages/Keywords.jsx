import React, { useEffect, useState } from 'react';
import { extensionAPI, keywordsAPI } from '../utils/api';
import { CATEGORY_COLORS } from '../utils/colors';

export default function Keywords() {
  const [keywords, setKeywords] = useState({ marque: [], services: [], produits: [], negatif: [] });
  const [metadata, setMetadata] = useState({ syncedAt: null, installationId: null });

  useEffect(() => {
    (async () => {
      const [res, extensionStateRes] = await Promise.all([
        keywordsAPI.getAll(),
        extensionAPI.getState(),
      ]);

      const grouped = { marque: [], services: [], produits: [], negatif: [] };
      (res.data || []).forEach((k) => {
        if (grouped[k.category]) grouped[k.category].push(k);
      });
      setKeywords(grouped);

      const state = extensionStateRes.data || {};
      setMetadata({
        syncedAt: state.synced_at || null,
        installationId: state.installation_id || null,
      });
    })();
  }, []);

  return (
    <div>
      <h2 style={{ marginBottom: 16 }}>Mots cles</h2>
      <p style={{ marginTop: -8, marginBottom: 16, color: 'var(--text2)', fontSize: 12 }}>
        Geres depuis l'extension Chrome. Derniere synchro: {metadata.syncedAt ? new Date(metadata.syncedAt).toLocaleString() : 'jamais'}
      </p>
      <div className="grid-2">
        {Object.keys(keywords).map((cat) => (
          <div className="panel" key={cat}>
            <h3 style={{ marginBottom: 10 }}>{CATEGORY_COLORS[cat]?.label || cat}</h3>
            <div>
              {keywords[cat].map((kw) => (
                <span className="badge" key={kw.id || kw.keyword} style={{ marginRight: 6, marginBottom: 6, background: CATEGORY_COLORS[cat]?.background || '#334155', color: '#fff' }}>
                  {kw.keyword}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      {metadata.installationId && (
        <p style={{ marginTop: 12, color: 'var(--text2)', fontSize: 11 }}>
          Extension ID: {metadata.installationId}
        </p>
      )}
    </div>
  );
}
