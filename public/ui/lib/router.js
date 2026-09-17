// Hash routes (#/machines, #/updates, #/machines/MARS-04 …) — no server config needed, and
// deep links survive the proxy and reloads.
import { signal } from '@preact/signals-core';

const parse = () => {
  const h = (location.hash || '').replace(/^#\/?/, '');
  const [path, query = ''] = h.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || 'machines', params: parts.slice(1), query: Object.fromEntries(new URLSearchParams(query)) };
};

export const route = signal(parse());
window.addEventListener('hashchange', () => { route.value = parse(); });

export function go(name, ...params) {
  location.hash = '#/' + [name, ...params].map(encodeURIComponent).join('/');
}
