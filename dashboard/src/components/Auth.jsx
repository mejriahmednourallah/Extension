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

    if (CREDENTIALS[username] === password) {
      onLogin(username);
      authStorage.saveAuth({ username });
    } else {
      setError('Identifiants incorrects');
      setTimeout(() => setError(''), 500);
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

        <form onSubmit={handleSubmit}>
          <div className="form-field">
            <label>Identifiant</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin, demo, client"
              disabled={loading}
            />
          </div>

          <div className="form-field">
            <label>Mot de passe</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              disabled={loading}
            />
          </div>

          {error && <div className="auth-error">{error}</div>}

          <button type="submit" className="auth-submit" disabled={loading}>
            {loading ? 'Connexion...' : 'Se connecter'}
          </button>
        </form>

        <div className="auth-hint">
          <strong>Comptes de demo:</strong>
          <p>admin / admin123</p>
          <p>demo / demo2024</p>
          <p>client / client2024</p>
        </div>
      </div>
    </div>
  );
}
