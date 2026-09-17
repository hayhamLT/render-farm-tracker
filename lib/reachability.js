'use strict';
// Is a machine that stopped checking in actually off, or just not running its agent?
//
// "Offline" in the tracker only ever meant "no check-in" — which reads as a lie when the machine
// is plainly switched on (RAZER-01, Sep 2026: rebooted, back on the network at a new address, but
// its agent never restarted). So every minute we probe the machines that look offline: ping, then
// a quick TCP knock, against the address we last saw them on AND their hostname (their DHCP
// address may have changed). The dashboard can then say "on the network, agent not reporting",
// and show the address it answered on.
const { execFile } = require('node:child_process');
const net = require('node:net');

const MIN = 60 * 1000;
const state = new Map();   // node id -> { ok, addr, at }

const clean = (ip) => String(ip || '').replace(/^::ffff:/, '').trim();

function ping(addr, ms = 1200) {
  return new Promise((resolve) => {
    execFile('/sbin/ping', ['-c', '1', '-W', String(ms), '-t', '2', addr], { timeout: ms + 1500 }, (err) => resolve(!err));
  });
}

// A TCP knock for machines that don't answer ping (firewall profile, no file sharing).
function knock(addr, port, ms = 1200) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(ms);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, addr);
  });
}

async function probeOne(node) {
  const names = [clean(node.ip), `${node.hostname}.local`, node.hostname].filter(Boolean);
  for (const addr of [...new Set(names)]) {
    // eslint-disable-next-line no-await-in-loop
    if (await ping(addr)) return { ok: true, addr, how: 'ping' };
  }
  for (const addr of [...new Set(names)]) {
    for (const port of [445, 22]) {
      // eslint-disable-next-line no-await-in-loop
      if (await knock(addr, port)) return { ok: true, addr, how: `port ${port}` };
    }
  }
  return { ok: false, addr: null, how: null };
}

// Probe the machines that look offline, a few at a time.
function start({ db, offlineAfterMs, hiddenHost, intervalMs = MIN }) {
  const run = async () => {
    try {
      const now = Date.now();
      const offline = db.prepare('SELECT id, hostname, ip, last_seen FROM nodes').all()
        .filter((n) => !hiddenHost(n.hostname))
        .filter((n) => n.last_seen == null || now - n.last_seen > offlineAfterMs());
      const live = new Set(offline.map((n) => n.id));
      for (const id of [...state.keys()]) if (!live.has(id)) state.delete(id);   // back online: forget
      const queue = [...offline];
      const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
        for (let n = queue.shift(); n; n = queue.shift()) {
          // eslint-disable-next-line no-await-in-loop
          const r = await probeOne(n);
          state.set(n.id, { ...r, at: Date.now() });
        }
      });
      await Promise.all(workers);
    } catch (e) { console.error('reachability probe failed:', e.message); }
  };
  setTimeout(run, 20 * 1000);
  setInterval(run, intervalMs).unref();
}

const get = (nodeId) => state.get(nodeId) || null;

module.exports = { start, get, _internal: { probeOne } };
