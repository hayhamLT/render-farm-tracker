'use strict';
// Per-machine history: what each machine was doing, when. Spans (offline, rendering, installing,
// Deadline down, restart pending) plus moments (restart/shutdown/wake, agent or driver changes,
// Deadline fixes). Kept 30 days, so "what happened to MARS-05 on Tuesday night?" has an answer
// even after the activity log (last 500 events) and finished jobs have been cleared.
//
//   node_timeline — one row per span or moment. end_ts NULL = still going. A moment has end_ts = ts.
//                   ref makes a row idempotent (install spans use "job:<id>").
//
// Spans are written by tick(), once a minute, by comparing each machine's current row with the
// open spans; moments are written by note() at the place they happen (server.js).
const { db } = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS node_timeline (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    kind    TEXT NOT NULL,     -- offline | render | install | deadline | reboot | power | agent | driver | fix
    ts      INTEGER NOT NULL,
    end_ts  INTEGER,
    state   TEXT,              -- install: running|success|failed|cancelled; power: restart|shutdown|wake|woke|nowake; fix: ok|failed
    detail  TEXT,              -- JSON
    ref     TEXT UNIQUE
  );
  CREATE INDEX IF NOT EXISTS idx_node_timeline_node ON node_timeline(node_id, ts);
  CREATE INDEX IF NOT EXISTS idx_node_timeline_open ON node_timeline(end_ts);
`);

const MINUTE = 60 * 1000;
const KEEP = 30 * 24 * 60 * MINUTE;
const RENDER_GPU = 20;          // same threshold the dashboard uses for "Rendering"
const SPAN_KINDS = ['offline', 'render', 'deadline', 'reboot'];

const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };

function note(nodeId, kind, state, detail, ts = Date.now()) {
  if (!nodeId) return;
  try {
    db.prepare('INSERT INTO node_timeline (node_id, kind, ts, end_ts, state, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(nodeId, kind, ts, ts, state || null, detail ? JSON.stringify(detail) : null);
  } catch (e) { console.error('timeline note failed:', e.message); }
}

// Last-known agent / driver per machine, to spot changes. Seeded from the database on the first
// tick (so a restart of the tracker doesn't record every machine as "changed").
let known = null;

function tick({ offlineAfterMs, hiddenHost }) {
  const now = Date.now();
  const nodes = db.prepare('SELECT * FROM nodes').all().filter((n) => !hiddenHost(n.hostname));
  const open = new Map();   // `${node}:${kind}` -> row
  for (const r of db.prepare("SELECT * FROM node_timeline WHERE end_ts IS NULL AND kind != 'install'").all()) {
    open.set(`${r.node_id}:${r.kind}`, r);
  }
  const start = db.prepare('INSERT INTO node_timeline (node_id, kind, ts, state, detail) VALUES (?, ?, ?, ?, ?)');
  const close = db.prepare('UPDATE node_timeline SET end_ts = ? WHERE id = ?');
  const setDetail = db.prepare('UPDATE node_timeline SET detail = ? WHERE id = ?');
  const firstTick = !known;
  if (firstTick) known = new Map();

  for (const n of nodes) {
    const on = n.last_seen != null && now - n.last_seen < offlineAfterMs;
    const lastSeen = n.last_seen || now;
    const dl = parse(n.deadline_info);
    const want = {
      offline: !on && n.last_seen != null,
      render: on && typeof n.gpu_util === 'number' && n.gpu_util >= RENDER_GPU,
      deadline: on && !!dl && !!dl.installed && !dl.worker,
      reboot: on && !!n.pending_reboot,
    };
    for (const kind of SPAN_KINDS) {
      const row = open.get(`${n.id}:${kind}`);
      if (want[kind] && !row) {
        // An offline span starts when the machine was last heard from, not when we noticed.
        const ts = kind === 'offline' ? lastSeen : now;
        const detail = kind === 'render' ? { peak: n.gpu_util, sum: n.gpu_util, n: 1 } : null;
        start.run(n.id, kind, ts, null, detail ? JSON.stringify(detail) : null);
      } else if (!want[kind] && row) {
        // Anything that stops because the machine went quiet ends at its last check-in. A span
        // that turns out to have no length (it opened after the last check-in) is dropped.
        const end = kind === 'offline' ? now : Math.min(now, lastSeen);
        if (end > row.ts) close.run(end, row.id);
        else db.prepare('DELETE FROM node_timeline WHERE id = ?').run(row.id);
      } else if (want[kind] && row && kind === 'render') {
        const d = parse(row.detail) || { peak: 0, sum: 0, n: 0 };
        d.peak = Math.max(d.peak || 0, n.gpu_util); d.sum = (d.sum || 0) + n.gpu_util; d.n = (d.n || 0) + 1;
        setDetail.run(JSON.stringify(d), row.id);
      }
    }

    // Agent / GPU driver changes.
    const prev = known.get(n.id);
    if (prev && on) {
      if (n.agent_version && prev.agent && n.agent_version !== prev.agent) note(n.id, 'agent', null, { from: prev.agent, to: n.agent_version }, now);
      if (n.gpu_driver && prev.driver && n.gpu_driver !== prev.driver) note(n.id, 'driver', null, { from: prev.driver, to: n.gpu_driver }, now);
    }
    if (!prev && firstTick) {
      const last = (kind) => db.prepare('SELECT detail FROM node_timeline WHERE node_id = ? AND kind = ? ORDER BY ts DESC LIMIT 1').get(n.id, kind);
      const a = parse(last('agent')?.detail); const d = parse(last('driver')?.detail);
      known.set(n.id, { agent: (a && a.to) || n.agent_version, driver: (d && d.to) || n.gpu_driver });
      // A change that happened while the tracker was down still gets recorded, once.
      const k = known.get(n.id);
      if (on && n.agent_version && k.agent !== n.agent_version) note(n.id, 'agent', null, { from: k.agent, to: n.agent_version }, now);
      if (on && n.gpu_driver && k.driver !== n.gpu_driver) note(n.id, 'driver', null, { from: k.driver, to: n.gpu_driver }, now);
    }
    known.set(n.id, {
      agent: n.agent_version || (prev && prev.agent),
      driver: n.gpu_driver || (prev && prev.driver),
    });
  }

  trackInstalls(now);
  db.prepare('DELETE FROM node_timeline WHERE end_ts IS NOT NULL AND end_ts < ?').run(now - KEEP);
}

// Install spans follow the jobs table: a span opens when a job starts downloading/installing and
// closes with its result. Jobs that start and finish between two ticks still get a span.
let lastInstallTick = Date.now() - 2 * MINUTE;
function trackInstalls(now) {
  const jobSql = `SELECT j.id, j.node_id, j.status, j.created_at, j.updated_at, p.product_key, p.version
                    FROM jobs j JOIN packages p ON p.id = j.package_id`;
  const openSpan = db.prepare("INSERT OR IGNORE INTO node_timeline (node_id, kind, ts, end_ts, state, detail, ref) VALUES (?, 'install', ?, ?, ?, ?, ?)");
  for (const j of db.prepare(`${jobSql} WHERE j.status IN ('downloading','installing')`).all()) {
    openSpan.run(j.node_id, now, null, 'running', JSON.stringify({ product: j.product_key, version: j.version, job: j.id }), `job:${j.id}`);
  }
  // Close finished ones.
  for (const r of db.prepare("SELECT * FROM node_timeline WHERE kind = 'install' AND end_ts IS NULL").all()) {
    const id = Number(String(r.ref || '').slice(4));
    const j = db.prepare(`${jobSql} WHERE j.id = ?`).get(id);
    if (j && ['downloading', 'installing'].includes(j.status)) continue;
    const end = j ? Math.max(r.ts, j.updated_at) : now;
    db.prepare('UPDATE node_timeline SET end_ts = ?, state = ? WHERE id = ?')
      .run(end, j ? (j.status === 'pending' ? 'cancelled' : j.status) : 'cancelled', r.id);
  }
  // Quick jobs that came and went between ticks, and later corrections (failed → success).
  for (const j of db.prepare(`${jobSql} WHERE j.status IN ('success','failed') AND j.updated_at >= ?`).all(lastInstallTick - MINUTE)) {
    const ref = `job:${j.id}`;
    const row = db.prepare('SELECT id, state FROM node_timeline WHERE ref = ?').get(ref);
    if (!row) {
      openSpan.run(j.node_id, Math.max(j.created_at, j.updated_at - MINUTE), j.updated_at, j.status,
        JSON.stringify({ product: j.product_key, version: j.version, job: j.id }), ref);
    } else if (row.state !== j.status) {
      db.prepare('UPDATE node_timeline SET state = ? WHERE id = ?').run(j.status, row.id);
    }
  }
  lastInstallTick = now;
}

// One-time backfill when the table is new: offline/render spans from the per-minute GPU samples
// (last 48 h) and install spans from the jobs still on record.
function backfill(offlineAfterMs) {
  if (db.prepare('SELECT 1 FROM node_timeline LIMIT 1').get()) return;
  const rows = db.prepare('SELECT ts, node_id, gpu_util, online FROM metric_node ORDER BY node_id, ts').all();
  const ins = db.prepare('INSERT INTO node_timeline (node_id, kind, ts, end_ts, state, detail) VALUES (?, ?, ?, ?, NULL, ?)');
  const byNode = new Map();
  for (const r of rows) { if (!byNode.has(r.node_id)) byNode.set(r.node_id, []); byNode.get(r.node_id).push(r); }
  const last = rows.length ? Math.max(...rows.map((r) => r.ts)) : 0;
  for (const [id, list] of byNode) {
    let off = null; let ren = null;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      // A gap in the samples (tracker down) ends whatever was going on.
      const gap = i > 0 && r.ts - list[i - 1].ts > 5 * MINUTE;
      if (gap) {
        if (off) { ins.run(id, 'offline', off, list[i - 1].ts + MINUTE, null); off = null; }
        if (ren) { ins.run(id, 'render', ren.ts, list[i - 1].ts + MINUTE, JSON.stringify(ren.d)); ren = null; }
      }
      if (!r.online && off == null) off = r.ts;
      if (r.online && off != null) { ins.run(id, 'offline', off, r.ts, null); off = null; }
      const rendering = r.online && r.gpu_util != null && r.gpu_util >= RENDER_GPU;
      if (rendering && !ren) ren = { ts: r.ts, d: { peak: r.gpu_util, sum: r.gpu_util, n: 1 } };
      else if (rendering) { ren.d.peak = Math.max(ren.d.peak, r.gpu_util); ren.d.sum += r.gpu_util; ren.d.n++; }
      else if (ren) { ins.run(id, 'render', ren.ts, r.ts, JSON.stringify(ren.d)); ren = null; }
    }
    // Still going at the last sample: leave open only if it's recent; tick() takes it from there.
    const lastTs = list[list.length - 1].ts;
    const recent = Date.now() - last < 3 * MINUTE && lastTs === last;
    if (off != null) db.prepare('INSERT INTO node_timeline (node_id, kind, ts, end_ts) VALUES (?, ?, ?, ?)').run(id, 'offline', off, recent ? null : lastTs + MINUTE);
    if (ren) db.prepare('INSERT INTO node_timeline (node_id, kind, ts, end_ts, detail) VALUES (?, ?, ?, ?, ?)').run(id, 'render', ren.ts, recent ? null : lastTs + MINUTE, JSON.stringify(ren.d));
  }
  const jobs = db.prepare(`SELECT j.id, j.node_id, j.status, j.created_at, j.updated_at, p.product_key, p.version
                             FROM jobs j JOIN packages p ON p.id = j.package_id WHERE j.status IN ('success','failed','cancelled')`).all();
  const insJob = db.prepare("INSERT OR IGNORE INTO node_timeline (node_id, kind, ts, end_ts, state, detail, ref) VALUES (?, 'install', ?, ?, ?, ?, ?)");
  for (const j of jobs) {
    // Only the queue time and finish time are known for these, not when the install really started:
    // draw a short bar ending at the finish and flag it, so no duration is claimed.
    const ts = Math.max(j.created_at, j.updated_at - 10 * MINUTE);
    insJob.run(j.node_id, ts, Math.max(ts, j.updated_at), j.status, JSON.stringify({ product: j.product_key, version: j.version, job: j.id, approx: true }), `job:${j.id}`);
  }
  void offlineAfterMs;
}

function start(opts) {
  try { backfill(opts.offlineAfterMs); } catch (e) { console.error('timeline backfill failed:', e.message); }
  const run = () => { try { tick(opts); } catch (e) { console.error('timeline tick failed:', e.message); } };
  setTimeout(run, 7000);
  setInterval(run, MINUTE).unref();
}

// Everything overlapping [now - hours, now], grouped by machine. Rows are compact arrays:
// [kind, ts, end (null = ongoing), state, detail]
function query(hours, nodeId) {
  const h = Math.min(Math.max(Number(hours) || 24, 1), 30 * 24);
  const now = Date.now();
  const from = now - h * 60 * MINUTE;
  const args = [now, from];
  let sql = 'SELECT node_id, kind, ts, end_ts, state, detail FROM node_timeline WHERE ts <= ? AND (end_ts IS NULL OR end_ts >= ?)';
  if (nodeId) { sql += ' AND node_id = ?'; args.push(Number(nodeId)); }
  sql += ' ORDER BY ts';
  const nodes = {};
  for (const r of db.prepare(sql).all(...args)) {
    (nodes[r.node_id] ||= []).push([r.kind, r.ts, r.end_ts, r.state, parse(r.detail)]);
  }
  const first = db.prepare('SELECT MIN(ts) AS t FROM node_timeline').get();
  return { hours: h, from, to: now, since: first && first.t, nodes };
}

module.exports = { start, note, query, _internal: { tick, backfill } };
