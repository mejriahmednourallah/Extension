export const SENTIMENT_COLORS = {
  très_positif: { background: '#16a34a', color: '#ffffff', label: 'Tres positif' },
  positif: { background: '#22c55e', color: '#ffffff', label: 'Positif' },
  neutre: { background: '#6b7280', color: '#ffffff', label: 'Neutre' },
  négatif: { background: '#ea580c', color: '#ffffff', label: 'Negatif' },
  très_négatif: { background: '#dc2626', color: '#ffffff', label: 'Tres negatif' },
  very_positive: { background: '#16a34a', color: '#ffffff', label: 'Tres positif' },
  positive: { background: '#22c55e', color: '#ffffff', label: 'Positif' },
  neutral: { background: '#6b7280', color: '#ffffff', label: 'Neutre' },
  negative: { background: '#ea580c', color: '#ffffff', label: 'Negatif' },
  very_negative: { background: '#dc2626', color: '#ffffff', label: 'Tres negatif' },
};

export const CATEGORY_COLORS = {
  marque: { background: '#ef4444', label: 'Marque' },
  services: { background: '#f97316', label: 'Services' },
  produits: { background: '#334155', label: 'Produits' },
  negatif: { background: '#a855f7', label: 'Termes Négatifs' },
};

export const THEME = {
  bg: '#f6f8fb',
  bg2: '#ffffff',
  bg3: '#f1f5f9',
  bg4: '#e2e8f0',
  border: '#d9e2ec',
  border2: '#c1ced9',
  text: '#0f172a',
  text2: '#475569',
  accent: '#111827',
  red: '#dc2626',
  orange: '#ea580c',
  green: '#16a34a',
  purple: '#7c3aed',
};

export function sentimentToColor(sentiment) {
  return SENTIMENT_COLORS[sentiment] || SENTIMENT_COLORS.neutral || SENTIMENT_COLORS.neutre;
}

export function getSentimentIcon(sentiment) {
  const icons = {
    très_positif: '',
    positif: '',
    neutre: '',
    négatif: '',
    très_négatif: '',
    very_positive: '',
    positive: '',
    neutral: '',
    negative: '',
    very_negative: '',
  };
  return icons[sentiment] || '';
}
