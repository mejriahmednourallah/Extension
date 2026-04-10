import React, { useState } from 'react';
import { authStorage } from '../utils/storage';

export default function Auth({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const CREDENTIALS = {
    admin: 'admin123',
    demo: 'demo2024',
    client: 'client2024',
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    if (!username || !password) {
      setError('Veuillez entrer les identifiants');
      setLoading(false);
      return;
    }

    const normalizedUsername = String(username || '').trim().toLowerCase();

    if (CREDENTIALS[normalizedUsername] === password) {
      onLogin(normalizedUsername);
      authStorage.saveAuth({ username: normalizedUsername });
    } else {
      setError('Identifiants incorrects');
      setTimeout(() => setError(''), 2500);
    }

    setLoading(false);
  };

  return (
    <div className="auth-container">
      <div className="auth-box">
        <div className="auth-header">
          <div className="auth-logo">ER</div>
          <h1>E-Reputation</h1>
          <p>Monitoring et pilotage</p>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="form-field">
            <label htmlFor="auth-username">Identifiant</label>
            <input
              id="auth-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin, demo, client"
              autoComplete="username"
              disabled={loading}
            />
          </div>

          <div className="form-field">
            <label htmlFor="auth-password">Mot de passe</label>
            <input
              id="auth-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              disabled={loading}
            />
          </div>

          {error && <div className="auth-error">{error}</div>}

          <button type="submit" className="auth-submit" disabled={loading}>
            {loading ? 'Connexion...' : 'Se connecter'}
          </button>
        </form>

        <div className="auth-hint">
          <strong>Comptes de demo</strong>
          <ul>
            <li>admin / admin123</li>
            <li>demo / demo2024</li>
            <li>client / client2024</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
