import React, { useState, useEffect } from 'react';
import Auth from './components/Auth';
import Layout from './components/Layout';
import Overview from './pages/Overview';
import Analytics from './pages/Analytics';
import Groups from './pages/Groups';
import Keywords from './pages/Keywords';
import BadBuzz from './pages/BadBuzz';
import { authStorage } from './utils/storage';

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [user, setUser] = useState(null);

  useEffect(() => {
    const auth = authStorage.getAuth();
    if (auth && auth.username) {
      setIsAuthenticated(true);
      setUser(auth);
    }
  }, []);

  const handleLogin = (username) => {
    setUser({ username });
    setIsAuthenticated(true);
    authStorage.saveAuth({ username });
  };

  const handleLogout = () => {
    setIsAuthenticated(false);
    setUser(null);
    authStorage.clearAuth();
    setActiveTab('overview');
  };

  if (!isAuthenticated) {
    return <Auth onLogin={handleLogin} />;
  }

  const renderPage = () => {
    switch (activeTab) {
      case 'overview':
        return <Overview />;
      case 'analytics':
        return <Analytics />;
      case 'groups':
        return <Groups />;
      case 'keywords':
        return <Keywords />;
      case 'badbuzz':
        return <BadBuzz />;
      default:
        return <Overview />;
    }
  };

  return (
    <Layout activeTab={activeTab} onTabChange={setActiveTab} onLogout={handleLogout} user={user}>
      {renderPage()}
    </Layout>
  );
}
