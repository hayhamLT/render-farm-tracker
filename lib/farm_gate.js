'use strict';
// Farmly (the farm's render manager, on this same server) decides WHEN a machine may install.
//
// The tracker used to guess whether a machine was rendering from its GPU load (>= 20%) and a few
// process names. Farmly knows: it assigned the renders. So Farmly posts a gate here every few
// seconds, POST /api/farm-gate {hosts: {HOSTNAME: {ok, why}}}, and reads back which machines have
// an install ready to go (GET /api/farm-gate -> waiting). A machine with an install waiting is
// drained by Farmly (it finishes its render, takes no new one), and only then marked ok; Farmly
// keeps it off the farm until the install is done.
//
// Farmly being down must not freeze every update: a gate older than STALE_MS is ignored and the
// tracker behaves as it did before. A machine Farmly does not know about is not held either.

const STALE_MS = 2 * 60 * 1000;

function createFarmGate({ now = () => Date.now() } = {}) {
  let gate = { at: 0, hosts: null };

  function set(body) {
    const hosts = {};
    const src = body && typeof body.hosts === 'object' && body.hosts ? body.hosts : null;
    if (!src) throw new Error('hosts: {HOSTNAME: {ok, why}} required');
    for (const [h, v] of Object.entries(src)) {
      if (!h) continue;
      hosts[String(h).toUpperCase()] = { ok: !!(v && v.ok), why: v && v.why ? String(v.why).slice(0, 200) : null };
    }
    gate = { at: now(), hosts };
    return { ok: true, hosts: Object.keys(hosts).length };
  }

  function fresh() {
    return !!gate.hosts && now() - gate.at < STALE_MS;
  }

  // null = go ahead; otherwise the reason this machine must wait.
  function holds(hostname) {
    if (!fresh()) return null;
    const e = gate.hosts[String(hostname || '').toUpperCase()];
    if (!e || e.ok) return null;
    return e.why || 'Farmly is using this machine';
  }

  function status() {
    return { at: gate.at || null, fresh: fresh(), staleAfterMs: STALE_MS, hosts: gate.hosts || {} };
  }

  return { set, holds, fresh, status, STALE_MS };
}

module.exports = { createFarmGate, STALE_MS };
