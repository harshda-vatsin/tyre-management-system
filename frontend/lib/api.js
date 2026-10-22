/**
 * @file api.js
 * @description Universal HTTP REST client wrapper for the frontend.
 * Attaches the short-lived Bearer access token, transparently renews it via
 * the HttpOnly refresh cookie when it expires, parses server responses, and
 * initiates secure file/report export downloads.
 *
 * Session model: the access JWT lives in module memory only (never
 * localStorage, so XSS can't read a long-lived credential); the refresh token
 * is an HttpOnly cookie the browser manages. After a page reload the access
 * token is gone and restoreSession() obtains a new one from the cookie.
 */

const BASE_URL = '/api';
const CSRF_HEADERS = { 'X-Requested-With': 'ebtms' };
// Renew proactively when the token has less than this left, so most requests
// never see a 401 at all.
const REFRESH_SKEW_SECONDS = 30;

let accessToken = null;
let refreshPromise = null;
const sessionListeners = new Set();

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
 * Sets or clears the in-memory access token.
 *
 * @param {string|null} token - JWT access token string
 */
export function setToken(token) {
  accessToken = token || null;
  // Earlier versions kept the token in localStorage; scrub any leftover.
  if (hasStorage()) localStorage.removeItem('ebtms_token');
}

/**
 * Retrieves the cached user profile (display only; never used for authorization).
 *
 * @returns {object|null} Decoded user object or null
 */
export function getUser() {
  if (!hasStorage()) return null;
  try {
    const raw = localStorage.getItem('ebtms_user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
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
 * Subscribes to session changes: called with the user after a (re)issue and
 * with null when the session ends. Returns an unsubscribe function.
 *
 * @param {(user: object|null) => void} listener
 */
export function subscribeSession(listener) {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

function notifySession(user) {
  sessionListeners.forEach((fn) => fn(user));
}

/** Drops all local session state; used when the refresh session is gone. */
function endSession() {
  setToken(null);
  setUser(null);
  notifySession(null);
}

/** Establishes the local session from a login/refresh response. */
export function startSession({ token, user }) {
  setToken(token);
  setUser(user);
  notifySession(user);
}

function tokenSecondsLeft(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.exp - Date.now() / 1000;
  } catch {
    return 0;
  }
}

function buildError(res, data, fallback) {
  const error = new Error((data && data.error) || res.statusText || fallback);
  error.status = res.status;
  error.data = data;
  return error;
}

/**
 * Exchanges the refresh cookie for a new access token. Concurrent callers
 * share one in-flight request, so a burst of expired requests triggers a
 * single refresh (the server rotates the cookie on each use).
 *
 * Resolves with the new access token. Rejects with status 401 when the
 * refresh session is invalid/expired/revoked -- the local session is cleared
 * -- and with a plain error (session kept) for network/server failures.
 *
 * @returns {Promise<string>}
 */
export function refreshSession() {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const res = await fetch(`${BASE_URL}/auth/refresh`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: CSRF_HEADERS,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) endSession();
        throw buildError(res, data, 'Session refresh failed');
      }
      startSession(data);
      return data.token;
    })().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

/**
 * Restores a session on application startup from the refresh cookie.
 * Resolves with the user, or null when there is no valid session. On a
 * network/server error the cached user (if any) is returned and requests
 * will retry the refresh on their first 401.
 *
 * @returns {Promise<object|null>}
 */
export async function restoreSession() {
  try {
    await refreshSession();
    return getUser();
  } catch (err) {
    if (err.status === 401) return null;
    return getUser();
  }
}

/**
 * Ends the session on the server (revoking the refresh session and clearing
 * its cookie) and locally. Local state is cleared even if the call fails.
 */
export async function logoutSession() {
  try {
    await fetch(`${BASE_URL}/auth/logout`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: CSRF_HEADERS,
    });
  } catch {
    // Offline: still sign out locally.
  } finally {
    endSession();
  }
}

/**
 * fetch() wrapper for every authenticated API call: attaches the access
 * token, refreshes it proactively near expiry, and on a 401 refreshes and
 * retries the original request exactly once. If the refresh session is dead
 * the local session is cleared and the 401 error is thrown.
 *
 * @param {string} path - API path under /api (e.g. '/tyres')
 * @param {RequestInit} [init] - fetch options (body must be re-sendable: JSON string or FormData)
 * @returns {Promise<Response>}
 */
export async function authFetch(path, init = {}) {
  const isAuthPath = path.startsWith('/auth/');

  if (accessToken && !isAuthPath && tokenSecondsLeft(accessToken) < REFRESH_SKEW_SECONDS) {
    try {
      await refreshSession();
    } catch (err) {
      if (err.status === 401) throw err;
      // Transient failure: fall through and let the request itself decide.
    }
  }

  const send = (token) => fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });

  const usedToken = accessToken;
  const res = await send(usedToken);
  if (res.status !== 401 || isAuthPath) return res;

  // If another request already renewed the token while this one was in
  // flight, just retry with it instead of refreshing again.
  const freshToken = accessToken && accessToken !== usedToken ? accessToken : await refreshSession();
  return send(freshToken);
}

/**
 * Core async wrapper sending HTTP requests to backend endpoints.
 *
 * @param {string} path - Target route suffix (e.g. '/tyres')
 * @param {object} [options] - Fetch config options
 * @returns {Promise<any>} Response payload JSON/text data
 */
async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await authFetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : await res.text();

  if (!res.ok) throw buildError(res, data, 'Request failed');

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
  const formData = new FormData();
  formData.append('file', file);

  const res = await authFetch(path, { method: 'POST', body: formData });

  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : await res.text();

  if (!res.ok) throw buildError(res, data, 'Upload failed');

  return data;
}

/**
 * Attaches photos to an existing tyre event as multipart/form-data.
 *
 * @param {number} eventId - tyre_events id the photos belong to
 * @param {File[]} files - Already-compressed image files
 * @returns {Promise<any>} Parsed JSON response (created photo rows)
 */
export async function uploadEventPhotos(eventId, files) {
  const formData = new FormData();
  files.forEach((file) => formData.append('photos', file));

  const res = await authFetch(`/event-photos/events/${eventId}`, { method: 'POST', body: formData });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || 'Photo upload failed');
    error.status = res.status;
    throw error;
  }
  return data;
}

/**
 * Photos are served only to authenticated requests, so an <img src> can't
 * point at them directly -- fetch with the Bearer token and hand back an
 * object URL. The caller must URL.revokeObjectURL() it when done.
 *
 * @param {number} photoId - event_photos id
 * @returns {Promise<string>} Object URL for the image
 */
export async function fetchPhotoObjectUrl(photoId) {
  const res = await authFetch(`/event-photos/${photoId}/file`);
  if (!res.ok) throw new Error('Could not load photo');
  return URL.createObjectURL(await res.blob());
}

/**
 * Fetches an authenticated binary response (e.g. a PDF) as a Blob.
 *
 * @param {string} path - Target API segment
 * @param {string} failureMessage - Error text if the response is not ok
 * @returns {Promise<Blob>}
 */
export async function fetchBlob(path, failureMessage) {
  const res = await authFetch(path);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const error = new Error(data.error || failureMessage);
    error.status = res.status;
    throw error;
  }
  return res.blob();
}

/**
 * Handles binary report file downloads (PDF and Excel formats).
 *
 * @param {string} path - Target API segment
 * @param {string} filenameFallback - Fallback name if Content-Disposition is missing
 */
export async function downloadFile(path, filenameFallback) {
  const res = await authFetch(path);
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
