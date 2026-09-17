'use strict';
// Farm metrics history, sampled once a minute, so the dashboard can chart real trends (online,
// rendering, updating, GPU load, Deadline health) instead of only the current moment.
//
//   metric_farm  — one row per minute for the whole farm, kept 14 days (~20k rows)
//   metric_node  — one row per minute per machine (GPU load + online), kept 48 hours
//
// GET /api/metrics?hours=N returns both, bucketed so a chart never gets more than ~180 points.
const { db } = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS metric_farm (
    ts INTEGER PRIMARY KEY, total INTEGER, online INTEGER, rendering INTEGER, updating INTEGER,
    gpu_avg REAL, deadline_down INTEGER
  );
  CREATE TABLE IF NOT EXISTS metric_node (
    ts INTEGER NOT NULL, node_id INTEGER NOT NULL, gpu_util INTEGER, online INTEGER,
    PRIMARY KEY (node_id, ts)
  );
  CREATE INDEX IF NOT EXISTS idx_metric_node_ts ON metric_node(ts);
`);

const MINUTE = 60 * 1000;
const FARM_KEEP = 14 * 24 * 60 * MINUTE;
const NODE_KEEP = 48 * 60 * MINUTE;

function sample({ offlineAfterMs, hiddenHost }) {
  const now = Date.now();
  const ts = now - (now % MINUTE);
  const nodes = db.prepare('SELECT id, hostname, last_seen, gpu_util, deadline_info FROM nodes').all()
    .filter((n) => !hiddenHost(n.hostname));
  const active = new Set(db.prepare(
    "SELECT DISTINCT node_id FROM jobs WHERE status IN ('downloading','installing')"
  ).all().map((r) => r.node_id));
  let online = 0; let rendering = 0; let updating = 0; let gpuSum = 0; let gpuN = 0; let dlDown = 0;
  const insNode = db.prepare('INSERT OR REPLACE INTO metric_node (ts, node_id, gpu_util, online) VALUES (?, ?, ?, ?)');
  for (const n of nodes) {
    const on = n.last_seen != null && now - n.last_seen < offlineAfterMs;
    const gpu = on && typeof n.gpu_util === 'number' ? n.gpu_util : null;
    if (on) online++;
    if (active.has(n.id)) updating++;
    else if (gpu != null && gpu >= 20) rendering++;
    if (gpu != null) { gpuSum += gpu; gpuN++; }
    if (on && n.deadline_info) {
      try { const d = JSON.parse(n.deadline_info); if (d.installed && !d.worker) dlDown++; } catch { /* ignore */ }
    }
    insNode.run(ts, n.id, gpu, on ? 1 : 0);
  }
  db.prepare('INSERT OR REPLACE INTO metric_farm (ts, total, online, rendering, updating, gpu_avg, deadline_down) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ts, nodes.length, online, rendering, updating, gpuN ? Math.round((gpuSum / gpuN) * 10) / 10 : null, dlDown);
  db.prepare('DELETE FROM metric_farm WHERE ts < ?').run(now - FARM_KEEP);
  db.prepare('DELETE FROM metric_node WHERE ts < ?').run(now - NODE_KEEP);
}

function startSampling(opts) {
  const run = () => { try { sample(opts); } catch (e) { console.error('metrics sample failed:', e.message); } };
  setTimeout(run, 5000);
  setInterval(run, MINUTE).unref();
}

// Bucket rows so a chart gets at most `points` values. Averages numbers; keeps the bucket start ts.
function bucketize(rows, fields, points, sinceTs) {
  if (!rows.length) return [];
  const span = Math.max(MINUTE, Date.now() - sinceTs);
  const size = Math.max(MINUTE, Math.ceil(span / points / MINUTE) * MINUTE);
  const out = new Map();
  for (const r of rows) {
    const b = r.ts - (r.ts % size);
    let acc = out.get(b);
    if (!acc) { acc = { ts: b, n: 0 }; for (const f of fields) { acc[f] = 0; acc[f + '_n'] = 0; } out.set(b, acc); }
    for (const f of fields) if (r[f] != null) { acc[f] += r[f]; acc[f + '_n']++; }
  }
  return [...out.values()].map((a) => {
    const o = { ts: a.ts };
    for (const f of fields) o[f] = a[f + '_n'] ? Math.round((a[f] / a[f + '_n']) * 10) / 10 : null;
    return o;
  });
}

function query(hours) {
  const h = Math.min(Math.max(Number(hours) || 24, 1), 14 * 24);
  const since = Date.now() - h * 60 * MINUTE;
  const farm = bucketize(
    db.prepare('SELECT * FROM metric_farm WHERE ts >= ? ORDER BY ts').all(since),
    ['total', 'online', 'rendering', 'updating', 'gpu_avg', 'deadline_down'], 180, since,
  );
  const nodeSince = Math.max(since, Date.now() - NODE_KEEP);
  const byNode = {};
  const rows = db.prepare('SELECT ts, node_id, gpu_util, online FROM metric_node WHERE ts >= ? ORDER BY ts').all(nodeSince);
  const grouped = new Map();
  for (const r of rows) { if (!grouped.has(r.node_id)) grouped.set(r.node_id, []); grouped.get(r.node_id).push(r); }
  for (const [id, list] of grouped) byNode[id] = bucketize(list, ['gpu_util', 'online'], 48, nodeSince).map((b) => [b.ts, b.gpu_util, b.online]);
  return { hours: h, farm, nodes: byNode };
}

module.exports = { startSampling, query, _internal: { sample, bucketize } };
