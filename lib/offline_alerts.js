'use strict';
// Slack's "offline for 15+ minutes" / "back online" alerts, as pure state: step() takes the machines as
// they are now and returns what to say. Kept in memory, so the first step after the tracker starts only
// takes a baseline: a machine that was already long offline is not announced again on every restart
// (Node-00, MARS-JUICY and RAZER-01 were, after each one). Hidden machines (config.hiddenNodes) are never
// announced. A machine that goes quiet after the start is announced once it has been offline GRACE_MS.

const GRACE_MS = 15 * 60 * 1000;

function createOfflineAlerts({ offlineMs, graceMs = GRACE_MS, isHidden = () => false }) {
  const alerted = new Set();      // node ids already announced as offline (or offline at the start)
  let started = false;

  // nodes: [{id, hostname, last_seen}]. Returns [{id, hostname, kind: 'offline' | 'back'}].
  function step(nodes, now) {
    const out = [];
    const ms = typeof offlineMs === 'function' ? offlineMs() : offlineMs;
    const visible = (nodes || []).filter((n) => !isHidden(n.hostname));
    for (const n of visible) {
      const longOff = n.last_seen != null && now - n.last_seen > graceMs;
      const off = n.last_seen == null || now - n.last_seen > ms;
      if (off && longOff) {
        if (!alerted.has(n.id)) {
          alerted.add(n.id);
          if (started) out.push({ id: n.id, hostname: n.hostname, kind: 'offline' });   // first look: baseline only
        }
      } else if (!off && alerted.delete(n.id)) {
        out.push({ id: n.id, hostname: n.hostname, kind: 'back' });
      }
    }
    const ids = new Set(visible.map((n) => n.id));
    for (const id of [...alerted]) if (!ids.has(id)) alerted.delete(id);   // removed or hidden since
    started = true;
    return out;
  }

  return { step, alerted };
}

module.exports = { createOfflineAlerts, GRACE_MS };
