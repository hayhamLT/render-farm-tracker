// Every user action, in one place: confirmation text, the API call, and the result message.
// Cards, the machine drawer, the bulk bar and the command palette all call these, so an action
// behaves the same wherever it's triggered.
import { post, put, del, api } from './api.js';
import { refresh } from './store.js';
import { confirm, toast } from './ui.js';
import { canShutdown, deadlineStatus } from './domain.js';
import { plural } from './format.js';

const names = (nodes, max = 8) => nodes.slice(0, max).map((n) => n.hostname).join(', ') + (nodes.length > max ? ` +${nodes.length - max} more` : '');

async function forEach(nodes, fn) {
  const results = await Promise.allSettled(nodes.map(fn));
  const failed = results.map((r, i) => (r.status === 'rejected' ? `${nodes[i].hostname}: ${r.reason.message}` : null)).filter(Boolean);
  return { ok: nodes.length - failed.length, failed };
}

function report(verb, nodes, { ok, failed }) {
  if (ok) toast(nodes.length === 1 && !failed.length ? verb(nodes[0]) : `${verb(null)} ${plural(ok, 'machine')}.`, 'success');
  if (failed.length) toast(`Failed on ${failed.length}: ${failed.join(' · ')}`, 'error', 9000);
  refresh();
}

// ---- power ----
export async function restart(nodes) {
  nodes = nodes.filter((n) => n.online);
  if (!nodes.length) return toast('Restart only works on online machines.', 'error');
  if (!await confirm(`Restart ${names(nodes)}? ${nodes.length === 1 ? 'It reboots' : 'They reboot'} within a minute — via the tracker agent, or Deadline if the agent can't be reached — and any render running on ${nodes.length === 1 ? 'it' : 'them'} is interrupted.`,
    { title: nodes.length === 1 ? 'Restart machine' : `Restart ${nodes.length} machines`, confirmLabel: 'Restart', danger: true,
      details: 'After a restart, Deadline only comes back on machines where it starts automatically (see the Deadline badge).' })) return;
  report((n) => (n ? `Restart sent to ${n.hostname}.` : 'Restart sent to'), nodes, await forEach(nodes, (n) => post(`/api/nodes/${n.id}/reboot`)));
}

export async function shutdown(nodes) {
  const able = nodes.filter(canShutdown);
  const skipped = nodes.filter((n) => !canShutdown(n));
  if (!able.length) return toast('None of these machines can be shut down (offline, or agent too old).', 'error');
  const macs = able.filter((n) => n.os === 'macos').length;
  if (!await confirm(`Shut down ${names(able)}? ${able.length === 1 ? 'It powers' : 'They power'} fully off and won't render until woken with Wake-on-LAN. This is not a restart.${macs ? ` Macs are put to sleep instead — a shut-down Mac can't be woken over the network.` : ''}`,
    { title: able.length === 1 ? 'Shut down machine' : `Shut down ${able.length} machines`, confirmLabel: 'Shut down', danger: true,
      details: skipped.length ? `Skipped (offline or agent too old): ${names(skipped)}` : null })) return;
  report((n) => (n ? `Shutdown sent to ${n.hostname} — use Wake to bring it back.` : 'Shutdown sent to'), able, await forEach(able, (n) => post(`/api/nodes/${n.id}/shutdown`)));
}

export async function wake(nodes) {
  nodes = nodes.filter((n) => !n.online && !(n.wake && n.wake.state === 'waking'));
  if (!nodes.length) return toast('Nothing to wake — those machines are online or already waking.', 'info');
  if (!await confirm(`Wake ${names(nodes)}? The tracker sends Wake-on-LAN from the server and from online machines on the same network, then tells you when ${nodes.length === 1 ? 'it is' : 'they are'} back — or why not.`,
    { title: nodes.length === 1 ? 'Wake machine' : `Wake ${nodes.length} machines`, confirmLabel: 'Wake' })) return;
  report((n) => (n ? `Waking ${n.hostname} — watching for it to come online…` : 'Waking'), nodes, await forEach(nodes, (n) => post(`/api/nodes/${n.id}/wake`)));
}

export async function fixDeadline(nodes) {
  nodes = nodes.filter((n) => { const d = deadlineStatus(n); return d && d.canFix && d.state !== 'ok'; });
  if (!nodes.length) return toast('No selected machine needs (or supports) the Deadline startup fix.', 'info');
  if (!await confirm(`Make Deadline start by itself on ${names(nodes)}? The agent registers the Deadline Launcher to start whenever the desktop user logs in (no password needed), turns on "start the Worker with the Launcher", and starts Deadline now if it isn't running.`,
    { title: 'Fix Deadline startup', confirmLabel: 'Fix it' })) return;
  report((n) => (n ? `Fixing Deadline startup on ${n.hostname} — the result shows here in about a minute.` : 'Deadline startup fix sent to'), nodes, await forEach(nodes, (n) => post(`/api/nodes/${n.id}/deadline-fix`)));
}

// ---- visibility ----
export async function setHidden(hostnames, hidden) {
  const results = await Promise.allSettled(hostnames.map((hostname) => post('/api/hidden-nodes', { hostname, hidden })));
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) toast(`Couldn't ${hidden ? 'hide' : 'unhide'} ${failed.length}: ${failed[0].reason.message}`, 'error');
  else toast(hidden ? `Hidden ${plural(hostnames.length, 'machine')} — find them under "Hidden".` : `${hostnames.join(', ')} is back on the dashboard.`, 'success');
  refresh();
}

// ---- updates ----
export async function quickUpdate(node, pkg, productName) {
  try {
    const r = await post('/api/quick-update', { node_id: node.id, package_id: pkg.id });
    toast(r.queued && r.queued.length ? `${productName} ${pkg.version} queued on ${node.hostname}.` : (r.note || 'Nothing queued.'), r.queued && r.queued.length ? 'success' : 'info');
  } catch (e) { toast(`Couldn't queue ${productName} on ${node.hostname}: ${e.message}`, 'error'); }
  refresh();
}

// ---- jobs ----
export async function stopJob(job) {
  if (!await confirm(`Stop ${job.product_key} ${job.package_version} on ${job.hostname}? A running installer is killed on the machine, and the machine moves on to its next update.`,
    { title: 'Stop job', confirmLabel: 'Stop job', danger: true })) return;
  try {
    const r = await post(`/api/jobs/${job.id}/kill`);
    toast(r.result === 'stopping' ? 'Stopping — the machine kills the installer on its next check-in (within a minute).' : 'Job stopped.', 'success');
  } catch (e) { toast(e.message, 'error'); }
  refresh();
}

export async function retryJob(job) {
  try { await post(`/api/jobs/${job.id}/retry`); toast(`Retrying on ${job.hostname}.`, 'success'); } catch (e) { toast(e.message, 'error'); }
  refresh();
}

export async function stopAll(activeCount) {
  if (!await confirm(`Stop all ${plural(activeCount, 'queued or running update')}, farm-wide? Running installers are killed on their machines.`,
    { title: 'Stop everything', confirmLabel: 'Stop all', danger: true })) return;
  try {
    const r = await post('/api/jobs/kill-all');
    toast(r.stopping ? `Cancelled ${r.cancelled} queued; stopping ${r.stopping} running installer(s) on their machines.` : `Stopped ${plural(r.stopped, 'job')}.`, 'success');
  } catch (e) { toast(e.message, 'error'); }
  refresh();
}

export async function clearFinished(count) {
  if (!await confirm(`Clear ${plural(count, 'finished job')} from the list? Running and queued jobs stay.`, { title: 'Clear finished', confirmLabel: 'Clear' })) return;
  try { const r = await post('/api/jobs/clear-finished'); toast(`Cleared ${plural(r.cleared, 'finished job')}.`, 'success'); } catch (e) { toast(e.message, 'error'); }
  refresh();
}

// ---- maintenance ----
export async function backupNow() {
  try { await post('/api/backup'); toast('Database backed up.', 'success'); } catch (e) { toast(`Backup failed: ${e.message}`, 'error'); }
  refresh();
}

export async function checkVersions() {
  const id = toast('Checking for new versions…', 'info', 0);
  try {
    const r = await post('/api/check-maxon');
    const bumped = r.bumped || [];
    const fetched = r.fetched || [];
    toast(bumped.length || fetched.length
      ? `New: ${bumped.join(', ') || '—'}${fetched.length ? ` · fetching ${plural(fetched.length, 'installer')}` : ''}`
      : 'Checked — every app is on its latest known version.', bumped.length ? 'success' : 'info', 7000);
  } catch (e) { toast(`Version check failed: ${e.message}`, 'error'); }
  finally { import('./ui.js').then((m) => m.dismissToast(id)); }
  refresh();
}

export { api, post, put, del };
