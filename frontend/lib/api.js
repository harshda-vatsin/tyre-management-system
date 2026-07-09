/**
 * @file api.js
 * @description Universal HTTP REST client wrapper for the frontend.
 * Automatically injects Bearer JWT authentication tokens, handles JSON serialization,
 * parses server responses, and initiates secure file/report exports downloads.
 */

const BASE_URL = '/api';

/**
 * Checks if the window object (browser state context) is loaded.
 * Necessary because Next.js initially server-renders components.
 * 
 * @returns {boolean} True if running on the client side
 */
function hasStorage() {
  return typeof window !== 'undefined';
}

/**
 * Retrieves the stored JWT authentication token.
 * 
 * @returns {string|null} Token string or null
 */
function getToken() {
  return hasStorage() ? localStorage.getItem('ebtms_token') : null;
}

/**
 * Stores or clears the authentication token in localStorage.
 * 
 * @param {string|null} token - JWT token string
 */
export function setToken(token) {
  if (!hasStorage()) return;
  if (token) localStorage.setItem('ebtms_token', token);
  else localStorage.removeItem('ebtms_token');
}

/**
 * Retrieves the stored user profile context.
 * 
 * @returns {object|null} Decoded user object or null
 */
export function getUser() {
  if (!hasStorage()) return null;
  const raw = localStorage.getItem('ebtms_user');
  return raw ? JSON.parse(raw) : null;
}

/**
 * Stores or clears the logged user context in localStorage.
 * 
 * @param {object|null} user - User profile object
 */
export function setUser(user) {
  if (!hasStorage()) return;
  if (user) localStorage.setItem('ebtms_user', JSON.stringify(user));
  else localStorage.removeItem('ebtms_user');
}

/**
 * Core async wrapper sending HTTP requests to backend endpoints.
 * 
 * @param {string} path - Target route suffix (e.g. '/tyres')
 * @param {object} [options] - Fetch config options
 * @returns {Promise<any>} Response payload JSON/text data
 */
async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const token = getToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : await res.text();

  if (!res.ok) {
    const message = (data && data.error) || res.statusText || 'Request failed';
    const error = new Error(message);
    error.status = res.status;
    error.data = data;
    throw error;
  }

  return data;
}

// REST wrapper object mapping method keys to standard fetch operations
export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body }),
  put: (path, body) => request(path, { method: 'PUT', body }),
  patch: (path, body) => request(path, { method: 'PATCH', body }),
  del: (path) => request(path, { method: 'DELETE' }),
};

/**
 * Uploads a file (e.g. a CSV Bulk Import) as multipart/form-data. Deliberately
 * skips the JSON Content-Type/body-serialization request() uses -- the
 * browser sets its own multipart boundary header when given a FormData body.
 *
 * @param {string} path - Target API segment
 * @param {File} file - File selected by the user
 * @returns {Promise<any>} Parsed JSON response
 */
export async function uploadFile(path, file) {
  const token = getToken();
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });

  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : await res.text();

  if (!res.ok) {
    const message = (data && data.error) || res.statusText || 'Upload failed';
    const error = new Error(message);
    error.status = res.status;
    error.data = data;
    throw error;
  }

  return data;
}

/**
 * Handles binary report file downloads (PDF and Excel formats).
 * 
 * @param {string} path - Target API segment
 * @param {string} filenameFallback - Fallback name if Content-Disposition is missing
 */
export async function downloadFile(path, filenameFallback) {
  const token = getToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Export failed');
  }
  const disposition = res.headers.get('content-disposition') || '';
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match ? match[1] : filenameFallback;

  // Create local anchor node to trigger standard browser file save download
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
