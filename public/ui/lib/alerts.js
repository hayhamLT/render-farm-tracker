// Desktop alerts: watch the live farm state for things worth interrupting you for — a rollout
// finishing or pausing, a machine dropping out of Deadline, a machine going offline, an install
// failing — and show them as a macOS/Windows notification when the dashboard isn't the window
// you're looking at (an in-page toast when it is). Clicking a notification opens the machine or
// rollout. Per-viewer settings live in this browser (localStorage).
import { effect } from '@preact/signals-core';
import { farm } from './store.js';
import { go } from './router.js';
import { pref, toast } from './ui.js';

export const alertsOn = pref('alerts.enabled', false);
export const alertTypes = pref('alerts.types', { rollouts: true, deadline: true, offline: true, failed: true });

export const ALERT_TYPES = [
  ['rollouts', 'Rollouts', 'A scheduled rollout starts, pauses for the night, or finishes'],
  ['deadline', 'Deadline drop-outs', "A machine that was rendering-ready stops running its Deadline Worker"],
  ['offline', 'Machines going offline', 'A machine stops checking in'],
  ['failed', 'Failed installs', 'An install job fails'],
];

export const supported = () => typeof window !== 'undefined' && 'Notification' in window;
export const permission = () => (supported() ? Notification.permission : 'unsupported');

export async function enableAlerts() {
  if (!supported()) { toast("This browser can't show desktop notifications.", 'error'); return false; }
  let p = Notification.permission;
  if (p === 'default') p = await Notification.requestPermission();
  if (p !== 'granted') {
    toast(p === 'denied' ? 'Notifications are blocked for this site — allow them in the browser’s site settings, then try again.' : 'Notifications were not allowed.', 'error', 9000);
    alertsOn.value = false;
    return false;
  }
  alertsOn.value = true;
  return true;
}

function show({ title, body, tag, target }) {
  const focused = document.visibilityState === 'visible' && document.hasFocus();
  const open = () => {
    try { window.focus(); if (window.parent && window.parent !== window) window.parent.focus(); } catch { /* cross-origin parent */ }
    if (target) go(...target);
  };
  if (!focused && alertsOn.value && permission() === 'granted') {
    try {
      // The tag makes the OS replace a duplicate (several open tabs, or the same thing twice).
      const n = new Notification(title, { body, tag, renotify: false, silent: false });
      n.onclick = () => { open(); n.close(); };
      return;
    } catch { /* fall back to a toast */ }
  }
  if (alertsOn.value) toast(`${title} — ${body}`, /fail|down|offline|paused|stopped/i.test(title) ? 'error' : 'success', 8000);
}

export function testAlert() {
  const n = farm.value && farm.value.nodes[0];
  const payload = { title: 'Test alert', body: 'Desktop alerts from the Render Farm Tracker are working.', tag: 'rft-test', target: n ? ['machines', n.hostname] : null };
  if (permission() === 'granted') {
    const note = new Notification(payload.title, { body: payload.body, tag: payload.tag });
    note.onclick = () => { window.focus(); note.close(); };
  } else toast(payload.body, 'success');
}

const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };
const list = (a, n = 4) => (a.length <= n ? a.join(', ') : `${a.slice(0, n).join(', ')} and ${a.length - n} more`);

function snapshot(s) {
  const nodes = new Map();
  for (const n of s.nodes) {
    const d = parse(n.deadline_info);
    nodes.set(n.id, { host: n.hostname, online: n.online, worker: d && d.installed ? !!d.worker : null });
  }
  return {
    nodes,
    jobs: new Map(s.jobs.map((j) => [j.id, j.status])),
    rollouts: new Map((s.rollouts || []).map((r) => [r.id, { status: r.status, nights: r.nights, r }])),
  };
}

export function startAlerts() {
  let prev = null;
  let queue = [];
  let timer = null;

  const flush = () => {
    timer = null;
    const items = queue; queue = [];
    const t = alertTypes.value;
    const group = (kind) => items.filter((x) => x.kind === kind);
    const off = group('offline').map((x) => x.host);
    if (t.offline && off.length) show({ title: off.length === 1 ? `${off[0]} went offline` : `${off.length} machines went offline`, body: off.length === 1 ? 'It stopped checking in with the tracker.' : list(off), tag: `rft-offline-${off.join(',')}`, target: off.length === 1 ? ['machines', off[0]] : ['machines'] });
    const dl = group('deadline').map((x) => x.host);
    if (t.deadline && dl.length) show({ title: dl.length === 1 ? `${dl[0]} dropped out of Deadline` : `${dl.length} machines dropped out of Deadline`, body: dl.length === 1 ? 'Its Deadline Worker stopped — it takes no renders.' : list(dl), tag: `rft-deadline-${dl.join(',')}`, target: dl.length === 1 ? ['machines', dl[0]] : ['machines'] });
    const failed = group('failed');
    if (t.failed && failed.length) show({ title: failed.length === 1 ? `Install failed on ${failed[0].host}` : `${failed.length} installs failed`, body: failed.length === 1 ? `${failed[0].app} ${failed[0].version}` : list(failed.map((f) => `${f.host} (${f.app})`)), tag: `rft-failed-${failed.map((f) => f.id).join(',')}`, target: ['updates'] });
    for (const r of group('rollout')) if (t.rollouts) show(r.note);
  };
  const push = (item) => { queue.push(item); if (!timer) timer = setTimeout(flush, 2500); };

  effect(() => {
    const s = farm.value;
    if (!s) return;
    const next = snapshot(s);
    if (prev) {
      for (const [id, n] of next.nodes) {
        const p = prev.nodes.get(id);
        if (!p) continue;
        if (p.online && !n.online) push({ kind: 'offline', host: n.host });
        // Only a real drop: online both times, Worker was running and now isn't.
        if (p.online && n.online && p.worker === true && n.worker === false) push({ kind: 'deadline', host: n.host });
      }
      for (const j of s.jobs) {
        const was = prev.jobs.get(j.id);
        if (was && was !== 'failed' && j.status === 'failed') push({ kind: 'failed', id: j.id, host: j.hostname, app: (s.products.find((p) => p.key === j.product_key) || {}).name || j.product_key, version: j.package_version });
      }
      for (const [id, cur] of next.rollouts) {
        const p = prev.rollouts.get(id);
        if (!p) continue;
        const r = cur.r; const c = r.counts;
        if (p.status === 'running' && cur.status === 'done') {
          push({ kind: 'rollout', note: { title: c.failed ? `Rollout finished with ${c.failed} failed` : 'Rollout finished', body: `${r.name}: ${c.success} installed${c.failed ? `, ${c.failed} failed` : ''}${c.cancelled ? `, ${c.cancelled} stopped` : ''}`, tag: `rft-rollout-${id}-done`, target: ['updates'] } });
        } else if (p.status === 'running' && cur.status === 'scheduled' && cur.nights > p.nights) {
          push({ kind: 'rollout', note: { title: 'Rollout paused for tonight', body: `${r.name}: ${c.success}/${c.total} done, ${c.pending} continue next night`, tag: `rft-rollout-${id}-pause-${cur.nights}`, target: ['updates'] } });
        } else if (p.status === 'scheduled' && cur.status === 'running') {
          push({ kind: 'rollout', note: { title: 'Rollout started', body: `${r.name} on ${c.machines} machine${c.machines === 1 ? '' : 's'}`, tag: `rft-rollout-${id}-start-${cur.nights}`, target: ['updates'] } });
        }
      }
    }
    prev = next;
  });
}
