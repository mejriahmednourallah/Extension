import React, { useEffect, useState } from 'react';
import { keywordsAPI } from '../utils/api';
import { CATEGORY_COLORS } from '../utils/colors';

export default function Keywords() {
  const [keywords, setKeywords] = useState({ marque: [], services: [], produits: [], negatif: [] });

  useEffect(() => {
    (async () => {
      const res = await keywordsAPI.getAll();
      const grouped = { marque: [], services: [], produits: [], negatif: [] };
      (res.data || []).forEach((k) => {
        if (grouped[k.category]) grouped[k.category].push(k);
      });
      setKeywords(grouped);
    })();
  }, []);

  return (
    <div>
      <h2 style={{ marginBottom: 16 }}>Mots cles</h2>
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
    </div>
  );
}
