'use strict';
// node --test test/   — the one-time clean-up in lib/db.js, on a database of its own (TRACKER_DB) laid out
// like the live one before it: jobs the old check-in correction credited by mistake.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rft-migration-'));
const file = path.join(dir, 'tracker.db');
const T0 = Date.parse('2026-10-06T22:06:03-07:00');
const VER = 'Verified on check-in: AVA-01 now reports nvidia 617.42 (target 617.42), so the install did take effect — later than the job\'s own check. The original report is below.\n--- original report ---\n';

{
  // The live schema as of 2026-10-09 (tracker.db, .schema), trimmed to what the clean-ups touch.
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, hostname TEXT NOT NULL UNIQUE, os TEXT NOT NULL, ip TEXT,
      agent_version TEXT, last_seen INTEGER, created_at INTEGER NOT NULL, elevated INTEGER, gpu TEXT, gpu_driver TEXT,
      disk_free_gb REAL, disk_total_gb REAL, os_version TEXT, pending_reboot INTEGER, macs TEXT, gpu_util INTEGER,
      wol_ready INTEGER, wol_info TEXT, deadline_info TEXT, deadline_fix TEXT, license_info TEXT, license_action TEXT);
    CREATE TABLE products (key TEXT PRIMARY KEY, name TEXT NOT NULL, latest_version TEXT, notes TEXT, updated_at INTEGER);
    CREATE TABLE packages (id INTEGER PRIMARY KEY AUTOINCREMENT, product_key TEXT NOT NULL, version TEXT NOT NULL, os TEXT NOT NULL,
      filename TEXT NOT NULL, install_command TEXT NOT NULL, created_at INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'installer');
    CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, package_id INTEGER NOT NULL, node_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', log TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      install_ms INTEGER, started_at INTEGER, cancel_requested_at INTEGER, rollout_id INTEGER);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL);
    CREATE TABLE metric_farm (ts INTEGER PRIMARY KEY, total INTEGER, online INTEGER, rendering INTEGER, updating INTEGER,
      gpu_avg REAL, deadline_down INTEGER);
    CREATE TABLE node_timeline (id INTEGER PRIMARY KEY AUTOINCREMENT, node_id INTEGER NOT NULL, kind TEXT NOT NULL, ts INTEGER NOT NULL,
      end_ts INTEGER, state TEXT, detail TEXT, ref TEXT UNIQUE);
    CREATE TABLE remote_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, node_id INTEGER NOT NULL, command TEXT NOT NULL, status TEXT NOT NULL,
      exit_code INTEGER, output TEXT, created_at INTEGER NOT NULL, done_at INTEGER);
  `);
  const node = old.prepare('INSERT INTO nodes (id, hostname, os, created_at, deadline_info, deadline_fix) VALUES (?, ?, ?, ?, ?, ?)');
  node.run(28, 'AVA-01', 'windows', T0, '{"ok":true}', '{"ok":true}');
  node.run(21, 'Node-04', 'windows', T0, '{"ok":true}', null);
  node.run(11, 'MINIPC-01', 'windows', T0, null, null);
  old.prepare("INSERT INTO packages (id, product_key, version, os, filename, install_command, created_at) VALUES (1, 'nvidia', '617.42', 'windows', 'nv.exe', 'x', ?)").run(T0);
  old.prepare("INSERT INTO packages (id, product_key, version, os, filename, install_command, created_at) VALUES (2, 'creativecloud', '6.10.0.253', 'windows', 'cc.exe', 'x', ?)").run(T0);
  const job = old.prepare('INSERT INTO jobs (id, package_id, node_id, status, log, created_at, updated_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  job.run(586, 1, 28, 'success', `${VER}Command timed out after 3600s`, T0, T0 + 68 * 60000, T0 + 60000);
  for (let id = 588; id <= 590; id++) job.run(id, 1, 28, 'success', `${VER}Download failed: [Errno 28] No space left on device`, T0, T0 + 70 * 60000, T0 + 61 * 60000);
  job.run(722, 1, 28, 'success', 'Installed: 616.92 -> 617.42', T0, T0 + 17 * 3600000, T0 + 17 * 3600000);   // what really did it
  job.run(725, 1, 21, 'success', `${VER.replace('AVA-01', 'Node-04')}\n[timed out: no agent progress — likely agent restart]`, T0, T0 + 48 * 3600000, null);
  job.run(484, 2, 28, 'success', `${VER}Command exited 0 but version unchanged`, T0, T0, T0);   // newest and ran: rightly credited
  const ins = old.prepare('INSERT INTO metric_farm (ts, total, online, deadline_down) VALUES (?, 30, 28, ?)');
  for (let i = 0; i < 50; i++) ins.run(T0 + i * 60000, i % 3);
  const tl = old.prepare('INSERT INTO node_timeline (node_id, kind, ts, end_ts, state, detail) VALUES (?, ?, ?, ?, ?, ?)');
  tl.run(28, 'deadline', T0, T0 + 60000, null, null);
  tl.run(28, 'fix', T0, T0, 'ok', '{"message":"OK: Deadline now starts at logon of AVA-01\\\\trm"}');
  tl.run(28, 'install', T0, T0 + 60000, 'success', '{"product":"nvidia"}');
  tl.run(28, 'render', T0, T0 + 60000, null, '{"peak":90}');
  const run = old.prepare('INSERT INTO remote_runs (id, node_id, command, status, created_at) VALUES (?, ?, ?, ?, ?)');
  run.run(442, 11, 'powershell -NoProfile …', 'pending', Date.parse('2026-09-24T15:59:29-07:00'));
  run.run(443, 11, 'hostname', 'done', Date.parse('2026-09-24T16:00:00-07:00'));
  old.close();
}

process.env.TRACKER_DB = file;
const { db, _migrations } = require('../lib/db');

const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

test('jobs the old correction credited by mistake say so; their status and history stay', () => {
  const j = (id) => db.prepare('SELECT status, log, updated_at FROM jobs WHERE id = ?').get(id);
  for (const id of [586, 588, 589, 590]) {
    assert.equal(j(id).status, 'success', 'status left alone (Farmly announces status changes)');
    assert.match(j(id).log, /^\[Not this attempt \(noted \d{4}-\d\d-\d\d\): job #722 is the latest try of nvidia on AVA-01\./);
    assert.ok(j(id).log.includes(VER), 'the old text and the original report are kept');
  }
  assert.match(j(725).log, /^\[Not this attempt .*this job never started on Node-04/);
  assert.ok(j(484).log.startsWith('Verified on check-in:'), 'the newest job that ran was rightly credited: untouched');
  assert.ok(j(722).log.startsWith('Installed:'));
  assert.equal(j(588).updated_at, T0 + 70 * 60000, 'updated_at untouched');
  const ev = db.prepare("SELECT message FROM events WHERE message LIKE 'Job history:%'").all();
  assert.equal(ev.length, 1);
  assert.match(ev[0].message, /^Job history: 5 job\(s\) .*AVA-01 nvidia 617\.42 ×4, Node-04 nvidia 617\.42 ×1$/);
});

test('the clean-ups run once: a second boot changes nothing', () => {
  const before = db.prepare('SELECT id, log FROM jobs ORDER BY id').all();
  const events = db.prepare('SELECT COUNT(*) AS c FROM events').get().c;
  assert.deepEqual(_migrations.noteMiscredited(), []);
  assert.deepEqual(db.prepare('SELECT id, log FROM jobs ORDER BY id').all(), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM events').get().c, events);
  assert.ok(cols('jobs').includes('agent_seen_at'));
});

test.after(() => { try { db.close(); } catch { /* closed */ } fs.rmSync(dir, { recursive: true, force: true }); });
