// HTTP helpers. Every URL is built from the tracker's root, derived from where this file was
// served — so the dashboard works both directly (http://host:4400/ui/) and embedded behind the
// watcher's proxy (https://…/tracker/ui/) without any URL rewriting.
export const ROOT = new URL('../../', import.meta.url);

export const url = (path) => new URL(path.replace(/^\//, ''), ROOT).toString();

export async function api(method, path, body) {
  const res = await fetch(url(path), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    // Behind deadlinefarm.com the session expired: send the whole window (not just the embedding
    // iframe) to the login page, and come back here afterwards.
    const top = window.top || window;
    top.location.href = '/login?next=' + encodeURIComponent(top.location.pathname + top.location.hash);
    throw new Error('Signed out — redirecting to login');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText || `HTTP ${res.status}`);
  return data;
}

export const get = (path) => api('GET', path);
export const post = (path, body) => api('POST', path, body || {});
export const put = (path, body) => api('PUT', path, body || {});
export const del = (path) => api('DELETE', path);
