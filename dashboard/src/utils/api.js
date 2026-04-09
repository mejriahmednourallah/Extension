import axios from 'axios';

const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:8000';
const BACKEND_PROBE_MAX_ATTEMPTS = 12;
const BACKEND_PROBE_BASE_DELAY_MS = 1500;
const BACKEND_PROBE_TIMEOUT_MS = 12000;
const BACKEND_HEALTH_CACHE_TTL_MS = 60000;

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

let backendHealthyUntil = 0;
let backendProbePromise = null;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureBackendHealthy() {
  if (backendHealthyUntil > Date.now()) {
    return;
  }

  if (backendProbePromise) {
    return backendProbePromise;
  }

  backendProbePromise = (async () => {
    let lastError = null;

    for (let attempt = 1; attempt <= BACKEND_PROBE_MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await apiClient.get('/health', {
          timeout: BACKEND_PROBE_TIMEOUT_MS,
          headers: {
            'Cache-Control': 'no-cache',
          },
        });

        if (!response || response.status < 200 || response.status >= 300) {
          throw new Error(`Health check failed with status ${response ? response.status : 'unknown'}`);
        }

        const payload = response.data || {};
        if (payload.status && String(payload.status).toLowerCase() !== 'ok') {
          throw new Error(`Backend reported non-ok status: ${payload.status}`);
        }

        backendHealthyUntil = Date.now() + BACKEND_HEALTH_CACHE_TTL_MS;
        return;
      } catch (error) {
        lastError = error;

        if (attempt < BACKEND_PROBE_MAX_ATTEMPTS) {
          const delayMs = BACKEND_PROBE_BASE_DELAY_MS * attempt;
          await wait(delayMs);
        }
      }
    }

    throw new Error(
      `Backend is still waking up. Last probe error: ${String(lastError && lastError.message ? lastError.message : lastError)}`
    );
  })();

  try {
    await backendProbePromise;
  } finally {
    backendProbePromise = null;
  }
}

apiClient.interceptors.request.use(
  async (config) => {
    const requestPath = String(config && config.url ? config.url : '');
    if (!requestPath || requestPath === '/health') {
      return config;
    }

    await ensureBackendHealthy();
    return config;
  },
  (error) => Promise.reject(error)
);

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
