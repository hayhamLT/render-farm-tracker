'use strict';
// node --test test/   (pure decisions: no database, no server)
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/job_rules');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-10-06T22:06:03-07:00');
const ENOSPC = 'Download failed: [Errno 28] No space left on device';
const REAPED = 'Running: "C:\\Windows\\TEMP\\x\\617.42.exe" -s -noreboot\n[timed out: no agent progress — likely agent restart]';

test('a failure is real, soft (the tracker gave up, or the agent refused before running) or a stop', () => {
  assert.equal(R.classifyFailure({ status: 'failed', log: ENOSPC }), 'real');
  assert.equal(R.classifyFailure({ status: 'failed', log: 'REBOOT NEEDED — Windows has a restart pending' }), 'real');
  assert.equal(R.classifyFailure({ status: 'failed', log: REAPED }), 'soft');
  assert.equal(R.classifyFailure({ status: 'failed', log: "\n[timed out: no word from AVA-01's agent for 80 min, and it no longer names this job as running — likely agent restart]" }), 'soft');
  assert.equal(R.classifyFailure({ status: 'failed', log: 'Refused: this is an archive, which can\'t carry a signature' }), 'soft');
  assert.equal(R.classifyFailure({ status: 'failed', log: 'Downloading X\n[AVA-01 is no longer running this job and no result ever arrived — …]' }), 'soft');
  assert.equal(R.classifyFailure({ status: 'failed', log: '\n[expired: queued 25 h and never started on Node-04]' }), 'soft');
  assert.equal(R.classifyFailure({ status: 'cancelled', log: '[stopped by user]' }), 'stopped');
  assert.equal(R.classifyFailure({ status: 'success', log: 'Installed' }), null);
  assert.equal(R.classifyFailure({ status: 'pending' }), null);
});

test('AVA-01, 2026-10-06: one real failure keeps auto-deploy off that machine for a day', () => {
  // #586 reaped while running, then #588 failed "No space left on device" at 23:16.
  const jobs = [
    { id: 586, status: 'failed', log: REAPED, updated_at: T0 + 55 * MIN },
    { id: 588, status: 'failed', log: ENOSPC, updated_at: T0 + 70 * MIN },
  ];
  const at2303 = T0 + 57 * MIN;              // the first re-queue came at 23:03, after the reap only
  assert.equal(R.machineHold(jobs.slice(0, 1), at2303), null, 'one lost-contact try is not enough to hold');
  const h = R.machineHold(jobs, T0 + 73 * MIN);
  assert.ok(h, 'held after the real failure');
  assert.equal(h.job, 588);
  assert.match(h.reason, /install #588 failed: Download failed: \[Errno 28\] No space left on device/);
  assert.equal(h.until, jobs[1].updated_at + R.HOLD_MS);
  // Every 3-minute tick for the rest of the night: still held, so nothing is queued.
  for (let t = T0 + 73 * MIN; t < T0 + 8 * HOUR; t += 3 * MIN) assert.ok(R.machineHold(jobs, t));
  // A day later it may be tried again.
  assert.equal(R.machineHold(jobs, jobs[1].updated_at + R.HOLD_MS + 1), null);
});

test('RETRY_CAP soft failures hold a machine; fewer do not; a stop holds it', () => {
  const soft = (id, at) => ({ id, status: 'failed', log: REAPED, updated_at: at });
  const now = T0 + 5 * HOUR;
  assert.equal(R.machineHold([soft(1, T0), soft(2, T0 + HOUR)], now), null);
  const h = R.machineHold([soft(1, T0), soft(2, T0 + HOUR), soft(3, T0 + 2 * HOUR)], now);
  assert.ok(h);
  assert.equal(h.job, 3);
  assert.match(h.reason, /3 tries ended without a result/);
  const stopped = R.machineHold([{ id: 9, status: 'cancelled', log: '[stopped by user]', updated_at: T0 }], now);
  assert.match(stopped.reason, /install #9 was stopped/);
  assert.equal(R.machineHold([{ id: 5, status: 'success', log: 'Installed', updated_at: T0 }], now), null);
  assert.equal(R.machineHold([], now), null);
});

test('the reaper waits past the agent\'s 60 min, and never reaps a job its agent named a moment ago', () => {
  assert.equal(R.REAP_DEFAULT_MS, 75 * MIN);
  assert.equal(R.reapLimitMs(undefined), 75 * MIN);
  assert.equal(R.reapLimitMs(45), 75 * MIN, 'a shorter config value cannot undercut the agent');
  assert.equal(R.reapLimitMs(120), 120 * MIN);
  const installing = { status: 'installing', updated_at: T0 };
  // #586: "installing" at 22:16, reaped at 23:01 (45 min) while the agent still ran it.
  assert.equal(R.reapDecision(installing, T0 + 46 * MIN), null);
  assert.equal(R.reapDecision(installing, T0 + 74 * MIN), null);
  assert.equal(R.reapDecision(installing, T0 + 76 * MIN), 'stale');
  // Named as running 2 minutes ago: alive, however long since its last status report.
  assert.equal(R.reapDecision({ ...installing, agent_seen_at: T0 + 3 * HOUR - 2 * MIN }, T0 + 3 * HOUR), null);
  assert.equal(R.reapDecision({ ...installing, agent_seen_at: T0 + 3 * HOUR - 6 * MIN }, T0 + 3 * HOUR), 'stale');
  assert.equal(R.reapDecision({ status: 'downloading', updated_at: T0 }, T0 + 80 * MIN), 'stale');
  assert.equal(R.reapDecision({ status: 'pending', updated_at: T0 }, T0 + 23 * HOUR), null);
  assert.equal(R.reapDecision({ status: 'pending', updated_at: T0 }, T0 + 25 * HOUR), 'expired');
  assert.equal(R.reapDecision({ status: 'success', updated_at: T0 }, T0 + 99 * HOUR), null);
});

test('the check-in correction credits only the newest job for an app, one that really ran, once', () => {
  const installed = new Map([['nvidia', '617.42']]);
  const now = T0 + 17 * HOUR;
  const failed = (o) => ({ status: 'failed', product_key: 'nvidia', version: '617.42', started_at: T0, updated_at: now - HOUR, log: 'Command timed out after 3600s', ...o });
  // 2026-10-07 15:10: #722 installed it. It is the newest job, and a success: nothing to credit.
  assert.deepEqual(R.creditable([{ ...failed({ id: 722 }), status: 'success' }], installed, now), []);
  // The newest job failed but the version is there now: credited.
  const ok = R.creditable([failed({ id: 722 })], installed, now);
  assert.equal(ok.length, 1);
  assert.equal(ok[0].job.id, 722);
  assert.equal(ok[0].have, '617.42');
  // Never started on the machine (#725, Node-04): it installed nothing.
  assert.deepEqual(R.creditable([failed({ id: 725, started_at: null })], installed, now), []);
  // Its own report says the installer never ran.
  assert.deepEqual(R.creditable([failed({ id: 721, log: ENOSPC })], installed, now), []);
  assert.deepEqual(R.creditable([failed({ id: 7, log: 'Refused: X is signed by Y' })], installed, now), []);
  assert.deepEqual(R.creditable([failed({ id: 8, log: 'SHA256 mismatch — refusing to install.' })], installed, now), []);
  // Older than the window, lower version, uninstall jobs, apps the machine does not report.
  assert.deepEqual(R.creditable([failed({ id: 9, updated_at: now - 25 * HOUR })], installed, now), []);
  assert.deepEqual(R.creditable([failed({ id: 10 })], new Map([['nvidia', '616.92']]), now), []);
  assert.deepEqual(R.creditable([failed({ id: 11, version: 'uninstall' })], installed, now), []);
  assert.deepEqual(R.creditable([failed({ id: 12, product_key: 'blender' })], installed, now), []);
  // A newer version installed counts too.
  assert.equal(R.creditable([failed({ id: 13 })], new Map([['nvidia', '620.1']]), now).length, 1);
});

test('the old correction\'s mistakes are found: not the newest job, or never started', () => {
  const v = (o) => ({ log: 'Verified on check-in: AVA-01 now reports nvidia 617.42 …', started_at: T0, ...o });
  const rows = [
    v({ id: 588, newest_id: 722 }),                 // AVA-01: a later job (#722) installed it
    v({ id: 721, newest_id: 722 }),
    v({ id: 725, newest_id: 725, started_at: null }),   // Node-04: never ran
    v({ id: 484, newest_id: 484 }),                 // Creative Cloud finishing in the background: right
    { id: 1, newest_id: 2, log: 'Installed: 1 -> 2', started_at: T0 },   // not a correction at all
  ];
  assert.deepEqual(R.miscredited(rows).map((r) => r.id), [588, 721, 725]);
  const n1 = R.miscreditNote({ ...rows[0], hostname: 'AVA-01', product_key: 'nvidia', version: '617.42' }, '2026-10-09');
  assert.match(n1, /^\[Not this attempt \(noted 2026-10-09\): job #722 is the latest try of nvidia on AVA-01\./);
  assert.ok(n1.endsWith(']\n'));
  const n2 = R.miscreditNote({ ...rows[2], hostname: 'Node-04', product_key: 'nvidia', version: '617.42' }, '2026-10-09');
  assert.match(n2, /never started on Node-04, so it installed nothing/);
  assert.ok(!n2.startsWith(R.VERIFIED_PREFIX), 'a noted row no longer matches, so the migration runs once');
});

test('versions compare numerically', () => {
  assert.equal(R.cmpVersion('617.42', '617.42'), 0);
  assert.equal(R.cmpVersion('616.92', '617.42'), -1);
  assert.equal(R.cmpVersion('2026.10.0', '2026.9.1'), 1);
  assert.equal(R.cmpVersion('26.3', '26.3.0'), 0);
});
