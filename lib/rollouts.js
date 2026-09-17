'use strict';
// Rollouts: a named group of install jobs that can start later (e.g. tonight at 2 AM), only on
// idle machines, wake sleeping machines first, stop handing out installs at a "finish by" time
// (and carry on the next night), and report to Slack when they're done.
//
//   rollouts      — one row per rollout (scheduled → running → done | cancelled; running can
//                   pause back to scheduled when its window ends and it continues next night)
//   jobs.rollout_id — the jobs that belong to it. Their status stays 'pending' until the
//                   rollout runs; dispatch() decides whether a pending job may be handed out.
//
// Every "Update" from the dashboard creates a rollout (run_at = now for "Update now"), so
// every batch gets the same grouping and end-of-rollout report.
const { db, logEvent } = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS rollouts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    run_at      INTEGER NOT NULL,          -- when installs may start
    finish_by   INTEGER,                   -- stop handing out new installs after this (null = no limit)
    next_night  INTEGER NOT NULL DEFAULT 1,-- at finish_by, continue the next day (1) or stop the rest (0)
    idle_only   INTEGER NOT NULL DEFAULT 1,-- only start on a machine whose GPU isn't busy
    wake        INTEGER NOT NULL DEFAULT 0,-- Wake-on-LAN offline targets at start
    report      INTEGER NOT NULL DEFAULT 1,-- Slack summary when finished
    status      TEXT NOT NULL,             -- scheduled | running | done | cancelled
    started_at  INTEGER,
    finished_at INTEGER,
    nights      INTEGER NOT NULL DEFAULT 0,
    summary     TEXT                       -- JSON {success:[host], failed:[{host,app}], cancelled:[host]}
  );
`);
try { db.exec('ALTER TABLE jobs ADD COLUMN rollout_id INTEGER'); } catch { /* exists */ }
db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_rollout ON jobs(rollout_id)');

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const RENDER_GPU = 20;
const MAX_NIGHTS = 7;           // a rollout that keeps missing machines stops trying after a week
const ACTIVE = "('pending','downloading','installing')";

const get = (id) => db.prepare('SELECT * FROM rollouts WHERE id = ?').get(Number(id));
const fmt = (ts) => new Date(ts).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

function createRollouts({ notify, startWake, offlineMs, productName }) {
  function create(b) {
    const now = Date.now();
    const runAt = Number(b.run_at) > now ? Math.round(Number(b.run_at)) : now;
    let finishBy = b.finish_by != null && Number(b.finish_by) > 0 ? Math.round(Number(b.finish_by)) : null;
    while (finishBy != null && finishBy <= runAt) finishBy += DAY;   // "2:00 → 6:00" means the next 6:00 after the start
    const scheduled = runAt > now + 30 * 1000;
    const r = db.prepare(`INSERT INTO rollouts (name, created_at, run_at, finish_by, next_night, idle_only, wake, report, status, started_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      String(b.name || 'Rollout').slice(0, 200), now, runAt, finishBy,
      b.next_night === false ? 0 : 1, b.idle_only === false ? 0 : 1, b.wake ? 1 : 0, b.report === false ? 0 : 1,
      scheduled ? 'scheduled' : 'running', scheduled ? null : now,
    );
    return get(r.lastInsertRowid);
  }

  const jobsOf = (id) => db.prepare(
    `SELECT j.id, j.status, j.node_id, n.hostname, n.last_seen, n.macs, p.product_key
       FROM jobs j JOIN nodes n ON n.id = j.node_id JOIN packages p ON p.id = j.package_id WHERE j.rollout_id = ?`
  ).all(id);

  // May this pending job be handed to this machine right now?
  function allows(job, node) {
    if (!job.rollout_id) return true;
    const r = get(job.rollout_id);
    if (!r) return true;
    if (r.status !== 'running') return false;
    if (r.idle_only && typeof node.gpu_util === 'number' && node.gpu_util >= RENDER_GPU) return false;
    return true;
  }

  function begin(r, now) {
    db.prepare("UPDATE rollouts SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?").run(now, r.id);
    // Pending jobs waited for the start; reset their clock so the stale-queue reaper doesn't
    // count the wait against them.
    db.prepare("UPDATE jobs SET updated_at = ? WHERE rollout_id = ? AND status = 'pending'").run(now, r.id);
    const pending = jobsOf(r.id).filter((j) => j.status === 'pending');
    const hosts = [...new Set(pending.map((j) => j.hostname))];
    const woken = [];
    if (r.wake) {
      const seen = new Set();
      for (const j of pending) {
        if (seen.has(j.node_id)) continue;
        seen.add(j.node_id);
        const on = j.last_seen != null && now - j.last_seen < offlineMs();
        if (on || !j.macs) continue;
        try { startWake(j.node_id); woken.push(j.hostname); } catch { /* no MAC / not wakeable */ }
      }
    }
    const msg = `Rollout started: ${r.name} — ${hosts.length} machine${hosts.length === 1 ? '' : 's'}${woken.length ? `, waking ${woken.join(', ')}` : ''}`;
    logEvent('deploy', msg);
    if (r.started_at == null || r.nights > 0) notify(`▶️ ${msg}`);
  }

  function finish(r, now, why) {
    const jobs = jobsOf(r.id);
    const by = (st) => [...new Set(jobs.filter((j) => j.status === st).map((j) => j.hostname))];
    const failed = jobs.filter((j) => j.status === 'failed').map((j) => ({ host: j.hostname, app: productName(j.product_key) }));
    const summary = { success: by('success'), failed, cancelled: by('cancelled'), total: jobs.length };
    db.prepare("UPDATE rollouts SET status = 'done', finished_at = ?, summary = ? WHERE id = ?").run(now, JSON.stringify(summary), r.id);
    const took = r.started_at ? Math.round((now - r.started_at) / MIN) : 0;
    const line = `${r.name}: ${summary.success.length} installed, ${failed.length} failed${summary.cancelled.length ? `, ${summary.cancelled.length} stopped` : ''}`;
    logEvent('deploy', `Rollout finished — ${line}${why ? ` (${why})` : ''}`);
    if (r.report && jobs.length) {
      const icon = failed.length ? '⚠️' : '✅';
      const lines = [`${icon} *Rollout finished* — ${line}${took ? ` in ${took >= 60 ? `${Math.floor(took / 60)}h ${took % 60}m` : `${took}m`}` : ''}${why ? ` (${why})` : ''}`];
      if (failed.length) lines.push(`Failed: ${failed.map((f) => `${f.host} (${f.app})`).join(', ')}`);
      if (summary.cancelled.length) lines.push(`Stopped: ${summary.cancelled.join(', ')}`);
      notify(lines.join('\n'));
    }
  }

  function tick() {
    const now = Date.now();
    for (const r of db.prepare("SELECT * FROM rollouts WHERE status IN ('scheduled','running')").all()) {
      const jobs = jobsOf(r.id);
      const open = jobs.filter((j) => ['pending', 'downloading', 'installing'].includes(j.status));
      // A rollout nothing was ever queued into (every machine already current) just goes away.
      if (!jobs.length) {
        if (now - r.created_at > 5 * MIN) db.prepare('DELETE FROM rollouts WHERE id = ?').run(r.id);
        continue;
      }
      if (r.status === 'scheduled') {
        if (now >= r.run_at) begin(r, now);
        continue;
      }
      if (!open.length) { finish(r, now); continue; }
      // Window over: machines already installing finish; the rest wait for tomorrow or stop.
      if (r.finish_by && now >= r.finish_by) {
        const waiting = open.filter((j) => j.status === 'pending');
        if (!waiting.length) continue;               // only running installs left — let them finish
        if (r.next_night && r.nights < MAX_NIGHTS) {
          db.prepare("UPDATE rollouts SET status = 'scheduled', run_at = run_at + ?, finish_by = finish_by + ?, nights = nights + 1 WHERE id = ?")
            .run(DAY * Math.max(1, Math.ceil((now - r.finish_by + 1) / DAY)), DAY * Math.max(1, Math.ceil((now - r.finish_by + 1) / DAY)), r.id);
          const next = get(r.id);
          const done = jobs.filter((j) => j.status === 'success').length;
          const msg = `Rollout paused for tonight: ${r.name} — ${done}/${jobs.length} done, ${waiting.length} continue ${fmt(next.run_at)}`;
          logEvent('deploy', msg);
          if (r.report) notify(`🌙 ${msg}`);
        } else {
          const why = r.next_night ? `gave up after ${MAX_NIGHTS} nights` : 'window ended';
          const stop = db.prepare("UPDATE jobs SET status = 'cancelled', log = COALESCE(log,'') || ?, updated_at = ? WHERE id = ? AND status = 'pending'");
          for (const j of waiting) stop.run(`\n[Not started: the rollout ${why} — the machine was offline, busy or behind a paused update]`, now, j.id);
          if (open.length === waiting.length) finish(get(r.id), now, why);
        }
      }
    }
    // Keep 60 days of finished rollouts.
    db.prepare("DELETE FROM rollouts WHERE status IN ('done','cancelled') AND COALESCE(finished_at, created_at) < ?").run(now - 60 * DAY);
  }

  function cancel(id) {
    const r = get(id);
    if (!r) throw new Error('no such rollout');
    if (!['scheduled', 'running'].includes(r.status)) throw new Error(`rollout is already ${r.status}`);
    const now = Date.now();
    const n = db.prepare("UPDATE jobs SET status = 'cancelled', log = COALESCE(log,'') || ?, updated_at = ? WHERE rollout_id = ? AND status = 'pending'")
      .run('\n[Not started: the rollout was cancelled]', now, r.id).changes;
    db.prepare("UPDATE rollouts SET status = 'cancelled', finished_at = ? WHERE id = ?").run(now, r.id);
    logEvent('deploy', `Rollout cancelled: ${r.name} (${n} queued install${n === 1 ? '' : 's'} removed; running installs finish)`);
    return { removed: n };
  }

  function startNow(id) {
    const r = get(id);
    if (!r || r.status !== 'scheduled') throw new Error('only a scheduled rollout can be started now');
    const now = Date.now();
    const shift = Math.max(0, r.run_at - now);
    db.prepare('UPDATE rollouts SET run_at = ?, finish_by = CASE WHEN finish_by IS NULL THEN NULL ELSE finish_by - ? END WHERE id = ?').run(now, shift, r.id);
    // Starting early keeps the same window length; a window that would already be over is dropped.
    const after = get(r.id);
    if (after.finish_by != null && after.finish_by <= now) db.prepare('UPDATE rollouts SET finish_by = NULL WHERE id = ?').run(r.id);
    begin(get(r.id), now);
    return get(r.id);
  }

  // For the dashboard: open rollouts plus the last week's finished ones, with live counts.
  function list() {
    const now = Date.now();
    return db.prepare(`SELECT * FROM rollouts WHERE status IN ('scheduled','running') OR COALESCE(finished_at, created_at) > ? ORDER BY id DESC LIMIT 30`)
      .all(now - 7 * DAY)
      .map((r) => {
        const c = db.prepare(`SELECT COUNT(*) AS total, SUM(status='success') AS success, SUM(status='failed') AS failed,
                                     SUM(status='cancelled') AS cancelled, SUM(status='pending') AS pending,
                                     SUM(status IN ('downloading','installing')) AS running, COUNT(DISTINCT node_id) AS machines
                                FROM jobs WHERE rollout_id = ?`).get(r.id);
        const counts = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v || 0]));
        let summary = null; try { summary = r.summary ? JSON.parse(r.summary) : null; } catch { /* ignore */ }
        return { ...r, summary, counts };
      })
      .filter((r) => r.counts.total > 0);   // nothing was queued into it (every machine already current)
  }

  // Pending jobs of a rollout that hasn't started must not be reaped as "stuck in the queue".
  const waitingJobIds = () => new Set(db.prepare(
    `SELECT j.id FROM jobs j JOIN rollouts r ON r.id = j.rollout_id WHERE j.status = 'pending' AND r.status = 'scheduled'`
  ).all().map((x) => x.id));

  return { create, allows, tick, cancel, startNow, list, get, waitingJobIds, ACTIVE };
}

module.exports = { createRollouts };
