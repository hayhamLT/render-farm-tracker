'use strict';
// node --test test/   (the farm gate and hidden machines: no database)
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFarmGate, STALE_MS, STARTUP_WHY } = require('../lib/farm_gate');
const hidden = require('../lib/hidden');

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
