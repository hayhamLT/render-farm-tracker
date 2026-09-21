'use strict';
// Durable instructions for machines, and Wake-on-LAN state. Everything here used to live
// in memory (Sets/Maps in server.js), so a tracker restart silently dropped a queued reboot
// or forgot that a machine was being woken. Now it's rows in SQLite.
//
//  node_commands: one row per instruction for a node (reboot | shutdown | wake_relay).
//    Handed to the agent on its next check-in (delivered_at stamped), or dropped once
//    expires_at passes undelivered — a reboot queued for a machine that never checks in
//    must not fire hours later.
//  wakes: the latest wake attempt per node (waking → woke | failed).
const { db } = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS node_commands (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id      INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,
    payload      TEXT,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    delivered_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_node_commands_undelivered ON node_commands(node_id, delivered_at);

  CREATE TABLE IF NOT EXISTS wakes (
    node_id      INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
    state        TEXT NOT NULL,          -- waking | woke | failed
    requested_at INTEGER NOT NULL,
    done_at      INTEGER,
    secs         INTEGER,
    relays       TEXT,                   -- JSON array of relay hostnames
    reason       TEXT
  );
`);

const TTL = { reboot: 15 * 60 * 1000, shutdown: 15 * 60 * 1000, wake_relay: 2 * 60 * 1000, run: 30 * 60 * 1000 };

db.exec(`
  CREATE TABLE IF NOT EXISTS remote_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    command     TEXT NOT NULL,
    status      TEXT NOT NULL,          -- pending | done
    exit_code   INTEGER,
    output      TEXT,
    created_at  INTEGER NOT NULL,
    done_at     INTEGER
  );
`);

function queue(nodeId, kind, payload) {
  const now = Date.now();
  db.prepare('INSERT INTO node_commands (node_id, kind, payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(nodeId, kind, payload == null ? null : JSON.stringify(payload), now, now + (TTL[kind] || 15 * 60 * 1000));
}

// Undelivered, unexpired commands for a node — marked delivered as they're handed out.
function take(nodeId) {
  const now = Date.now();
  const rows = db.prepare(
    'SELECT * FROM node_commands WHERE node_id = ? AND delivered_at IS NULL AND expires_at > ? ORDER BY id'
  ).all(nodeId, now);
  if (rows.length) {
    db.prepare(`UPDATE node_commands SET delivered_at = ? WHERE id IN (${rows.map(() => '?').join(',')})`)
      .run(now, ...rows.map((r) => r.id));
  }
  return rows.map((r) => ({ kind: r.kind, payload: r.payload ? JSON.parse(r.payload) : null }));
}

function hasPending(nodeId, kind) {
  return !!db.prepare(
    'SELECT 1 FROM node_commands WHERE node_id = ? AND kind = ? AND delivered_at IS NULL AND expires_at > ?'
  ).get(nodeId, kind, Date.now());
}

// Housekeeping: forget expired and long-delivered commands.
function sweep() {
  const now = Date.now();
  db.prepare('DELETE FROM node_commands WHERE (delivered_at IS NULL AND expires_at <= ?) OR delivered_at < ?')
    .run(now, now - 7 * 24 * 3600 * 1000);
}

// ---- wakes ----
const wakeRow = (r) => r && {
  state: r.state, requestedAt: r.requested_at, doneAt: r.done_at, secs: r.secs,
  relays: r.relays ? JSON.parse(r.relays) : [], reason: r.reason,
};
function getWake(nodeId) { return wakeRow(db.prepare('SELECT * FROM wakes WHERE node_id = ?').get(nodeId)); }
function allWakes() {
  const m = new Map();
  for (const r of db.prepare('SELECT * FROM wakes').all()) m.set(r.node_id, wakeRow(r));
  return m;
}
function startWakeRow(nodeId, relays) {
  db.prepare(`INSERT INTO wakes (node_id, state, requested_at, relays) VALUES (?, 'waking', ?, ?)
              ON CONFLICT(node_id) DO UPDATE SET state='waking', requested_at=excluded.requested_at,
                done_at=NULL, secs=NULL, relays=excluded.relays, reason=NULL`)
    .run(nodeId, Date.now(), JSON.stringify(relays || []));
}
function finishWake(nodeId, state, fields) {
  db.prepare('UPDATE wakes SET state = ?, done_at = ?, secs = ?, reason = ? WHERE node_id = ?')
    .run(state, Date.now(), fields.secs ?? null, fields.reason ?? null, nodeId);
}
function deleteWake(nodeId) { db.prepare('DELETE FROM wakes WHERE node_id = ?').run(nodeId); }

module.exports = { queue, take, hasPending, sweep, getWake, allWakes, startWakeRow, finishWake, deleteWake };
