// Farm rules: product status per machine, what's deployable, what a machine is doing.
// Ported from the classic dashboard (public/app.js) — same decisions, as pure functions over
// the farm state instead of globals.
import { cmpVersion, parseJSON } from './format.js';
import { INSTALL_PRESETS, ADOBE_RUM } from './presets.js';

export const AGENT_NAME = 'Beacon';

// Adobe keeps Creative Cloud current itself: shown, never offered for update.
export const SELF_UPDATING = new Set(['creativecloud']);
// Manager apps: no auto-deploy toggle ("self-managed"), still trackable.
export const SELF_MANAGED = new Set(['creativecloud', 'maxonapp']);
// The NVIDIA driver only exists on Windows nodes (Macs are Apple Silicon).
export const WINDOWS_ONLY = new Set(['nvidia']);
export const appliesToOS = (p, os) => !(WINDOWS_ONLY.has(p.key) && os !== 'windows');
// GPUs NVIDIA dropped from the current branch (Maxwell GTX 9xx, Pascal GTX 10xx) stay on the
// legacy ~581 track (product.latest_legacy).
const NVIDIA_EOL_GPU = /\bGTX\s*(9\d\d|10\d\d)\b/i;
export const nvidiaLegacy = (node) => NVIDIA_EOL_GPU.test(node.gpu || '');
export const latestForOS = (p, os) => (os === 'windows' ? p.latest_win : p.latest_mac) || p.latest_version;
export const nvidiaTarget = (node, product) => (nvidiaLegacy(node) ? product.latest_legacy : latestForOS(product, node.os));
export const isTracked = (p) => !!p && p.dashboard_hidden !== 1;
const verMajor = (v) => { const m = String(v || '').match(/\d+/); return m ? Number(m[0]) : 0; };

export const PRODUCT_ORDER = ['creativecloud', 'aftereffects', 'maxonapp', 'cinema4d', 'redgiant', 'redshift'];

// Display order, and Creative Cloud's "latest" = newest version seen on any machine.
export function normalizeProducts(state) {
  const oi = (k) => { const i = PRODUCT_ORDER.indexOf(k); return i < 0 ? 99 : i; };
  return state.products
    .map((p) => {
      if (!SELF_UPDATING.has(p.key)) return p;
      let max = p.latest_version || '';
      for (const n of state.nodes) {
        const sw = (n.software || []).find((s) => s.product_key === p.key);
        if (sw && sw.version && (!max || cmpVersion(sw.version, max) > 0)) max = sw.version;
      }
      return { ...p, latest_version: max || p.latest_version };
    })
    .sort((a, b) => oi(a.key) - oi(b.key));
}

// uptodate | patch (same major, in place) | major (older major, side-by-side) | missing |
// selfupdate | na | unknown
export function productStatus(node, product) {
  const sw = (node.software || []).find((s) => s.product_key === product.key);
  if (!appliesToOS(product, node.os)) return { status: 'na', version: sw ? sw.version : null };
  if (SELF_UPDATING.has(product.key)) {
    if (!sw || !sw.version) return { status: 'selfupdate', version: sw ? sw.version : null };
    if (product.latest_version && cmpVersion(sw.version, product.latest_version) >= 0) return { status: 'uptodate', version: sw.version };
    return { status: 'selfupdate', version: sw.version };
  }
  if (!sw) {
    if (product.key === 'nvidia' && !/nvidia/i.test(node.gpu || '')) return { status: 'na', version: null };
    return { status: 'missing', version: null };
  }
  const latest = product.key === 'nvidia' ? nvidiaTarget(node, product) : latestForOS(product, node.os);
  if (!latest) return { status: 'unknown', version: sw.version, target: null };
  if (!sw.version) return { status: 'unknown', version: null, target: latest };
  if (cmpVersion(sw.version, latest) >= 0) return { status: 'uptodate', version: sw.version, target: latest };
  const kind = product.key === 'nvidia' || verMajor(sw.version) === verMajor(latest) ? 'patch' : 'major';
  return { status: kind, version: sw.version, target: latest };
}

export const ACTIVE = ['pending', 'downloading', 'installing'];
export const jobActiveFor = (state, node, productKey) =>
  state.jobs.some((j) => j.hostname === node.hostname && j.product_key === productKey && ACTIVE.includes(j.status));
export const activeJobFor = (state, node, productKey) =>
  state.jobs.find((j) => j.hostname === node.hostname && j.product_key === productKey && ACTIVE.includes(j.status));

// Tracked apps behind on this machine that aren't already queued/installing.
export function outdatedProducts(state, products, node) {
  return products.filter((p) => isTracked(p) && ['patch', 'major'].includes(productStatus(node, p).status) && !jobActiveFor(state, node, p.key));
}

export const stagedFor = (prod, os) => (os === 'windows' ? prod.staged_win : prod.staged_mac);
export const savedSource = (prod, os) => (os === 'windows' ? prod.source_url_win : prod.source_url_mac);
export const versionFromFilename = (f) => { const m = String(f || '').match(/(\d+(?:\.\d+){1,3})/); return m ? m[1] : null; };

export function latestInstallerReady(prod, os) {
  if (!appliesToOS(prod, os)) return true;
  if (ADOBE_RUM[prod.key]) return !!ADOBE_RUM[prod.key][os];
  const staged = stagedFor(prod, os);
  if (!staged) return false;
  const want = latestForOS(prod, os);
  const fv = versionFromFilename(staged);
  if (!fv) return !!prod.custom;
  return !want || cmpVersion(fv, want) >= 0;
}

export function isDeployable(prod) {
  if (ADOBE_RUM[prod.key] || INSTALL_PRESETS[prod.key]) return true;
  return !!(prod.install_cmd_win || prod.install_cmd_mac || prod.source_url_win || prod.source_url_mac || prod.staged_win || prod.staged_mac);
}

// Machines to target for a product on the given OSes, by status kind; skips machines already
// updating, and "missing" only counts when the product can be installed with a known version.
export function nodesByKind(state, prod, osList, kinds) {
  return state.nodes.filter((n) => {
    if (!osList.includes(n.os) || jobActiveFor(state, n, prod.key)) return false;
    const st = productStatus(n, prod).status;
    if (!kinds.includes(st)) return false;
    if (st === 'missing') {
      if (!isDeployable(prod)) return false;
      if (prod.category !== 'script' && !latestForOS(prod, n.os)) return false;
    }
    return true;
  });
}
export const inProgressNodes = (state, prod, osList) => state.nodes.filter((n) => osList.includes(n.os) && jobActiveFor(state, n, prod.key));

export function newestPackage(state, productKey, os) {
  return state.packages.filter((p) => p.product_key === productKey && p.os === os).sort((a, b) => cmpVersion(a.version, b.version)).pop() || null;
}

// What a machine is doing right now: offline > installing > downloading > queued > rendering > reboot pending > idle.
export function nodeActivity(state, n, names) {
  if (!n.online) return { key: 'offline', label: 'Offline', tone: 'bad' };
  const mine = state.jobs.filter((j) => j.hostname === n.hostname && ACTIVE.includes(j.status));
  const pick = mine.find((j) => j.status === 'installing') || mine.find((j) => j.status === 'downloading') || mine[0];
  if (pick) {
    const nm = names.get(pick.product_key) || pick.product_key;
    if (pick.status === 'installing') return { key: 'installing', label: 'Installing', detail: nm, tone: 'accent' };
    if (pick.status === 'downloading') return { key: 'downloading', label: 'Downloading', detail: nm, tone: 'accent' };
    // Waiting for a scheduled rollout rather than for a free slot.
    const r = pick.rollout_id && state.rollouts ? state.rollouts.find((x) => x.id === pick.rollout_id) : null;
    if (r && r.status === 'scheduled') {
      const t = new Date(r.run_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      return { key: 'queued', label: 'Scheduled', detail: `${nm} · ${t}`, tone: 'info' };
    }
    return { key: 'queued', label: 'Queued', detail: nm, tone: 'info' };
  }
  if (n.gpu_util != null && n.gpu_util >= 20) return { key: 'rendering', label: 'Rendering', detail: `GPU ${n.gpu_util}%`, tone: 'violet' };
  if (n.pending_reboot) return { key: 'reboot', label: 'Reboot pending', tone: 'warn' };
  return { key: 'idle', label: 'Idle', tone: 'muted' };
}

// Deadline health (agents 2.31.0+): down = Worker not running; fragile = running but nothing
// starts it after a restart.
export function deadlineStatus(n) {
  const d = parseJSON(n.deadline_info);
  if (!d || !d.installed || !n.online) return null;
  const canFix = n.os === 'windows' && !!n.agent_version && cmpVersion(n.agent_version, '2.31.0') >= 0;
  if (!d.worker) {
    return { state: 'down', canFix, label: 'Deadline down', info: d,
      detail: `The Deadline Worker isn't running — ${n.hostname} takes no renders.${d.autostart ? '' : ' Nothing starts Deadline on this machine.'}` };
  }
  if (!d.autostart) {
    return { state: 'fragile', canFix, label: 'No auto-start', info: d,
      detail: `Deadline is running, but nothing starts it after a restart — the next reboot takes ${n.hostname} out of the farm.${d.autologon === false ? ' Automatic login is also off.' : ''}` };
  }
  return { state: 'ok', canFix, label: 'Deadline OK', info: d, detail: `Running · starts via ${(d.how || []).join(', ')}${d.user ? ' as ' + d.user : ''}` };
}

export function osVersionShort(n) {
  const v = n.os_version || '';
  if (n.os === 'windows') {
    const m = v.match(/10\.0\.(\d+)/);
    if (m) return Number(m[1]) >= 22000 ? '11' : '10';
    const f = v.match(/\b(11|10)\b/);
    return f ? f[1] : '';
  }
  const m = v.match(/(\d+)(?:\.\d+)*/);
  return m ? m[1] : '';
}

export const agentOutdated = (state, n) => !!(n.agent_version && state.latestAgentVersion && cmpVersion(n.agent_version, state.latestAgentVersion) < 0);
export const canShutdown = (n) => n.online && !!n.agent_version && cmpVersion(n.agent_version, n.os === 'macos' ? '2.29.0' : '2.28.0') >= 0;

// Everything that needs attention on one machine, most severe first.
export function nodeIssues(state, products, n) {
  const out = [];
  if (!n.online) out.push({ tone: 'bad', label: 'Offline' });
  const dl = deadlineStatus(n);
  if (dl && dl.state === 'down') out.push({ tone: 'bad', label: 'Deadline down', kind: 'deadline' });
  if (dl && dl.state === 'fragile') out.push({ tone: 'warn', label: 'Deadline won\'t auto-start', kind: 'deadline' });
  if (n.online && n.pending_reboot) out.push({ tone: 'warn', label: 'Reboot pending' });
  if (n.disk_free_gb != null && n.disk_free_gb < 20) out.push({ tone: 'warn', label: `Low disk (${n.disk_free_gb} GB)` });
  if (n.elevated === 0) out.push({ tone: 'warn', label: 'Needs elevation' });
  const behind = outdatedProducts(state, products, n);
  if (behind.length) out.push({ tone: 'info', label: `${behind.length} update${behind.length === 1 ? '' : 's'}`, kind: 'updates' });
  if (agentOutdated(state, n)) out.push({ tone: 'muted', label: `${AGENT_NAME} ${n.agent_version}` });
  return out;
}
