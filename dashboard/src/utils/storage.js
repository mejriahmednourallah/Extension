export const authStorage = {
  saveAuth: (auth) => {
    localStorage.setItem('e-reputation-auth', JSON.stringify(auth));
  },
  getAuth: () => {
    const auth = localStorage.getItem('e-reputation-auth');
    return auth ? JSON.parse(auth) : null;
  },
  clearAuth: () => {
    localStorage.removeItem('e-reputation-auth');
    localStorage.removeItem('e-reputation-token');
  },
  isAuthenticated: () => {
    return !!localStorage.getItem('e-reputation-auth');
  },
  saveToken: (token) => {
    localStorage.setItem('e-reputation-token', token);
  },
  getToken: () => {
    return localStorage.getItem('e-reputation-token');
  },
};
