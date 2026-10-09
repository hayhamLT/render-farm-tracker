'use strict';
// node --test test/   (the farm gate, hidden machines, offline alerts, run expiry, log stamps: no database)
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFarmGate, STALE_MS, STARTUP_WHY } = require('../lib/farm_gate');
const hidden = require('../lib/hidden');
const { createOfflineAlerts } = require('../lib/offline_alerts');
const { runVerdict, RESULT_MARGIN_MS } = require('../lib/run_expiry');
const { isoLocal, stampConsole } = require('../lib/logtime');

const MIN = 60 * 1000;

test('the farm gate holds every machine from the start until Farmly first posts', () => {
  let t = 1_000_000;
  const gate = createFarmGate({ now: () => t });
  assert.equal(gate.holds('MARS-01'), STARTUP_WHY, 'just started: held, Farmly has said nothing yet');
  assert.equal(gate.status().starting, true);
  t += 15 * 1000;
  assert.equal(gate.holds('mars-01'), STARTUP_WHY);
  gate.set({ hosts: { 'MARS-01': { ok: false, why: 'rendering job X' }, 'MARS-02': { ok: true } } });
  assert.equal(gate.status().starting, false);
  assert.equal(gate.holds('MARS-01'), 'rendering job X');
  assert.equal(gate.holds('mars-02'), null);
  assert.equal(gate.holds('UNKNOWN-PC'), null, 'a machine Farmly does not know is not held');
  t += STALE_MS + 1;
  assert.equal(gate.holds('MARS-01'), null, 'a stale gate is ignored (a stopped Farmly freezes nothing)');
});

test('with no word from Farmly at all, the startup hold ends after STALE_MS', () => {
  let t = 5_000;
  const gate = createFarmGate({ now: () => t });
  t += STALE_MS - 1;
  assert.equal(gate.holds('AVA-01'), STARTUP_WHY);
  t += 2;
  assert.equal(gate.holds('AVA-01'), null);
  assert.equal(gate.status().starting, false);
});

test('an empty first post from Farmly ends the startup hold', () => {
  let t = 0;
  const gate = createFarmGate({ now: () => t });
  gate.set({ hosts: {} });
  assert.equal(gate.holds('AVA-01'), null);
  assert.throws(() => gate.set({}), /hosts/);
});

test('hidden machines: short name, any case; every action refused in words', () => {
  const list = ['Node-00', 'Farmly-Server'];
  assert.equal(hidden.isHidden('FARMLY-SERVER', list), true);
  assert.equal(hidden.isHidden('farmly-server.local', list), true);
  assert.equal(hidden.isHidden('Node-00.lan', list), true);
  assert.equal(hidden.isHidden('Node-01', list), false);
  assert.equal(hidden.isHidden('', list), false);
  assert.equal(hidden.isHidden('Node-00', undefined), false);
  assert.equal(hidden.refusal({ hostname: 'Farmly-Server' }, 'reboot', list),
    'Farmly-Server is a hidden infrastructure host (config.hiddenNodes), not a render node: the tracker never restarts it.');
  assert.match(hidden.refusal({ hostname: 'Node-00' }, 'uninstall', list), /the tracker never uninstalls anything from it\.$/);
  for (const a of ['install', 'uninstall', 'shutdown', 'wake', 'retry']) assert.ok(hidden.refusal({ hostname: 'Node-00' }, a, list));
  assert.equal(hidden.refusal({ hostname: 'MARS-01' }, 'reboot', list), null);
  assert.equal(hidden.refusal(null, 'reboot', list), null);
});

test('offline alerts: the first look is a baseline; hidden machines are never announced', () => {
  const now = Date.parse('2026-10-09T12:00:00-07:00');
  const alerts = createOfflineAlerts({ offlineMs: 180 * 1000, isHidden: (h) => h === 'Node-00' });
  const nodes = [
    { id: 1, hostname: 'MARS-JUICY', last_seen: now - 3 * 24 * 60 * MIN },   // off for days
    { id: 2, hostname: 'RAZER-01', last_seen: now - 60 * MIN },
    { id: 3, hostname: 'Node-00', last_seen: now - 90 * 24 * 60 * MIN },      // hidden
    { id: 4, hostname: 'MARS-01', last_seen: now - 5 * MIN },                 // just went quiet
    { id: 5, hostname: 'AVA-01', last_seen: now - 30 * 1000 },                // online
  ];
  assert.deepEqual(alerts.step(nodes, now), [], 'restart: nothing re-announced');
  // AVA-01 keeps checking in throughout.
  const at = (list, t) => list.map((n) => (n.id === 5 ? { ...n, last_seen: t - 30 * 1000 } : n));
  // MARS-01 crosses 15 min after the start: announced once.
  const later = now + 11 * MIN;
  assert.deepEqual(alerts.step(at(nodes, later), later), [{ id: 4, hostname: 'MARS-01', kind: 'offline' }]);
  assert.deepEqual(alerts.step(at(nodes, later + 5 * MIN), later + 5 * MIN), []);
  // MARS-JUICY comes back: said once.
  const back = nodes.map((n) => (n.id === 1 ? { ...n, last_seen: later + 6 * MIN } : n));
  assert.deepEqual(alerts.step(at(back, later + 6 * MIN), later + 6 * MIN), [{ id: 1, hostname: 'MARS-JUICY', kind: 'back' }]);
  assert.deepEqual(alerts.step(at(back, later + 7 * MIN), later + 7 * MIN), []);
  // Node-00 comes back: still nothing (hidden).
  const n00 = back.map((n) => (n.id === 3 ? { ...n, last_seen: later + 8 * MIN } : n));
  assert.deepEqual(alerts.step(at(n00, later + 8 * MIN), later + 8 * MIN), []);
});

test('a run whose result never comes is marked lost or expired, after its timeout and a margin', () => {
  const t = Date.parse('2026-10-08T18:10:14-07:00');
  const base = { status: 'pending', created_at: t, hostname: 'AVA-02' };
  // Picked up at once, 300 s limit.
  const picked = { ...base, delivered_at: t + 20 * 1000, timeout_s: 300 };
  assert.equal(runVerdict(picked, t + 20 * 1000 + 300 * 1000 + RESULT_MARGIN_MS), null);
  const lost = runVerdict(picked, t + 20 * 1000 + 300 * 1000 + RESULT_MARGIN_MS + 1);
  assert.equal(lost.status, 'lost');
  assert.match(lost.output, /AVA-02 picked this command up at .* but no result came back within its 300 s limit/);
  // Never picked up: the command is dropped after 30 min.
  const never = { ...base, delivered_at: null, timeout_s: 300 };
  assert.equal(runVerdict(never, t + 31 * MIN), null);
  const exp = runVerdict(never, t + 33 * MIN);
  assert.equal(exp.status, 'expired');
  assert.match(exp.output, /AVA-02 did not check in within 30 min/);
  // From before the tracker noted pick-up times (#442, #1295): the longest a run can take.
  const legacy = { ...base, delivered_at: null, timeout_s: null };
  assert.equal(runVerdict(legacy, t + 30 * MIN + 60 * MIN + RESULT_MARGIN_MS), null);
  assert.equal(runVerdict(legacy, t + 30 * MIN + 60 * MIN + RESULT_MARGIN_MS + 1).status, 'lost');
  assert.equal(runVerdict({ ...picked, status: 'done' }, t + 99 * 60 * MIN), null);
});

test('log lines start with the local ISO time', () => {
  const d = new Date(2026, 9, 9, 12, 41, 2, 117);
  const s = isoLocal(d);
  assert.match(s, /^2026-10-09T12:41:02\.117[+-]\d\d:\d\d$/);
  const lines = [];
  const fake = { log: (...a) => lines.push(require('node:util').format(...a)), info() {}, warn() {}, error: (...a) => lines.push(require('node:util').format(...a)) };
  stampConsole(fake, () => d);
  stampConsole(fake, () => d);   // twice is harmless
  fake.log('Render Farm Update Tracker %d', 4400);
  fake.error('100%s done');      // a stray % in a message stays as written
  assert.deepEqual(lines, [`${s} Render Farm Update Tracker 4400`, `${s} 100%s done`]);
});
