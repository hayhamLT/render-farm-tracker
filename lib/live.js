'use strict';
// Live dashboard updates over Server-Sent Events.
//
// Rather than sprinkling "notify" calls across every place that writes to the database
// (easy to miss one), the server rebuilds the dashboard state and DIFFS it: each node, job,
// product, package and event is hashed, and only the items whose hash changed are pushed.
// A rebuild runs at most once per `intervalMs` while anyone is connected, and right away
// (debounced) after any request that can change something — so updates arrive in well under
// a second without any client polling.
//
// Wire format (text/event-stream):
//   event: snapshot   data: <full state>                 — on connect / reconnect
//   event: patch      data: {seq, now, <section>: {upsert: [...], remove: [...]}, settings?}
//   event: ping       data: {now}                         — every heartbeatMs (keeps proxies open)
const crypto = require('node:crypto');

const SECTIONS = [
  // [name in state, key field]
  ['products', 'key'],
  ['packages', 'id'],
  ['jobs', 'id'],
  ['events', 'id'],
];

const hash = (v) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('base64');

// Split a state object into hashed, keyed items. Node software lists are tracked separately
// from the rest of the node: last_seen changes every check-in, software rarely does.
function index(state) {
  const out = { nodes: new Map(), software: new Map() };
  for (const n of state.nodes) {
    const { software, ...rest } = n;
    out.nodes.set(n.id, { v: rest, h: hash(rest) });
    out.software.set(n.id, { v: { id: n.id, software }, h: hash(software) });
  }
  for (const [name, key] of SECTIONS) {
    out[name] = new Map(state[name].map((x) => [x[key], { v: x, h: hash(x) }]));
  }
  const { nodes, products, packages, jobs, events, now, ...settings } = state;
  out.settings = { v: settings, h: hash(settings) };
  return out;
}

function diff(prev, next) {
  const upsert = [];
  const remove = [];
  for (const [k, item] of next) {
    const old = prev.get(k);
    if (!old || old.h !== item.h) upsert.push(item.v);
  }
  for (const k of prev.keys()) if (!next.has(k)) remove.push(k);
  return upsert.length || remove.length ? { upsert, remove } : null;
}

function createLive({ buildState, intervalMs = 1000, heartbeatMs = 15000, maxBufferBytes = 8 * 1024 * 1024 }) {
  const clients = new Set();
  let last = null;
  let seq = 0;
  let lastBuild = 0;
  let pending = null;

  const send = (res, event, data) => {
    if (res.writableLength > maxBufferBytes) { res.end(); return; }   // stuck client: it reconnects and resyncs
    res.write(`id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  function tick() {
    pending = null;
    lastBuild = Date.now();
    if (!clients.size) { last = null; return; }
    let state;
    try { state = buildState(); } catch (e) { console.error('live: state build failed:', e.message); return; }
    const next = index(state);
    if (last) {
      const patch = {};
      for (const name of ['nodes', 'software', ...SECTIONS.map((s) => s[0])]) {
        const d = diff(last[name], next[name]);
        if (d) patch[name] = d;
      }
      if (last.settings.h !== next.settings.h) patch.settings = next.settings.v;
      if (Object.keys(patch).length) {
        seq++;
        const msg = { seq, now: state.now, ...patch };
        for (const res of clients) send(res, 'patch', msg);
      }
    }
    last = next;
  }

  // Something may have changed: rebuild ~150 ms from now (coalescing a burst of requests),
  // but never more than 4 rebuilds a second.
  const MIN_GAP_MS = 250;
  function poke(delayMs = 150) {
    if (pending || !clients.size) return;
    const wait = Math.max(delayMs, MIN_GAP_MS - (Date.now() - lastBuild));
    pending = setTimeout(tick, wait);
  }

  setInterval(() => { if (clients.size && !pending) tick(); }, intervalMs).unref();
  setInterval(() => { for (const res of clients) send(res, 'ping', { now: Date.now() }); }, heartbeatMs).unref();

  function handle(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',          // tell reverse proxies not to buffer the stream
    });
    res.write('retry: 3000\n\n');
    const state = buildState();
    if (!clients.size) last = index(state);   // first client: diffs start from this snapshot
    clients.add(res);
    send(res, 'snapshot', { seq, ...state });
    req.on('close', () => clients.delete(res));
  }

  return { handle, poke, clientCount: () => clients.size };
}

module.exports = { createLive, _internal: { index, diff } };
