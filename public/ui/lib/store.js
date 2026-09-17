// The farm state, kept live. On load: a full /api/state fetch; then the /api/live stream
// (Server-Sent Events) sends a snapshot and patches with only what changed. If the stream drops,
// the store polls /api/state every 8 s until it reconnects — the UI never goes stale silently.
//
// Components read `farm.value` (a Preact signal) and re-render when it changes.
import { signal, computed, batch } from '@preact/signals-core';
import { get, url } from './api.js';

export const farm = signal(null);                 // the /api/state payload
export const link = signal({ mode: 'connecting', since: Date.now() });   // live | polling | offline | connecting

// SQLite ORDER BY compares bytes — match it so patched lists order exactly like a fresh fetch.
const byteCmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
const ORDER = {
  nodes: (a, b) => byteCmp(a.hostname, b.hostname),
  jobs: (a, b) => b.id - a.id,
  events: (a, b) => b.id - a.id,
  packages: (a, b) => b.created_at - a.created_at,
  products: (a, b) => byteCmp(a.name, b.name),
};
const KEY = { nodes: 'id', jobs: 'id', events: 'id', packages: 'id', products: 'key' };

export function applyPatch(state, patch) {
  const next = { ...state };
  if (patch.settings) Object.assign(next, patch.settings);
  if (patch.now) next.now = patch.now;
  for (const name of Object.keys(KEY)) {
    const d = patch[name];
    if (!d) continue;
    const key = KEY[name];
    const byKey = new Map(state[name].map((x) => [x[key], x]));
    for (const k of d.remove || []) byKey.delete(k);
    for (const item of d.upsert || []) {
      const prev = byKey.get(item[key]);
      // Nodes arrive without their software list (patched separately) — keep the previous one.
      byKey.set(item[key], name === 'nodes' && prev ? { ...item, software: prev.software } : item);
    }
    next[name] = [...byKey.values()].sort(ORDER[name]);
  }
  if (patch.software) {
    const sw = new Map((patch.software.upsert || []).map((x) => [x.id, x.software]));
    next.nodes = next.nodes.map((n) => (sw.has(n.id) ? { ...n, software: sw.get(n.id) } : n));
  }
  return next;
}

let es = null;
let lastMsg = 0;

async function poll() {
  try {
    const s = await get('/api/state');
    batch(() => {
      farm.value = s;
      if (link.value.mode !== 'live') link.value = { mode: 'polling', since: Date.now() };
    });
  } catch {
    if (link.value.mode !== 'live') link.value = { mode: 'offline', since: Date.now() };
  }
}

function connect() {
  if (!window.EventSource) return;
  es = new EventSource(url('/api/live'));
  const touch = () => {
    lastMsg = Date.now();
    if (link.value.mode !== 'live') link.value = { mode: 'live', since: Date.now() };
  };
  es.addEventListener('snapshot', (e) => { farm.value = JSON.parse(e.data); touch(); });
  es.addEventListener('patch', (e) => { if (farm.value) farm.value = applyPatch(farm.value, JSON.parse(e.data)); touch(); });
  es.addEventListener('ping', touch);
  es.onerror = () => { if (link.value.mode === 'live') link.value = { mode: 'polling', since: Date.now() }; };
}

// Refetch after the user's own actions so the result shows even if the stream is down.
export const refresh = poll;

export function start() {
  poll();
  connect();
  setInterval(() => {
    const silent = Date.now() - lastMsg > 45000;
    if (link.value.mode === 'live' && silent) link.value = { mode: 'polling', since: Date.now() };
    if (link.value.mode !== 'live') poll();
  }, 8000);
}

// Handy derived lookups.
export const nodesById = computed(() => new Map((farm.value?.nodes || []).map((n) => [n.id, n])));
export const productsByKey = computed(() => new Map((farm.value?.products || []).map((p) => [p.key, p])));
