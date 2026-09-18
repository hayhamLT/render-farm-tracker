// The update engine behind every "Update" button: given apps and the machines each should update,
// create one rollout, stage a package per app/OS from the installer on the share (Adobe apps go
// through RUM), and queue the machines. Used by the Updates page, the Machines page and the review
// sheet — so batch, per-app and hand-picked updates all behave the same.
import { get, post } from './api.js';
import { ADOBE_RUM, presetCommand } from './presets.js';
import {
  appliesToOS, isDeployable, isTracked, jobActiveFor, latestForOS, latestInstallerReady, normalizeProducts, nodesByKind,
  nudgeWaiting, productStatus, savedSource, selfUpdateBehind, stagedFor, SELF_UPDATING,
} from './domain.js';

// Creative Cloud has no installer to push per version: the tracker restarts Adobe's own updater
// on the machine, which then pulls whatever Adobe has. Same buttons, different mechanism.
const NUDGE_COMMAND = '__RESTART_CC__';
export function updateTargets(state, product, { majors = false } = {}) {
  if (SELF_UPDATING.has(product.key)) {
    return state.nodes.filter((n) => !jobActiveFor(state, n, product.key)
      && selfUpdateBehind(n, product) && !nudgeWaiting(state, n, product));
  }
  const kinds = majors ? ['patch', 'major'] : ['patch'];
  return nodesByKind(state, product, ['windows', 'macos'], kinds);
}

// Can this app be updated on this OS without a manual step?
export function installerState(product, os) {
  if (!appliesToOS(product, os)) return { ok: true, label: '' };
  if (SELF_UPDATING.has(product.key)) return { ok: true, label: "Adobe's own updater", nudge: true };
  if (ADOBE_RUM[product.key]) return ADOBE_RUM[product.key][os] ? { ok: true, label: 'Adobe RUM' } : { ok: false, label: 'No Adobe package for this OS' };
  if (latestInstallerReady(product, os)) return { ok: true, label: 'Installer ready' };
  if (savedSource(product, os)) return { ok: true, label: 'Downloads the installer first', download: true };
  return { ok: false, label: 'Installer not on the share yet' };
}

export const canUpdate = (product) => SELF_UPDATING.has(product.key) || isDeployable(product);

async function downloadToShare(link, onProgress) {
  const { dlId, filename } = await post('/api/download-url', { url: link });
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    const r = await get('/api/downloads');
    const d = (r.downloads || []).find((x) => x.id === dlId);
    if (!d) throw new Error('download vanished');
    if (d.status === 'done') return d.filename || filename;
    if (d.status === 'error') throw new Error(d.error || 'download failed');
    if (onProgress) onProgress(`Downloading ${d.filename || filename}${d.total ? ` — ${Math.round((d.received / d.total) * 100)}%` : '…'}`);
  }
}

// items: [{ product, nodes }]; plan: body for POST /api/rollouts (see components/rollouts.js rolloutPlan).
// Returns { rollout, queued: [hostname], skipped: [text] }.
export async function queueUpdates(items, plan, { onProgress } = {}) {
  const rollout = (await post('/api/rollouts', plan)).rollout;
  const queued = [];
  const skipped = [];
  for (const { product: p, nodes } of items) {
    for (const os of ['windows', 'macos']) {
      const targets = nodes.filter((n) => n.os === os);
      if (!targets.length) continue;
      const label = `${p.name}${os === 'macos' ? ' (Mac)' : ' (Windows)'}`;
      try {
        let pkg;
        const rum = ADOBE_RUM[p.key];
        if (SELF_UPDATING.has(p.key)) {
          // No file: the agent restarts the Creative Cloud desktop app so it re-checks Adobe.
          pkg = { product_key: p.key, version: latestForOS(p, os) || 'latest', os, kind: 'command', install_command: NUDGE_COMMAND };
        } else if (rum) {
          if (!rum[os]) { skipped.push(`${label}: no Adobe package for this OS`); continue; }
          pkg = { product_key: p.key, version: p.latest_version || 'latest', os, kind: 'installer', filename: rum[os].filename, install_command: rum[os].command };
        } else {
          let filename = latestInstallerReady(p, os) ? stagedFor(p, os) : null;
          if (!filename && savedSource(p, os)) {
            if (onProgress) onProgress(`${label}: fetching the installer to the share…`);
            filename = await downloadToShare(savedSource(p, os), onProgress);
          }
          if (!filename) { skipped.push(`${label}: the installer isn't on the share yet — add it, or save a download link in Apps`); continue; }
          const custom = os === 'windows' ? p.install_cmd_win : p.install_cmd_mac;
          pkg = { product_key: p.key, version: latestForOS(p, os) || 'latest', os, kind: 'installer', filename, install_command: custom || presetCommand(p.key, os) };
        }
        if (onProgress) onProgress(`Queuing ${label} on ${targets.length} machine${targets.length === 1 ? '' : 's'}…`);
        const { id } = await post('/api/packages', pkg);
        const r = await post('/api/deployments', { package_id: id, node_ids: targets.map((n) => n.id), rollout_id: rollout.id });
        queued.push(...(r.queued || []));
        if (r.skippedNoDriver && r.skippedNoDriver.length) skipped.push(`${label}: no supported driver staged for ${r.skippedNoDriver.join(', ')}`);
      } catch (e) {
        skipped.push(`${label}: ${e.message}`);
      }
    }
  }
  return { rollout, queued: [...new Set(queued)], skipped };
}

// How many updates are waiting across the whole farm — the number in the sidebar and on the
// Updates lens. One definition, so they can never disagree.
export function updatesWaiting(state) {
  if (!state) return 0;
  return normalizeProducts(state).filter((p) => isTracked(p) && canUpdate(p))
    .reduce((c, p) => c + updateTargets(state, p).length, 0);
}

// Everything a machine is behind on (patches; majors only if asked).
export function machineUpdates(state, products, node, { majors = false } = {}) {
  return products.filter((p) => canUpdate(p) && p.dashboard_hidden !== 1 && !jobActiveFor(state, node, p.key)).filter((p) => {
    if (SELF_UPDATING.has(p.key)) return selfUpdateBehind(node, p) && !nudgeWaiting(state, node, p);
    const st = productStatus(node, p).status;
    return st === 'patch' || (majors && st === 'major');
  });
}
