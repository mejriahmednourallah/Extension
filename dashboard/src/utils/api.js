import axios from 'axios';

const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:8000';

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Alerts API
export const alertsAPI = {
  getHistory: (limit = 50) =>
    apiClient.get('/history', { params: { limit } }).catch((err) => {
      console.error('Error fetching history:', err);
      return { data: [] };
    }),
};

// Groups API
export const groupsAPI = {
  getAll: () =>
    apiClient.get('/groups').catch((err) => {
      console.error('Error fetching groups:', err);
      return { data: [] };
    }),
  create: (data) =>
    apiClient.post('/groups', data).catch((err) => {
      console.error('Error creating group:', err);
      throw err;
    }),
  update: (id, data) =>
    apiClient.put(`/groups/${id}`, data).catch((err) => {
      console.error('Error updating group:', err);
      throw err;
    }),
  delete: (id) =>
    apiClient.delete(`/groups/${id}`).catch((err) => {
      console.error('Error deleting group:', err);
      throw err;
    }),
};

// Keywords API
export const keywordsAPI = {
  getAll: () =>
    apiClient.get('/keywords').catch((err) => {
      console.error('Error fetching keywords:', err);
      return { data: [] };
    }),
  create: (category, keyword) =>
    apiClient.post('/keywords', { category, keyword }).catch((err) => {
      console.error('Error creating keyword:', err);
      throw err;
    }),
  delete: (id) =>
    apiClient.delete(`/keywords/${id}`).catch((err) => {
      console.error('Error deleting keyword:', err);
      throw err;
    }),
};

// System API
export const systemAPI = {
  health: () =>
    apiClient.get('/health').catch((err) => {
      console.error('Error checking health:', err);
      return { data: { status: 'offline' } };
    }),
  stats: () =>
    apiClient.get('/stats').catch((err) => {
      console.error('Error fetching stats:', err);
      return { data: {} };
    }),
};
