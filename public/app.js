'use strict';

// ------------------------------------------------------------- icon system ---
// Clean inline-SVG icons (Lucide-style, currentColor). No emoji.
const ICONS = {
  windows: '<path d="M3 5.4l7-1v6.6H3zM11 4.3l9-1.3v8.1h-9zM3 12.6h7v6.6l-7-1zM11 12.6h9v8.1l-9-1.3z" fill="currentColor" stroke="none"/>',
  apple: '<path d="M16.4 2c.1.9-.25 1.8-.85 2.5-.62.7-1.65 1.25-2.6 1.17-.12-.86.3-1.78.86-2.4C14.45 2.5 15.55 2 16.4 2zm2.95 14.3c-.45 1.05-.67 1.5-1.25 2.45-.8 1.25-1.95 2.8-3.37 2.8-1.26 0-1.6-.82-3.3-.82-1.7 0-2.07.8-3.32.83-1.4.05-2.45-1.35-3.27-2.6-2.25-3.5-2.5-7.6-1.1-9.78.98-1.55 2.55-2.45 4.02-2.45 1.5 0 2.45.82 3.68.82 1.2 0 1.93-.83 3.67-.83 1.32 0 2.72.72 3.72 1.96-3.27 1.8-2.74 6.47.82 7.6z" fill="currentColor" stroke="none"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>',
  x: '<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/>',
  up: '<circle cx="12" cy="12" r="9"/><path d="M12 16.5V8M8.5 11.5L12 8l3.5 3.5"/>',
  download: '<path d="M12 3v12M7.5 11l4.5 4.5L16.5 11M5 20.5h14"/>',
  play: '<path d="M7 4.5l13 7.5-13 7.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6.5" y="5" width="3.5" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="14" y="5" width="3.5" height="14" rx="1.2" fill="currentColor" stroke="none"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  grid: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9.5 10v10"/>',
  trash: '<path d="M3.5 6.5h17M9 6.5V4.5h6v2M5.5 6.5l1 13.5h11l1-13.5"/>',
  refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1M20.5 4v4h-4"/>',
  alert: '<path d="M12 3.5l9.5 16.5h-19zM12 9.5v5M12 17.5h.01"/>',
  package: '<path d="M12 2.5l8.5 4.7v9.6L12 21.5l-8.5-4.7V7.2zM3.7 7.3L12 12l8.3-4.7M12 12v9.5"/>',
  activity: '<path d="M3 12h4l2.5 7 5-14L17 12h4"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  dot: '<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
  cog: '<path d="M12 2.5l2 .4.6 2 .9.5 2-.6 1.5 1.7-1 1.7.3 1 1.8.8.5 2 2 .4v2.2l-2 .4-.5 2-.8.5 1 1.7-1.5 1.7-2-.6-.9.5-.6 2-2 .4-2-.4-.6-2-.9-.5-2 .6-1.5-1.7 1-1.7-.3-1-1.8-.8-.5-2-2-.4V11l2-.4.5-2 .8-.5-1-1.7L7 4.7l2 .6.9-.5.6-2z"/><circle cx="12" cy="12" r="3"/>',
  spinner: '<circle cx="12" cy="12" r="9" opacity="0.25"/><path d="M21 12a9 9 0 0 0-9-9"/>',
  shieldOk: '<path d="M12 2.5l8 3v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10v-6z"/><path d="M8.5 12l2.3 2.3 4.7-4.8"/>',
  shieldOff: '<path d="M12 2.5l8 3v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10v-6z"/><path d="M12 8.5v4M12 15.5h.01"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.4 9.3a2.7 2.7 0 1 1 3.8 2.5c-.8.4-1.2 1-1.2 1.9M12 17h.01"/>',
};
function icon(name, cls = '') {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

// ---- themed in-app dialogs (replace native alert/confirm) ----
// Transient corner notification. type: 'info' | 'success' | 'error'.
function toast(message, type = 'info', ms = 4500) {
  let wrap = document.getElementById('toast-wrap');
  if (!wrap) { wrap = document.createElement('div'); wrap.id = 'toast-wrap'; document.body.appendChild(wrap); }
  const ic = type === 'error' ? 'alert' : type === 'success' ? 'check' : 'activity';
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span class="ti">${icon(ic)}</span><span>${esc(message)}</span>`;
  wrap.appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  const kill = () => { t.classList.remove('in'); setTimeout(() => t.remove(), 220); };
  t.addEventListener('click', kill);
  setTimeout(kill, ms);
}

// Themed confirm — returns a Promise<boolean>. opts: {title, confirmLabel, cancelLabel, danger}.
function uiConfirm(message, opts = {}) {
  const { title = 'Confirm', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = opts;
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-title">${esc(title)}</div>
      <div class="modal-body">${esc(message)}</div>
      <div class="modal-actions">
        <button class="dlg-btn ghost" data-act="cancel">${esc(cancelLabel)}</button>
        <button class="dlg-btn ${danger ? 'danger' : 'primary'}" data-act="ok">${esc(confirmLabel)}</button>
      </div></div>`;
    document.body.appendChild(ov);
    requestAnimationFrame(() => ov.classList.add('in'));
    const close = (val) => {
      ov.classList.remove('in');
      setTimeout(() => ov.remove(), 180);
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      else if (e.key === 'Enter') { e.preventDefault(); close(true); }
    };
    document.addEventListener('keydown', onKey);
    ov.addEventListener('click', (e) => {
      if (e.target === ov) return close(false);
      const act = e.target.closest('[data-act]');
      if (act) close(act.dataset.act === 'ok');
    });
    ov.querySelector('[data-act="ok"]').focus();
  });
}
const osIcon = (os) => icon(os === 'windows' ? 'windows' : 'apple', 'os');
// Machine status shown AS the OS icon — green when online, red when offline.
const osStatus = (n) => `<span class="os-status ${n.online ? 'on' : 'off'}" title="${n.os === 'windows' ? 'Windows' : 'macOS'} · ${n.online ? 'online' : 'offline'}">${osIcon(n.os)}</span>`;

const PRODUCT_NAMES = {}; // filled from state
let state = null;

// ------------------------------------------------------------------ tabs ---
document.querySelectorAll('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// --------------------------------------------------------------- helpers ---
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

// Compare dotted versions: -1, 0, 1.
function cmpVersion(a, b) {
  const pa = String(a).split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b).split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// First numeric component = the "major" (AE 26.x · C4D/RS/RG/MX 2026.x · CC 6.x).
const verMajor = (v) => { const m = String(v || '').match(/\d+/); return m ? Number(m[0]) : 0; };

// Products Adobe keeps current on its own — we display the version but never offer
// to update them. The enterprise package installs fine but can't set the Creative
// Cloud desktop app's version (Adobe self-updates it), so "updating" CC always
// looked like a failure. Tracked-for-display, not managed.
const SELF_UPDATING = new Set(['creativecloud']);
// Manager/launcher apps we don't surface as update targets — they ride along with the
// creative apps they sit under (CC nudged after any install; the Maxon stack is refreshed
// by the Maxon product installers). Still tracked in Catalog/Activity, just hidden from
// the dashboard tiles, the "updates" count, and the update wizard.
// Self-managed managers: CC self-updates; Maxon App rides along — so they get NO
// auto-deploy toggle (shown as "self-managed"), but they DO have a Track toggle like
// everything else (default off). Their version logic still runs regardless server-side.
const SELF_MANAGED = new Set(['creativecloud', 'maxonapp']);
// An app is hidden from the dashboard when its Track toggle is off (dashboard_hidden=1 =
// not tracked: no dashboard/count/wizard/updates).
const isHidden = (p) => !!p && p.dashboard_hidden === 1;
// OS-appropriate latest version (NotchLC ships different versions on Windows vs macOS).
const latestForOS = (p, os) => (os === 'windows' ? p.latest_win : p.latest_mac) || p.latest_version;

// selfupdate (Adobe-managed) | uptodate | patch (same major — safe in-place) |
// major (older major — opt-in side-by-side) | missing | unknown.
function productStatus(node, product) {
  const sw = node.software.find((s) => s.product_key === product.key);
  if (SELF_UPDATING.has(product.key)) {
    // Adobe-managed: show ✓ once it's reached the newest version we've seen, else ↻.
    if (!sw || !sw.version) return { status: 'selfupdate', version: sw ? sw.version : null };
    if (product.latest_version && cmpVersion(sw.version, product.latest_version) >= 0)
      return { status: 'uptodate', version: sw.version };
    return { status: 'selfupdate', version: sw.version };
  }
  if (!sw) return { status: 'missing', version: null };
  const latest = latestForOS(product, node.os);   // per-OS (NotchLC differs win vs mac)
  if (!latest) return { status: 'unknown', version: sw.version };
  if (!sw.version) return { status: 'unknown', version: null };
  if (cmpVersion(sw.version, latest) >= 0) return { status: 'uptodate', version: sw.version };
  const kind = verMajor(sw.version) === verMajor(latest) ? 'patch' : 'major';
  return { status: kind, version: sw.version };
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ------------------------------------------------------------- dashboard ---
const BADGE_LABEL = { uptodate: 'up to date', patch: 'update available', major: 'new major available', missing: 'not installed', selfupdate: 'self-updating (Adobe-managed)', unknown: '?' };

const filters = { search: '', os: '', status: '', product: '', sort: 'hostname', view: 'grid' };

// Newest registered package for a product on a given OS (or null).
function newestPackage(productKey, os) {
  return state.packages
    .filter((p) => p.product_key === productKey && p.os === os)
    .sort((a, b) => cmpVersion(a.version, b.version))
    .pop() || null;
}

function nodeOutdatedCount(n) {
  return state.products.reduce((c, p) =>
    c + (!isHidden(p) && ['patch', 'major'].includes(productStatus(n, p).status) ? 1 : 0), 0);
}

function visibleNodes() {
  let list = state.nodes.slice();
  const q = filters.search.toLowerCase();
  if (q) list = list.filter((n) => n.hostname.toLowerCase().includes(q));
  if (filters.os) list = list.filter((n) => n.os === filters.os);
  if (filters.status === 'online') list = list.filter((n) => n.online);
  if (filters.status === 'offline') list = list.filter((n) => !n.online);
  if (filters.status === 'outdated') list = list.filter((n) => nodeOutdatedCount(n) > 0);
  if (filters.status === 'current') list = list.filter((n) => nodeOutdatedCount(n) === 0);
  if (filters.product) {
    list = list.filter((n) => ['patch', 'major'].includes(productStatus(n, state.products.find((p) => p.key === filters.product)).status));
  }
  const sorters = {
    hostname: (a, b) => a.hostname.localeCompare(b.hostname),
    outdated: (a, b) => nodeOutdatedCount(b) - nodeOutdatedCount(a) || a.hostname.localeCompare(b.hostname),
    lastseen: (a, b) => (b.last_seen || 0) - (a.last_seen || 0),
    os: (a, b) => a.os.localeCompare(b.os) || a.hostname.localeCompare(b.hostname),
  };
  return list.sort(sorters[filters.sort] || sorters.hostname);
}

// Per-product cell: version + badge + an Update button when a package can fix it.
// Outdated/missing badges are clickable — they jump to the Update wizard prefilled.
const PROG_LABEL = {
  pending: () => icon('clock') + 'queued',
  downloading: () => icon('download') + 'downloading',
  installing: () => icon('spinner', 'spin') + 'installing',
};

// One single-line, icon-only chip per product row. Exactly one of:
//   live progress chip › blue ⬆ update button › status icon (✓ / ⚠ / – / ?).
// The words live in tooltips; the blue button REPLACES the outdated badge.
function productCell(n, p) {
  const st = productStatus(n, p);
  // An active job for this node+product replaces everything with a live chip.
  const job = state.jobs.find((j) => j.hostname === n.hostname && j.product_key === p.key
    && ['pending', 'downloading', 'installing'].includes(j.status));
  if (job) {
    // Dashboard rows stay icon-only: phase icon + colour, words in the tooltip.
    const ic = job.status === 'installing' ? icon('spinner', 'spin')
      : job.status === 'downloading' ? icon('download') : icon('clock');
    return { st, chip: '',
      prog: `<span class="badge icon inprogress ${job.status}" title="${job.status === 'pending' ? 'queued' : job.status}">${ic}</span>` };
  }
  let chip;
  if (st.status === 'patch') {
    // Same major, behind — safe in-place update. One-click if a package exists.
    const pkg = newestPackage(p.key, n.os);
    chip = (pkg && cmpVersion(pkg.version, st.version || '0') > 0)
      ? `<button class="upd-btn icon" onclick="quickUpdate(${n.id},${pkg.id},this)"
          title="Update ${esc(p.name)} ${esc(st.version)} → ${esc(p.latest_version)} on ${esc(n.hostname)}">${icon('up')}</button>`
      : `<span class="badge icon patch clickable" onclick="gotoUpdate('${p.key}','${n.os}',${n.id})"
          title="Update available (${esc(st.version)} → ${esc(p.latest_version)}) — click to update ${esc(p.name)} on ${esc(n.hostname)}">${icon('up')}</span>`;
  } else if (st.status === 'major') {
    // Older major — opt-in side-by-side install, not an in-place patch.
    chip = `<span class="badge icon major clickable" onclick="gotoUpdate('${p.key}','${n.os}',${n.id},true)"
      title="New major available (${esc(st.version)} → ${esc(p.latest_version)}) — opt-in side-by-side install, ${esc(p.name)} on ${esc(n.hostname)}">${icon('up')}</span>`;
  } else if (st.status === 'missing') {
    chip = `<span class="badge icon missing clickable" onclick="gotoUpdate('${p.key}','${n.os}',${n.id},true)"
      title="${esc(p.name)} not installed — click to install on ${esc(n.hostname)}">${icon('x')}</span>`;
  } else if (st.status === 'selfupdate') {
    chip = `<span class="badge icon selfupd" title="${esc(p.name)} ${esc(st.version || '')} — Adobe keeps this updated automatically; not managed here">${icon('refresh')}</span>`;
  } else if (st.status === 'uptodate') {
    chip = `<span class="badge icon uptodate" title="Up to date">${icon('check')}</span>`;
  } else {
    chip = `<span class="badge icon unknown" title="No latest version known yet">${icon('help')}</span>`;
  }
  return { st, chip, prog: '' };
}

// Shield badge: is this node elevated (can install silently) or will it prompt?
// Icon-only — the tooltip carries the words.
function elevBadge(n) {
  if (n.elevated === 1) return `<span class="badge icon elev-ok" title="Ready — installs run with no prompts">${icon('shieldOk')}</span>`;
  if (n.elevated === 0) return `<span class="badge icon elev-no" title="Needs elevation — an install would hit a UAC/root prompt">${icon('shieldOff')}</span>`;
  return ''; // null = older agent that doesn't report it yet
}

// Jump to the Updates tab with the wizard prefilled for one product on one machine.
function gotoUpdate(productKey, os, nodeId, major) {
  document.querySelector('nav button[data-tab="deploy"]').click();
  wizSel.products = new Set([productKey]);
  wizSel.os = os;
  wizSel.target = 'choose';
  wizSel.includeMajor = !!major;
  wizChosen.clear();
  wizChosen.add(nodeId);
  updateWizard();
  document.getElementById('wizard-panel').scrollIntoView({ behavior: 'smooth' });
}

// Dashboard ↔ Updates linking: jump straight to the relevant Update view.
function goToUpdates() {
  document.querySelector('nav button[data-tab="deploy"]').click();
  document.getElementById('up-products')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function goToActivity() {
  document.querySelector('nav button[data-tab="deploy"]').click();
  jobFilters.status = 'active';
  const seg = document.getElementById('job-status-seg');
  if (seg) {
    seg.dataset.val = 'active';
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === 'active'));
  }
  renderDeploy();
  document.querySelector('.act-head')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Compact duration: 45s, 2m, 1h10m.
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h' + (m % 60 ? (m % 60) + 'm' : '');
}
// Precise elapsed time for a finished install (m + s) — an actual duration, not an estimate.
function fmtTook(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return (m % 60) ? `${h}h ${m % 60}m` : `${h}h`;
}

function renderDashboard() {
  const { nodes, products } = state;
  const vis = products.filter((p) => !isHidden(p)); // managers hidden — they ride along
  const online = nodes.filter((n) => n.online).length;
  let behind = 0;
  for (const n of nodes) for (const p of vis) {
    const s = productStatus(n, p).status;
    if (s === 'patch' || s === 'major') behind++;
  }
  const activeJobs = state.jobs.filter((j) =>
    ['pending', 'downloading', 'installing'].includes(j.status)).length;
  const elevated = nodes.filter((n) => n.elevated === 1).length;

  const onlineCls = online === nodes.length ? 'ok' : 'warn';
  const readyCls = elevated === nodes.length ? 'ok' : 'warn';
  document.getElementById('summary-cards').innerHTML = `
    <div class="stat-panel">
      <div class="stat combo">
        <div class="trio">
          <span class="t"><b>${nodes.length}</b><em>nodes</em></span>
          <span class="sep">/</span>
          <span class="t"><b class="${onlineCls}">${online}</b><em>online</em></span>
          <span class="sep">/</span>
          <span class="t"><b class="${readyCls}">${elevated}</b><em>ready</em></span>
        </div>
      </div>
      <div class="stat link ${behind ? 'warn' : 'ok'}" onclick="goToUpdates()" title="Open Update software"><span class="num">${behind}</span><span class="label">updates</span></div>
      <div class="stat link ${activeJobs ? 'warn' : ''}" onclick="goToActivity()" title="See active jobs in Update activity"><span class="num">${activeJobs}</span><span class="label">active jobs</span></div>
    </div>`;

  // product filter options (once)
  const pf = document.getElementById('f-product');
  if (pf.options.length !== vis.length + 1) {
    pf.innerHTML = '<option value="">All products</option>' +
      vis.map((p) => `<option value="${p.key}">Outdated: ${esc(p.name)}</option>`).join('');
    pf.value = filters.product;
  }

  const grid = document.getElementById('node-grid');
  if (!nodes.length) {
    grid.className = '';
    grid.innerHTML = `<div class="empty">No nodes yet. Enrol a render node using the panel below.</div>`;
    document.getElementById('f-count').textContent = '';
    return;
  }
  const shown = visibleNodes();
  document.getElementById('f-count').textContent =
    `${shown.length} of ${nodes.length} nodes`;

  if (filters.view === 'table') {
    grid.className = 'table-view';
    grid.innerHTML = `<table class="node-table">
      <tr><th>Node</th><th>Seen</th>${vis.map((p) => `<th title="${esc(p.name)}">${tileLogo(p.key, 'xs')}</th>`).join('')}<th></th></tr>
      ${shown.map((n) => `<tr>
        <td><span class="node-cell">${osStatus(n)} ${esc(n.hostname)}</span></td>
        <td>${ago(n.last_seen)}</td>
        ${vis.map((p) => { const { st, chip, prog } = productCell(n, p);
          return `<td><div class="prod-cell">${esc(st.version || '—')} ${prog || chip}</div></td>`;
        }).join('')}
        <td class="node-actions"><button class="node-reboot" title="Reboot ${esc(n.hostname)} (via Deadline — interrupts any active render)" onclick="rebootNode(${n.id})">${icon('refresh')}</button></td>
      </tr>`).join('')}
    </table>`;
    return;
  }

  grid.className = '';
  grid.innerHTML = shown.map((n) => {
    return `
    <div class="node ${n.online ? '' : 'offline'}">
      <div class="node-head">
        ${osStatus(n)}
        <span class="name">${esc(n.hostname)}</span>
        ${elevBadge(n)}
        <button class="node-reboot" title="Reboot ${esc(n.hostname)} (via Deadline — interrupts any active render)" onclick="rebootNode(${n.id})">${icon('refresh')}</button>
      </div>
      <div class="meta">${esc(n.ip || '')} · last seen ${ago(n.last_seen)}</div>
      <table>${vis.map((p) => {
        const { st, chip, prog } = productCell(n, p);
        return `<tr>
          <td><span class="prod-name">${tileLogo(p.key, 'xs')}${esc(p.name)}</span></td>
          <td class="ver">${esc(st.version || '—')} ${prog || chip}</td>
        </tr>`;
      }).join('')}</table>
    </div>`;
  }).join('') || '<div class="empty">No nodes match the current filters.</div>';
}

async function quickUpdate(nodeId, packageId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const r = await api('POST', '/api/quick-update', { node_id: nodeId, package_id: packageId });
    if (btn) btn.textContent = r.queued.length ? 'queued' : (r.note || 'queued');
    refresh();
  } catch (e) { toast(e.message, 'error'); if (btn) btn.disabled = false; }
}

async function removeNode(id, name) {
  if (!await uiConfirm(`Remove node "${name}" from the tracker? It will reappear if its agent is still running.`, { title: 'Remove node', confirmLabel: 'Remove', danger: true })) return;
  await api('DELETE', `/api/nodes/${id}`);
  refresh();
}

// Reboot a machine via Deadline RemoteControl — recovers a wedged/hung agent.
async function rebootNode(id) {
  const n = state.nodes.find((x) => x.id === id);
  const name = n ? n.hostname : `#${id}`;
  if (!await uiConfirm(`Reboot ${esc(name)}? This goes through Deadline and will interrupt any render currently running on it. Use it to recover a stuck/unresponsive agent.`,
    { title: 'Reboot machine', confirmLabel: 'Reboot', danger: true })) return;
  try {
    const r = await api('POST', `/api/nodes/${id}/reboot`);
    toast(r.confirmed
      ? `Reboot sent to ${name} — it'll drop offline and come back in a few minutes.`
      : `Reboot sent to ${name} — should drop offline shortly. (Deadline didn't return a confirmation, which is normal when a machine reboots before replying.)`,
      'success');
  } catch (e) { toast(`Reboot failed for ${name}: ${e.message}`, 'error'); }
}

// wire toolbar (re-render locally without a network round-trip for snappy typing)
function wireToolbar() {
  const map = { 'f-search': 'search', 'f-os': 'os', 'f-status': 'status',
    'f-product': 'product', 'f-sort': 'sort' };
  for (const [id, key] of Object.entries(map)) {
    const el = document.getElementById(id);
    const ev = id === 'f-search' ? 'input' : 'change';
    el.addEventListener(ev, () => { filters[key] = el.value; if (state) renderDashboard(); });
  }
  // Card/Table view is a graphical segmented toggle (not a dropdown).
  document.getElementById('f-view-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    filters.view = b.dataset.v;
    b.parentElement.dataset.val = b.dataset.v;
    b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    if (state) renderDashboard();
  });
}
wireToolbar();

// ------------------------------------------------------------ update wizard ---
// Generic macOS installer: .pkg direct, or .dmg (mount → run the .pkg inside → detach).
const MACOS_PKG = 'F="{file}"; if echo "$F" | grep -qi "\\.dmg$"; then ' +
  'M=$(mktemp -d); hdiutil attach "$F" -nobrowse -mountpoint "$M" >/dev/null 2>&1; ' +
  'P=$(find "$M" -maxdepth 3 -name "*.pkg" | head -1); ' +
  'if [ -n "$P" ]; then installer -pkg "$P" -target /; R=$?; else echo "no .pkg in dmg"; R=1; fi; ' +
  'hdiutil detach "$M" >/dev/null 2>&1; exit $R; else installer -pkg "$F" -target /; fi';
// Maxon macOS: BitRock installer inside the .app — mount the .dmg, run installbuilder.sh
// unattended. Runs as root. (--skipMaxonAppGui was REMOVED in the 2026.3-era installers —
// passing it makes the installer exit 1 with "Unknown option".)
const MACOS_MAXON = 'F="{file}"; M=$(mktemp -d); hdiutil attach "$F" -nobrowse -mountpoint "$M" >/dev/null 2>&1; ' +
  'IB=$(find "$M" -maxdepth 4 -name installbuilder.sh | head -1); ' +
  'if [ -n "$IB" ]; then "$IB" --mode unattended --unattendedmodeui none; R=$?; ' +
  'else P=$(find "$M" -maxdepth 3 -name "*.pkg" | head -1); installer -pkg "$P" -target /; R=$?; fi; ' +
  'hdiutil detach "$M" >/dev/null 2>&1; exit $R';
// Windows Maxon (BitRock): plain unattended (no --skipMaxonAppGui — see note above).
const WIN_MAXON = '"{file}" --mode unattended --unattendedmodeui none';
// Adobe CC desktop (mac): the dmg holds an Install.app (NOT a pkg) — run its
// binary with Adobe's documented silent flag.
const MACOS_CC = 'F="{file}"; M=$(mktemp -d); hdiutil attach "$F" -nobrowse -mountpoint "$M" >/dev/null 2>&1; ' +
  'I=$(find "$M" -maxdepth 3 -path "*Install.app/Contents/MacOS/Install" | head -1); ' +
  'if [ -n "$I" ]; then "$I" --mode=silent; R=$?; ' +
  'else P=$(find "$M" -maxdepth 3 -name "*.pkg" | head -1); installer -pkg "$P" -target /; R=$?; fi; ' +
  'hdiutil detach "$M" >/dev/null 2>&1; exit $R';
// Redshift standalone disables its Cinema 4D plugin component by default —
// enable it so C4D actually renders with the new version, not its bundled one.
// (Only PLUGIN groups are valid here; the Redshift core always installs and
// "RedshiftCoreGroup" is rejected as an unknown component.)
const RS_COMPONENTS = ' --enable-components Cinema4DGroup,PluginC4D2026';
const WIN_RS = WIN_MAXON + RS_COMPONENTS;
const MACOS_RS = MACOS_MAXON.replace('--mode unattended --unattendedmodeui none; R=$?',
  '--mode unattended --unattendedmodeui none' + RS_COMPONENTS + '; R=$?');
// Blender macOS: .dmg holds Blender.app — mount, replace /Applications/Blender.app.
const MACOS_BLENDER = 'F="{file}"; M=$(mktemp -d); hdiutil attach "$F" -nobrowse -mountpoint "$M" >/dev/null 2>&1; ' +
  'A=$(find "$M" -maxdepth 2 -name "Blender.app" | head -1); ' +
  'if [ -n "$A" ]; then rm -rf /Applications/Blender.app; cp -R "$A" /Applications/; R=$?; else R=1; fi; ' +
  'hdiutil detach "$M" >/dev/null 2>&1; exit $R';
// FFmpeg is a static binary in a zip (no installer). Extract it to a tracker-managed,
// PATH-friendly location: C:\ProgramData\TrackerAgent\ffmpeg on Windows, /usr/local/bin on macOS.
const WIN_FFMPEG = 'rd /s /q "%TEMP%\\ffx" 2>nul & mkdir "%TEMP%\\ffx" & tar -xf "{file}" -C "%TEMP%\\ffx" & ' +
  'mkdir "C:\\ProgramData\\TrackerAgent\\ffmpeg" 2>nul & ' +
  'for /r "%TEMP%\\ffx" %i in (ffmpeg.exe ffprobe.exe) do copy /y "%i" "C:\\ProgramData\\TrackerAgent\\ffmpeg\\" >nul & ver >nul';
const MACOS_FFMPEG = 'F="{file}"; D=$(mktemp -d); unzip -o "$F" -d "$D" >/dev/null 2>&1; ' +
  'B=$(find "$D" -maxdepth 2 -name ffmpeg -type f | head -1); ' +
  'if [ -n "$B" ]; then mkdir -p /usr/local/bin; cp "$B" /usr/local/bin/ffmpeg; chmod +x /usr/local/bin/ffmpeg; R=$?; else R=1; fi; ' +
  'rm -rf "$D"; exit $R';
// Silent-install command defaults per product/OS, so users never type them.
const INSTALL_PRESETS = {
  cinema4d:      { windows: WIN_MAXON, macos: MACOS_MAXON },
  redshift:      { windows: WIN_RS, macos: MACOS_RS },
  redgiant:      { windows: WIN_MAXON, macos: MACOS_MAXON },
  aftereffects:  { windows: '"{file}" --silent', macos: MACOS_PKG },
  // Maxon App: BitRock + its own extra switches (from Maxon's winget manifest) —
  // don't auto-launch the app after install, and self-elevate cleanly.
  maxonapp:      { windows: WIN_MAXON + ' --do_not_execute_maxonapp 1 --elevated 1',
                   macos: MACOS_MAXON.replace('--mode unattended --unattendedmodeui none; R=$?',
                     '--mode unattended --unattendedmodeui none --do_not_execute_maxonapp 1; R=$?') },
  creativecloud: { windows: '"{file}" --silent', macos: MACOS_CC },
  blender:       { windows: 'msiexec /i "{file}" /qn /norestart', macos: MACOS_BLENDER },
  ffmpeg:        { windows: WIN_FFMPEG, macos: MACOS_FFMPEG },
  notchlc:       { windows: '"{file}" /S', macos: MACOS_PKG },  // NSIS silent (Win) / .pkg (Mac)
};
const presetCommand = (k, os) => (INSTALL_PRESETS[k] && INSTALL_PRESETS[k][os]) || (os === 'macos' ? MACOS_PKG : '"{file}"');

// After Effects has no normal vendor installer in the staged/link flow — it
// patches in place via Adobe Remote Update Manager. The binaries are staged in
// installers/. (Creative Cloud desktop is NOT here: Adobe self-updates it and the
// enterprise package can't set its version — see SELF_UPDATING.)
// Persist RUM to a fixed path on first AE update so detect_adobe_latest can use it
// later (Windows nodes have the Adobe stack but no permanent RUM otherwise).
// AEFT = After Effects, AME = Adobe Media Encoder. Always patch them together (RUM
// only updates products already installed, so AME is a no-op where it isn't present).
const RUM_AE_WIN = 'copy /y "{file}" "C:\\ProgramData\\TrackerAgent\\RemoteUpdateManager.exe" >nul & '
  + '"C:\\ProgramData\\TrackerAgent\\RemoteUpdateManager.exe" --productVersions=AEFT,AME --action=install';
// Windows nodes that have AE already carry the Adobe updater stack, so RUM.exe runs
// standalone from the downloaded file.
// macOS: the agent runs as root. The Mac Admin Console pkg carries RUM + the stack;
// install it only if RUM isn't present yet, then patch AE — fully self-bootstrapping.
const RUM_AE_MAC = 'if [ ! -x /usr/local/bin/RemoteUpdateManager ]; then installer -pkg "{file}" -target /; fi; '
  + '/usr/local/bin/RemoteUpdateManager --productVersions=AEFT,AME --action=install';
const ADOBE_RUM = {
  aftereffects: {
    windows: { filename: 'RemoteUpdateManager.exe',  command: RUM_AE_WIN, how: 'updates After Effects + Media Encoder via Adobe RUM' },
    macos:   { filename: 'Adobe_CC_No-Apps_Mac.pkg', command: RUM_AE_MAC, how: 'updates After Effects + Media Encoder via Adobe RUM' },
  },
};
const shortUrl = (u) => { try { const x = new URL(u); return x.hostname + (x.pathname.length > 1 ? '/…' : ''); } catch { return u.slice(0, 30); } };

const wizVal = (id) => document.getElementById(id).value;
const wizSel = { products: new Set(), os: 'both', target: 'outdated', mSearch: '', sourceTouched: false, includeMajor: false };
const wizChosen = new Set(); // node ids picked in "Pick machines"

const wizProducts = () => [...wizSel.products].map((k) => state.products.find((p) => p.key === k)).filter(Boolean);
const savedSource = (prod, os) => (os === 'windows' ? prod.source_url_win : prod.source_url_mac);
const stagedFor = (prod, os) => (os === 'windows' ? prod.staged_win : prod.staged_mac);
// Version token from an installer filename (mirror of the server's deploy guard).
const versionFromFilename = (f) => { const m = String(f || '').match(/(\d+(?:\.\d+){1,3})/); return m ? m[1] : null; };
// Is a deployable installer for the product's CURRENT latest version on the server?
// Adobe = RUM (no staged file needed); otherwise a staged installer whose version is
// >= the detected latest. A staged-but-older file does NOT count (it can't reach latest).
function latestInstallerReady(prod, os) {
  if (ADOBE_RUM[prod.key]) return !!ADOBE_RUM[prod.key][os];
  const want = latestForOS(prod, os);   // per-OS (NotchLC: win 1.3.1, mac 1.4.3)
  const fv = versionFromFilename(stagedFor(prod, os));
  return !!(fv && (!want || cmpVersion(fv, want) >= 0));
}
const wizOsList = () => (wizSel.os === 'both' ? ['windows', 'macos'] : [wizSel.os]);
const nodesByKind = (prod, osList, kinds) =>
  state.nodes.filter((n) => osList.includes(n.os) && kinds.includes(productStatus(n, prod).status));
// patch = safe in-place; major = older major + fresh installs (opt-in side-by-side).
const patchNodes = (prod, osList) => nodesByKind(prod, osList, ['patch']);
const majorNodes = (prod, osList) => nodesByKind(prod, osList, ['major', 'missing']);
// What "Update now" will actually target, given the include-major choice.
const targetableNodes = (prod, osList) =>
  nodesByKind(prod, osList, wizSel.includeMajor ? ['patch', 'major', 'missing'] : ['patch']);

function syncWizSource() {
  const mode = wizVal('up-source');
  const both = wizSel.os === 'both';
  const prods = wizProducts();
  const multi = prods.length > 1;
  const prod = prods[0];
  const show = (id, on) => { document.getElementById(id).style.display = on ? '' : 'none'; };
  show('up-url', mode === 'url');
  document.getElementById('up-url').placeholder = both ? 'Windows installer link' : 'https://… (your account / NAS / mirror link)';
  show('up-url-mac', mode === 'url' && both);
  show('up-file', mode === 'file');
  show('up-file-mac', mode === 'file' && both);
  // The version box only matters when the source can't infer it (link/file);
  // auto and "on the server" use the auto-detected latest version.
  show('up-version', !multi && ['saved', 'url', 'file'].includes(mode));
  document.querySelector('.wiz-check').style.display = mode === 'url' ? '' : 'none';
  const note = document.getElementById('up-source-note');
  if (mode === 'auto') {
    // Graphic per-product source map: ✓ on server · ⬇ downloads once · ⚠ no source.
    note.innerHTML = `<div class="src-grid">` + prods.map((p) => {
      const pills = wizOsList().map((os) => {
        const adobe = ADOBE_RUM[p.key];
        let s;
        if (adobe) {
          s = adobe[os] ? ['ok', 'check', adobe[os].how] : ['warn', 'alert', 'Mac Adobe package not built yet'];
        } else {
          const f = stagedFor(p, os);
          const fv = f ? versionFromFilename(f) : null;
          if (fv && (!p.latest_version || cmpVersion(fv, p.latest_version) >= 0)) s = ['ok', 'check', `${f} — ready`];
          else if (f) s = ['warn', 'alert', `staged ${fv} is older than ${p.latest_version} — add the ${p.latest_version} installer`];
          else if (savedSource(p, os)) s = ['dl', 'download', 'downloads once from the saved link'];
          else s = ['warn', 'alert', `no ${p.latest_version || 'latest'} installer & no saved link`];
        }
        return `<span class="src-pill ${s[0]}" title="${os === 'windows' ? 'Windows' : 'macOS'}: ${s[2]}">${osIcon(os)}${icon(s[1])}</span>`;
      }).join('');
      return `<div class="src-tile">${tileLogo(p.key, 'sm')}<span class="src-name">${esc(p.name)}</span>${pills}</div>`;
    }).join('') + `</div>`;
  } else if (mode === 'staged') {
    const parts = [];
    for (const p of prods) for (const os of wizOsList()) {
      const f = stagedFor(p, os);
      parts.push(f ? `<code>${esc(f)}</code>`
        : `<b style="color:var(--warn)">${esc(p.name)} (${os}) not on server</b>`);
    }
    note.innerHTML = `<b>Download once, reuse.</b> Distributes an installer already on your server/share to every node over the LAN — one vendor download total. ${parts.join(' · ')}`;
  } else if (multi) {
    note.innerHTML = `<b style="color:var(--warn)">Multiple products selected</b> — they update from installers on the server. To use a link or specific file, select a single product.`;
  } else if (mode === 'saved' && prod) {
    const parts = wizOsList().map((os) => {
      const s = savedSource(prod, os);
      return s ? `${os}: <code>${esc(shortUrl(s))}</code>` : `no saved ${os} link`;
    });
    note.innerHTML = `Saved link(s) — ${parts.join(' · ')}. The server fetches, then pushes to the machines.`;
  } else if (mode === 'url') {
    note.innerHTML = `Vendor installers need your account login — paste an authenticated/share link, a NAS path, or an internal mirror URL.${both ? ' Windows and macOS need separate installers — one link each.' : ''}`;
  } else {
    note.innerHTML = `Files from the <code>installers/</code> folder or your share.${both ? ' Pick one file per OS.' : ''}`;
  }
}

// Brand-style monogram tiles — instant visual recognition, no text needed.
const TILE = {
  aftereffects:  ['Ae',  '#2b2250', '#cfb3ff'],
  creativecloud: ['CC',  '#4a1010', '#ff9d9d'],
  cinema4d:      ['C4D', '#0d2d57', '#8ec5ff'],
  maxonapp:      ['MX',  '#3c1030', '#ff9ad5'],
  redgiant:      ['RG',  '#4a2010', '#ffb38f'],
  redshift:      ['RS',  '#451310', '#ff9d8f'],
  blender:       ['Bl',  '#2a1c06', '#ffb04d'],
  ffmpeg:        ['FF',  '#0c2a1c', '#5ad18f'],
  notchlc:       ['NL',  '#0a2230', '#5fd0e6'],
};
// Real app icons: PNGs from the installed apps (blender = its .app icon; ffmpeg = the
// official logo from ffmpeg.org's favicon) plus a hand-made SVG for redshift (no good
// extractable icon).
const ICON_KEYS = new Set(['aftereffects', 'creativecloud', 'cinema4d', 'maxonapp', 'redshift', 'redgiant', 'blender', 'ffmpeg', 'notchlc']);
const SVG_ICONS = new Set(['redshift']);
function tileLogo(key, cls = '') {
  if (ICON_KEYS.has(key)) {
    const ext = SVG_ICONS.has(key) ? 'svg' : 'png';
    return `<img class="cc-logo ${cls}" src="icons/${key}.${ext}" alt="${esc(PRODUCT_NAMES[key] || key)}" loading="lazy">`;
  }
  const [abbr, bg, fg] = TILE[key] || [key.slice(0, 2).toUpperCase(), '#22303f', '#9fb3c8'];
  return `<span class="cc-logo ${cls}" style="background:${bg};color:${fg}">${abbr}</span>`;
}

// Step 1 — multi-select product cards.
function renderProductCards() {
  document.getElementById('up-products').innerHTML = state.products.filter((p) => !isHidden(p)).map((p) => {
    const patch = patchNodes(p, wizOsList()).length;
    const major = majorNodes(p, wizOsList()).length;
    const ready = wizOsList().every((os) => latestInstallerReady(p, os));
    let badge, majBadge = '';
    if (!patch && !major) {
      badge = `<span class="cc-badge ok">all current</span>`;
    } else if (!ready) {
      // A newer version was detected but its installer isn't on the server yet.
      badge = `<span class="cc-badge need" title="Version ${esc(p.latest_version || '')} was detected, but its installer isn't staged on the server. Add it via Options → source, then deploy.">${icon('alert')} installer needed</span>`;
    } else {
      badge = patch ? `<span class="cc-badge">${patch} to update</span>` : `<span class="cc-badge ok">all current</span>`;
      majBadge = major ? `<span class="cc-badge major" title="A newer major version exists — opt-in side-by-side install">${major} new major</span>` : '';
    }
    return `<button type="button" class="choice-card ${wizSel.products.has(p.key) ? 'sel' : ''}" data-key="${p.key}">
      <span class="cc-check">${icon('check')}</span>
      <span class="cc-top">${tileLogo(p.key)}
        <span class="cc-text">
          <span class="cc-name">${esc(p.name)}</span>
          <span class="cc-meta">${esc(p.latest_version || '—')}</span>
        </span>
      </span>
      <span class="cc-badges">${badge}${majBadge}</span>
      <span class="cc-dl" id="ccdl-${p.key}"></span>
    </button>`;
  }).join('');
  paintCardBars();
}

// ---- live download loaders inside the product cards ----
// Which product/OS an installer download belongs to, inferred from its filename.
function dlMatch(filename) {
  const f = (filename || '').toLowerCase();
  const key = /cinema\s?4d|c4d/.test(f) ? 'cinema4d'
    : /red[-_ ]?giant/.test(f) ? 'redgiant'
    : /redshift/.test(f) ? 'redshift'
    : /maxon[-_ ]?(app|one)/.test(f) ? 'maxonapp'
    : /creative[-_ ]?cloud|accc/.test(f) ? 'creativecloud'
    : /after[-_ .]?effects|aftereffects/.test(f) ? 'aftereffects' : null;
  const os = /\.exe$|[-_.]win/.test(f) ? 'windows'
    : /\.dmg$|\.pkg$|mac/.test(f) ? 'macos' : null;
  return { key, os };
}
let lastDownloads = [];
function paintCardBars() {
  for (const p of (state ? state.products : [])) {
    const slot = document.getElementById('ccdl-' + p.key);
    if (!slot) continue;
    const rows = lastDownloads
      .filter((d) => ['downloading', 'pending', 'error'].includes(d.status) && dlMatch(d.filename).key === p.key)
      .map((d) => {
        const os = dlMatch(d.filename).os;
        if (d.status === 'error') {
          return `<span class="cc-dl-row err" title="${esc(d.error || 'download failed')}">${os ? osIcon(os) : ''}${icon('alert')} download failed</span>`;
        }
        const pct = d.total ? Math.floor((d.received / d.total) * 100) : null;
        const gb = (d.received / 1073741824).toFixed(1);
        return `<span class="cc-dl-row" title="Downloading ${esc(d.filename)} to the server">
          ${os ? osIcon(os) : ''}
          <span class="cc-bar${pct === null ? ' indet' : ''}"><span class="fill" style="width:${pct === null ? 30 : pct}%"></span></span>
          <span class="cc-pct">${pct === null ? gb + ' GB' : pct + '%'}</span>
        </span>`;
      });
    slot.innerHTML = rows.join('');
  }
}
// Poll fast while a download is running, lazily otherwise.
async function pollDownloads() {
  let delay = 10000;
  try {
    const { downloads } = await api('GET', '/api/downloads');
    lastDownloads = downloads;
    if (downloads.some((d) => ['downloading', 'pending'].includes(d.status))) delay = 2000;
    paintCardBars();
  } catch { /* server briefly unreachable — retry on the slow cadence */ }
  setTimeout(pollDownloads, delay);
}
pollDownloads();

function renderSegs() {
  for (const [id, val] of [['up-os-seg', wizSel.os], ['up-target-seg', wizSel.target]]) {
    const seg = document.getElementById(id);
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === val));
  }
}

// How many of the selected products are outdated/missing on a node.
function nodeNeedsCount(n) {
  return wizProducts().filter((p) => ['patch', 'major'].includes(productStatus(n, p).status)).length;
}

// Step 4 — filterable machine chips.
function renderWizNodes() {
  const osList = wizOsList();
  const q = wizSel.mSearch.toLowerCase();
  const nodes = state.nodes
    .filter((n) => osList.includes(n.os) && (!q || n.hostname.toLowerCase().includes(q)))
    .sort((a, b) => a.hostname.localeCompare(b.hostname));
  document.getElementById('up-nodes').innerHTML = nodes.map((n) => {
    const need = nodeNeedsCount(n);
    return `<button type="button" class="machine-chip ${wizChosen.has(n.id) ? 'sel' : ''} ${n.online ? '' : 'off'}" data-id="${n.id}">
      ${osStatus(n)}
      <span class="mc-name">${esc(n.hostname)}</span>
      ${n.elevated === 0 ? `<span class="badge icon elev-no" title="Needs elevation — an install would stall at a prompt">${icon('shieldOff')}</span>` : ''}
      <span class="badge ${need ? 'outdated' : 'uptodate'}">${need ? need + ' to update' : 'current'}</span>
    </button>`;
  }).join('') || '<span class="empty">No machines match.</span>';
}

function updateWizard() {
  const prods = wizProducts();
  if (!prods.length) {
    // Nothing selected — reset the wizard to a clean zero state.
    document.getElementById('up-current').innerHTML = '<span class="hint">Pick an app to update</span>';
    document.getElementById('up-target-count').textContent = '0 machine(s) will update';
    const gb = document.getElementById('up-go'); gb.disabled = true; gb.title = 'Pick at least one app first';
    ['up-preview', 'up-elev-warn', 'up-installer-warn', 'up-major-row'].forEach((id) => {
      const el = document.getElementById(id); if (el) el.style.display = 'none';
    });
    renderProductCards();
    renderSegs();
    return;
  }
  const osList = wizOsList();
  const targetNodes = new Set();
  prods.forEach((p) => targetableNodes(p, osList).forEach((n) => targetNodes.add(n.id)));
  const majorIds = new Set();
  prods.forEach((p) => majorNodes(p, osList).forEach((n) => majorIds.add(n.id)));
  const multi = prods.length > 1;
  document.getElementById('up-version').placeholder =
    prods[0].latest_version ? `Version (default ${prods[0].latest_version})` : 'Version (e.g. 2026.3.0)';
  document.getElementById('up-current').innerHTML = multi
    ? `<b>${prods.length}</b> products selected`
    : (prods[0].latest_version ? `latest <b>${esc(prods[0].latest_version)}</b>` : 'no latest set');
  // Default to fully automatic: per product+OS, server installer or saved link.
  const srcSel = document.getElementById('up-source');
  if (!wizSel.sourceTouched) srcSel.value = 'auto';
  const choosing = wizSel.target === 'choose';
  document.querySelector('.machine-tools .search-wrap').style.display = choosing ? '' : 'none';
  document.getElementById('up-select-all').style.display = choosing ? '' : 'none';
  document.getElementById('up-nodes').style.display = choosing ? '' : 'none';
  document.getElementById('up-target-count').textContent =
    choosing ? `${wizChosen.size} selected` : `${targetNodes.size} machine(s) will update`;
  // New-major / fresh-install opt-in: only relevant in "outdated only" mode.
  const majRow = document.getElementById('up-major-row');
  if (!choosing && majorIds.size) {
    majRow.style.display = '';
    document.getElementById('up-major').checked = wizSel.includeMajor;
    document.getElementById('up-major-label').innerHTML =
      `Also install <b>${majorIds.size}</b> new-major / fresh install(s) — <span class="hint" style="margin:0">side-by-side, leaves the current version in place</span>`;
  } else { majRow.style.display = 'none'; }
  // Inline "what'll happen" preview — exactly which machines Update now will touch.
  const prev = document.getElementById('up-preview');
  if (!choosing && targetNodes.size) {
    const names = [...targetNodes].map((id) => state.nodes.find((n) => n.id === id))
      .filter(Boolean).sort((a, b) => a.hostname.localeCompare(b.hostname));
    prev.innerHTML = `<span class="up-preview-label">Will update</span>` +
      names.slice(0, 14).map((n) => `<span class="up-preview-chip">${osStatus(n)} ${esc(n.hostname)}</span>`).join('') +
      (names.length > 14 ? `<span class="up-preview-more">+${names.length - 14} more</span>` : '');
    prev.style.display = '';
  } else { prev.style.display = 'none'; }
  // Pre-flight: warn if any targeted machine can't install silently yet.
  const targetIds = choosing ? [...wizChosen] : [...targetNodes];
  const needElev = targetIds
    .map((id) => state.nodes.find((n) => n.id === id))
    .filter((n) => n && n.elevated === 0);
  const warn = document.getElementById('up-elev-warn');
  if (needElev.length) {
    warn.style.display = '';
    warn.innerHTML = `${icon('shieldOff')} <b>${needElev.length} machine(s) not ready</b> — installs there
      will wait at a permission prompt until elevated (one click, see the Setup tab):
      ${needElev.map((n) => esc(n.hostname)).join(', ')}`;
  } else warn.style.display = 'none';
  // Pre-flight: a selected product whose newer version has no staged installer can't deploy.
  const needInstaller = prods.filter((p) => !ADOBE_RUM[p.key]
    && (patchNodes(p, osList).length || majorNodes(p, osList).length)
    && !osList.every((os) => latestInstallerReady(p, os)));
  const instWarn = document.getElementById('up-installer-warn');
  if (needInstaller.length) {
    instWarn.style.display = '';
    instWarn.innerHTML = `${icon('alert')} <b>Installer not on the server</b> — `
      + needInstaller.map((p) => `${esc(p.name)} ${esc(p.latest_version || '')}`).join(', ')
      + ` ${needInstaller.length > 1 ? 'have' : 'has'} a newer version detected, but the matching installer isn't staged. `
      + `Add it (drop the installer on the share, or set a source link in Options), then deploy.`;
  } else instWarn.style.display = 'none';
  // Disable Update now when nothing selected can actually deploy (would only hit the guard).
  const deployable = prods.some((p) => ADOBE_RUM[p.key] || osList.every((os) => latestInstallerReady(p, os)));
  const goBtn = document.getElementById('up-go');
  goBtn.disabled = !deployable;
  goBtn.title = deployable ? '' : 'Stage the installer(s) first — see the warning above';
  if (!deployable && !choosing && targetNodes.size) {
    document.getElementById('up-target-count').textContent = `${targetNodes.size} behind — installer needed`;
  }
  renderProductCards();
  renderSegs();
  if (choosing) renderWizNodes();
  syncWizSource();
}

function renderWizard() { updateWizard(); }

async function runWizard() {
  const prods = wizProducts();
  const go = document.getElementById('up-go');
  const prog = document.getElementById('up-progress');
  prog.style.display = '';
  try {
    if (!prods.length) throw new Error('Pick at least one product.');
    go.disabled = true;
    const mode = wizVal('up-source');
    const target = wizSel.target;
    const chosenIds = [...wizChosen];
    if (target === 'choose' && !chosenIds.length) throw new Error('Select at least one machine.');
    // includeMajor: also touch major-behind / not-installed machines (opt-in
    // side-by-side). Off by default so "Update now" only does safe patches.
    const queue = async (id, os, includeMajor) => {
      if (target === 'outdated') return (await api('POST', '/api/update-outdated', { package_id: id, includeMajor })).queued;
      const ids = chosenIds.filter((nid) => state.nodes.find((n) => n.id === nid && n.os === os));
      return ids.length ? (await api('POST', '/api/deployments', { package_id: id, node_ids: ids })).queued : [];
    };
    const allQueued = [];
    const skipped = [];

    // Adobe (After Effects, Creative Cloud): no normal installer — update via
    // RUM / package redeploy from the staged binary, regardless of source mode.
    // RUM only patches within the installed major, so AE/CC are patch-only here.
    for (const prod of prods.filter((p) => ADOBE_RUM[p.key])) {
      const majBehind = majorNodes(prod, wizOsList()).length;
      if (majBehind) skipped.push(`${prod.name} — ${majBehind} machine(s) a major version behind: RUM only patches within a major; a new major needs an Admin Console full install`);
      for (const os of wizOsList()) {
        const cfg = ADOBE_RUM[prod.key][os];
        if (!cfg) { skipped.push(`${prod.name} (${os}) — no Adobe updater for this OS yet`); continue; }
        prog.textContent = `Queuing ${prod.name} (${os})…`;
        const body = cfg.kind === 'command'
          ? { product_key: prod.key, version: prod.latest_version || 'latest', os, kind: 'command', install_command: cfg.command }
          : { product_key: prod.key, version: prod.latest_version || 'latest', os, kind: 'installer', filename: cfg.filename, install_command: cfg.command };
        const { id } = await api('POST', '/api/packages', body);
        allQueued.push(...await queue(id, os, false));
      }
    }

    // Everything else uses the staged-installer / link flow.
    const normalProds = prods.filter((p) => !ADOBE_RUM[p.key]);
    if (normalProds.length) {
      if (!['auto', 'staged'].includes(mode) && normalProds.length > 1) {
        throw new Error('Use “Automatic” for several products at once — links/files apply to a single product.');
      }
      if (mode === 'auto') {
        // Per product+OS: use the staged installer, else download once from the
        // saved link (in-card bars show live progress), then queue.
        const tasks = [];
        for (const prod of normalProds) for (const os of wizOsList()) tasks.push({ prod, os });
        let downloading = 0;
        const tick = () => { prog.textContent =
          downloading ? `Downloading ${downloading} installer(s) to the server — progress on the cards above (keep this page open)…`
                      : 'Queuing updates…'; };
        tick();
        await Promise.all(tasks.map(async (t) => {
          t.filename = stagedFor(t.prod, t.os);
          if (!t.filename) {
            const src = savedSource(t.prod, t.os);
            if (!src) { skipped.push(`${t.prod.name} (${t.os}) — no installer on the server and no saved link`); return; }
            downloading++; tick();
            try { t.filename = await fetchUrlQuiet(src); }
            catch (e) { skipped.push(`${t.prod.name} (${t.os}) — download failed: ${e.message}`); }
            downloading--; tick();
          }
          if (!t.filename) return;
          const { id } = await api('POST', '/api/packages', {
            product_key: t.prod.key, version: latestForOS(t.prod, t.os) || 'latest', os: t.os,
            kind: 'installer', filename: t.filename, install_command: presetCommand(t.prod.key, t.os),
          });
          allQueued.push(...await queue(id, t.os, wizSel.includeMajor));
        }));
      } else if (mode === 'staged') {
        // Download once, reuse: distribute the staged installer over the LAN.
        for (const prod of normalProds) {
          for (const os of wizOsList()) {
            const filename = stagedFor(prod, os);
            if (!filename) { skipped.push(`${prod.name} (${os}) — not on the server`); continue; }
            prog.textContent = `Queuing ${prod.name} (${os}) from server…`;
            const { id } = await api('POST', '/api/packages', {
              product_key: prod.key, version: latestForOS(prod, os) || 'staged', os,
              kind: 'installer', filename, install_command: presetCommand(prod.key, os),
            });
            allQueued.push(...await queue(id, os, wizSel.includeMajor));
          }
        }
      } else {
        const prod = normalProds[0];
        const version = (wizVal('up-version').trim() || prod.latest_version || '').trim();
        if (!version) throw new Error('Enter the new version number (or set it on the Catalog tab).');
        for (const os of wizOsList()) {
          let filename, urlUsed = '';
          if (mode === 'file') {
            filename = os === 'macos' && wizSel.os === 'both' ? wizVal('up-file-mac') : wizVal('up-file');
            if (!filename) throw new Error(`Pick the ${os} installer file.`);
          } else {
            urlUsed = mode === 'saved' ? savedSource(prod, os)
              : (os === 'macos' && wizSel.os === 'both' ? wizVal('up-url-mac') : wizVal('up-url')).trim();
            if (!urlUsed) throw new Error(mode === 'saved'
              ? `No saved ${os} link yet — choose “Paste a download link”.` : `Paste the ${os} download link.`);
            prog.textContent = 'Fetching installer…';
            filename = await fetchUrlToCache(urlUsed, prog);
          }
          prog.textContent = 'Registering update…';
          const { id } = await api('POST', '/api/packages', {
            product_key: prod.key, version, os, kind: 'installer', filename, install_command: presetCommand(prod.key, os),
          });
          if (urlUsed && document.getElementById('up-remember').checked) {
            await api('PUT', `/api/products/${prod.key}`,
              os === 'windows' ? { source_url_win: urlUsed } : { source_url_mac: urlUsed });
          }
          allQueued.push(...await queue(id, os, wizSel.includeMajor));
        }
        document.getElementById('up-version').value = '';
      }
    }

    const uniq = [...new Set(allQueued)];
    prog.innerHTML = (uniq.length
      ? `Update queued on <b>${uniq.length}</b> machine(s) — they run a few at a time. `
      : 'Nothing queued — targets are current, offline, or already queued. ')
      + (skipped.length ? `<br><b style="color:var(--warn)">Skipped:</b> ${skipped.map(esc).join(' · ')}` : '');
    refresh();
  } catch (e) { prog.textContent = e.message; }
  finally { go.disabled = false; }
}

document.getElementById('up-products').addEventListener('click', (e) => {
  const c = e.target.closest('.choice-card'); if (!c) return;
  const k = c.dataset.key;
  wizSel.products.has(k) ? wizSel.products.delete(k) : wizSel.products.add(k); // toggle (can deselect all)
  wizSel.sourceTouched = false; // re-auto-pick source for the new selection
  updateWizard();
});
document.getElementById('up-os-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return; wizSel.os = b.dataset.v; updateWizard();
});
document.getElementById('up-target-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return; wizSel.target = b.dataset.v; updateWizard();
});
document.getElementById('up-nodes').addEventListener('click', (e) => {
  const c = e.target.closest('.machine-chip'); if (!c) return;
  const id = Number(c.dataset.id);
  wizChosen.has(id) ? wizChosen.delete(id) : wizChosen.add(id);
  c.classList.toggle('sel');
  document.getElementById('up-target-count').textContent = `${wizChosen.size} selected`;
});
document.getElementById('up-machine-search').addEventListener('input', (e) => {
  wizSel.mSearch = e.target.value; renderWizNodes();
});
document.getElementById('up-select-all').addEventListener('click', () => {
  const q = wizSel.mSearch.toLowerCase();
  const shown = state.nodes.filter((n) => wizOsList().includes(n.os) && (!q || n.hostname.toLowerCase().includes(q)));
  const allSel = shown.length && shown.every((n) => wizChosen.has(n.id));
  shown.forEach((n) => (allSel ? wizChosen.delete(n.id) : wizChosen.add(n.id)));
  renderWizNodes();
  document.getElementById('up-target-count').textContent = `${wizChosen.size} selected`;
});
document.getElementById('up-source').addEventListener('change', () => { wizSel.sourceTouched = true; updateWizard(); });
document.getElementById('up-major').addEventListener('change', (e) => { wizSel.includeMajor = e.target.checked; updateWizard(); });
document.getElementById('up-go').addEventListener('click', runWizard);

// Update activity filtering + sorting.
document.getElementById('job-status-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  jobFilters.status = b.dataset.v;
  b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
  renderDeploy();
});
document.getElementById('job-product').addEventListener('change', (e) => { jobFilters.product = e.target.value; renderDeploy(); });
document.getElementById('job-search').addEventListener('input', (e) => { jobFilters.search = e.target.value; renderDeploy(); });
document.getElementById('job-sort').addEventListener('change', (e) => { jobFilters.sort = e.target.value; renderDeploy(); });

// ---------------------------------------------------------------- deploy ---
const jobFilters = { status: 'all', product: '', search: '', sort: 'recent' };

function renderDeploy() {
  const { jobs } = state;
  const active = (s) => ['pending', 'downloading', 'installing'].includes(s);
  const bucket = (s) => active(s) ? 'active' : (s === 'success' ? 'done' : 'failed');

  // summary counts
  const c = { active: 0, queued: 0, done: 0, failed: 0 };
  jobs.forEach((j) => {
    if (active(j.status)) { c.active++; if (j.status === 'pending') c.queued++; }
    else if (j.status === 'success') c.done++; else c.failed++;
  });
  const summary = document.getElementById('job-summary');
  if (summary) summary.textContent = jobs.length
    ? `${c.active} active · ${c.queued} queued · ${c.done} done · ${c.failed} failed` : '';
  const stopAll = document.getElementById('job-stopall');
  if (stopAll) stopAll.style.display = c.active ? '' : 'none';
  const clearBtn = document.getElementById('job-clear');
  if (clearBtn) clearBtn.style.display = (c.done + c.failed) ? '' : 'none';

  // product filter dropdown (fill once)
  const psel = document.getElementById('job-product');
  if (psel && psel.options.length <= 1 && state.products.length) {
    psel.innerHTML = '<option value="">All software</option>' +
      state.products.map((p) => `<option value="${p.key}">${esc(p.name)}</option>`).join('');
    psel.value = jobFilters.product;
  }

  // filter + sort
  const q = jobFilters.search.toLowerCase();
  const rank = { downloading: 0, installing: 0, pending: 1, failed: 2, cancelled: 2, success: 3 };
  const pname = (k) => PRODUCT_NAMES[k] || k;
  const sorters = {
    recent: (a, b) => b.updated_at - a.updated_at,
    machine: (a, b) => a.hostname.localeCompare(b.hostname) || b.updated_at - a.updated_at,
    status: (a, b) => (rank[a.status] - rank[b.status]) || b.updated_at - a.updated_at,
    product: (a, b) => pname(a.product_key).localeCompare(pname(b.product_key)) || b.updated_at - a.updated_at,
  };
  const rows = jobs
    .filter((j) => (jobFilters.status === 'all' || bucket(j.status) === jobFilters.status)
      && (!jobFilters.product || j.product_key === jobFilters.product)
      && (!q || j.hostname.toLowerCase().includes(q)))
    .sort(sorters[jobFilters.sort] || sorters.recent);

  const CAP = 60;
  const jt = document.getElementById('job-table');
  jt.innerHTML = rows.length
    ? `<tr><th>Machine</th><th>Software</th><th>Status</th><th>ETA</th><th></th></tr>` +
      rows.slice(0, CAP).map((j) => {
        // Actions column: stop while running; log once finished. (Retry lives in the Status cell.)
        const stop = active(j.status)
          ? `<button class="link-btn danger" onclick="killJob(${j.id})" title="Stop this job">${icon('x')} stop</button>` : '';
        const logBtn = !active(j.status) && j.log
          ? `<button class="link-btn" onclick="toggleLog(${j.id})">log</button>` : '';
        let statusCell;
        if (j.status === 'downloading') {
          // Real LAN-transfer progress, measured by the server as it streams.
          const pct = typeof j.dl_pct === 'number' ? j.dl_pct : null;
          statusCell = `<span class="badge inprogress downloading">${icon('download')}
            <span class="dlbar${pct === null ? ' indet' : ''}"><span class="dlfill" style="width:${pct ?? 30}%"></span></span>${pct === null ? '' : pct + '%'}</span>`;
        } else if (j.status === 'installing' && j.stalled) {
          // No progress for far longer than usual — the agent's installer is likely stuck.
          statusCell = `<span class="badge inprogress blocked" title="No progress for much longer than this install usually takes — the agent may be stuck. Use Stop, then Retry.">${icon('alert')} stalled</span>`;
        } else if (j.status === 'installing') {
          // Progress is an estimate vs the learned typical install time for this product/OS.
          const pct = typeof j.inst_pct === 'number' ? j.inst_pct : null;
          statusCell = `<span class="badge inprogress installing" title="Estimated from typical install time for this app">${icon('spinner', 'spin')}
            <span class="dlbar${pct === null ? ' indet' : ''}"><span class="dlfill" style="width:${pct ?? 30}%"></span></span>${pct === null ? '' : pct + '%'}</span>`;
        } else if (j.status === 'pending') {
          // Surface WHY a queued job isn't moving, instead of a silent "queued".
          const node = state.nodes.find((n) => n.hostname === j.hostname);
          let warn = '', hint = '';
          if (node && !node.online) { warn = 'machine offline'; hint = 'Runs when the machine is back online.'; }
          else if (node && node.elevated === 0) { warn = 'needs elevation'; hint = 'Run Elevate-Tracker.cmd on it once (see Setup tab).'; }
          else if (/deferr|rendering/i.test(j.log || '')) { warn = 'rendering'; hint = 'Held so it never interrupts a render — runs when the machine is idle.'; }
          statusCell = warn
            ? `<span class="badge inprogress blocked" title="Queued — ${warn}. ${hint}">${icon('alert')} ${warn}</span>`
            : `<span class="badge inprogress pending">${icon('clock')}queued</span>`;
        } else {
          const pill = j.status === 'success' ? `<span class="badge uptodate">${icon('check')} success</span>`
            : j.status === 'failed' ? `<span class="badge ev-bad">${icon('alert')} failed</span>`
            : `<span class="badge ev-system">${icon('x')} stopped</span>`;
          // Retry sits right next to the status (not in the actions/log column).
          const retryBtn = ['failed', 'cancelled'].includes(j.status)
            ? `<button class="link-btn retry-inline" onclick="retryJob(${j.id})" title="Run this update again on ${esc(j.hostname)}">${icon('refresh')} retry</button>` : '';
          statusCell = pill + retryBtn;
        }
        // ETA column: time LEFT while installing, then how long it TOOK once finished.
        let etaCell = '<span class="eta-none">—</span>';
        if (j.status === 'installing' && !j.stalled && j.inst_eta_ms) {
          etaCell = `<span class="eta">~${fmtDur(j.inst_eta_ms)} left</span>`;
        } else if (j.status === 'success' && j.install_ms) {
          etaCell = `<span class="eta done" title="How long the install took">took ${fmtTook(j.install_ms)}</span>`;
        }
        const jn = state.nodes.find((n) => n.hostname === j.hostname);
        return `<tr>
          <td><span class="node-cell">${jn ? osStatus(jn) : ''} ${esc(j.hostname)}</span></td>
          <td><span class="prod-name">${tileLogo(j.product_key, 'xs')}${esc(PRODUCT_NAMES[j.product_key] || j.product_key)} ${esc(j.package_version)}</span></td>
          <td>${statusCell}</td>
          <td>${etaCell}</td>
          <td>${stop} ${logBtn}</td>
        </tr>
        <tr class="log-row" id="log-${j.id}" style="display:none"><td colspan="5">${esc(j.log || '')}</td></tr>`;
      }).join('') + (rows.length > CAP
        ? `<tr><td colspan="5" class="empty">+ ${rows.length - CAP} older — use the filters above to narrow.</td></tr>` : '')
    : `<tr><td class="empty">${jobs.length ? 'No jobs match these filters.' : 'No update jobs yet.'}</td></tr>`;
}

async function killJob(id) {
  if (!await uiConfirm('Stop this job? It will be marked cancelled and the machine freed for another update.', { title: 'Stop job', confirmLabel: 'Stop job', danger: true })) return;
  try { await api('POST', `/api/jobs/${id}/kill`); } catch (e) { toast(e.message, 'error'); }
  refresh();
}

async function retryJob(id) {
  try { await api('POST', `/api/jobs/${id}/retry`); } catch (e) { toast(e.message, 'error'); }
  refresh();
}

async function stopAllJobs() {
  if (!await uiConfirm('Stop ALL queued and running updates, farm-wide?', { title: 'Stop everything', confirmLabel: 'Stop all', danger: true })) return;
  try {
    const r = await api('POST', '/api/jobs/kill-all');
    toast(`Stopped ${r.stopped} job(s).`, 'success');
  } catch {
    // Older server without kill-all: stop each active job individually.
    const act = state.jobs.filter((j) => ['pending', 'downloading', 'installing'].includes(j.status));
    await Promise.all(act.map((j) => api('POST', `/api/jobs/${j.id}/kill`).catch(() => {})));
    toast(`Stopped ${act.length} job(s).`, 'success');
  }
  refresh();
}

// Clear finished activity (done/failed/stopped) — leaves in-progress jobs untouched.
async function clearFinishedJobs() {
  const finished = state.jobs.filter((j) => ['success', 'failed', 'cancelled'].includes(j.status)).length;
  if (!finished) return;
  if (!await uiConfirm(`Clear ${finished} finished job(s) from the activity list? In-progress updates stay.`,
    { title: 'Clear activity', confirmLabel: 'Clear all' })) return;
  try {
    const r = await api('POST', '/api/jobs/clear-finished');
    toast(`Cleared ${r.cleared} finished job(s).`, 'success');
  } catch (e) { toast(e.message, 'error'); }
  refresh();
}

function toggleLog(id) {
  const row = document.getElementById('log-' + id);
  row.style.display = row.style.display === 'none' ? '' : 'none';
}

// Parallel-safe download-to-server: no text progress (the in-card bars cover it).
async function fetchUrlQuiet(url) {
  const { dlId, filename } = await api('POST', '/api/download-url', { url });
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    const { downloads } = await api('GET', '/api/downloads');
    const d = downloads.find((x) => x.id === dlId);
    if (!d) throw new Error('download record lost');
    if (d.status === 'error') throw new Error(d.error || 'download failed');
    if (d.status === 'done') return filename;
  }
}

async function fetchUrlToCache(url, progEl) {
  const prog = progEl;
  prog.style.display = '';
  prog.textContent = 'Starting download…';
  const { dlId, filename } = await api('POST', '/api/download-url', { url });
  // Poll progress until done or error.
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const { downloads } = await api('GET', '/api/downloads');
    const d = downloads.find((x) => x.id === dlId);
    if (!d) throw new Error('download record lost');
    if (d.status === 'error') { prog.textContent = `Download failed: ${d.error}`; throw new Error(d.error); }
    const mb = (d.received / 1048576).toFixed(1);
    const tot = d.total ? ` / ${(d.total / 1048576).toFixed(1)} MB` : '';
    const pct = d.total ? ` (${Math.floor((d.received / d.total) * 100)}%)` : '';
    prog.textContent = `Downloading ${filename}: ${mb} MB${tot}${pct}`;
    if (d.status === 'done') { prog.textContent = `Downloaded ${filename} (${mb} MB)`; return filename; }
  }
}

async function refreshInstallerFiles() {
  const { files } = await api('GET', '/api/installer-files');
  const opts = '<option value="">choose a file…</option>' + files.map((f) => {
    const tag = f.source === 'cache' ? 'cache' : 'share';
    return `<option value="${esc(f.name)}">${esc(f.name)} · ${(f.size / 1048576).toFixed(0)} MB · ${tag}</option>`;
  }).join('');
  for (const id of ['up-file', 'up-file-mac']) {
    const sel = document.getElementById(id);
    if (!sel) continue;
    const cur = sel.value;
    sel.innerHTML = opts;
    sel.value = cur;
  }
}

// --------------------------------------------------------------- catalog ---
function renderCatalog() {
  const t = document.getElementById('catalog-table');
  t.innerHTML = `<tr><th title="Track this app. When off it's removed from the dashboard, counts, wizard, version checks, installer fetches and auto-deploy.">Track</th><th>Product</th><th>Latest version</th><th>Updated</th><th title="Keep this app current across the fleet automatically — installs it on nodes that lack it and updates nodes that are behind, one canary node first, then the rest">Auto-deploy</th></tr>` +
    state.products.map((p) => `<tr>
      <td class="track-cell"><label class="switch" title="Track ${esc(p.name)} — show it on the dashboard, counts, wizard. Off = ignore it.">
            <input type="checkbox" onchange="toggleDashboardVisible('${p.key}', this.checked)" ${p.dashboard_hidden ? '' : 'checked'}>
            <span class="switch-track"><span class="switch-thumb"></span></span>
          </label></td>
      <td><span class="prod-name">${tileLogo(p.key, 'xs')}${esc(p.name)}</span></td>
      <td>${(p.latest_win && p.latest_mac && p.latest_win !== p.latest_mac)
        ? `<span class="ver-os" title="This app ships different versions on Windows and macOS"><b>Win</b> ${esc(p.latest_win)} &nbsp;·&nbsp; <b>Mac</b> ${esc(p.latest_mac)}</span>`
        : (p.latest_version ? esc(p.latest_version) : '<span class="hint">auto-detected</span>')}</td>
      <td class="hint" style="white-space:nowrap" title="When this version was last detected">${p.updated_at ? ago(p.updated_at) : '—'}</td>
      <td>${SELF_MANAGED.has(p.key)
        ? '<span class="hint" title="Self-managed — CC self-updates; the Maxon App rides along with Maxon updates">self-managed</span>'
        : `<label class="switch" title="When on, ${esc(p.name)} auto-deploys across the fleet — installs where missing, updates where behind, one canary node first">
            <input type="checkbox" onchange="toggleAutodeploy('${p.key}', this.checked)" ${p.autodeploy ? 'checked' : ''}>
            <span class="switch-track"><span class="switch-thumb"></span></span>
            <span class="switch-label">${p.autodeploy ? 'On' : 'Off'}</span>
          </label>`}</td>
    </tr>`).join('');

  // download-folder control
  const dd = document.getElementById('dl-dir');
  if (dd && document.activeElement !== dd) dd.value = state.downloadDir || '';
  const note = document.getElementById('dl-dir-note');
  if (note) {
    note.innerHTML = /dropbox/i.test(state.downloadDir || '')
      ? `<span style="color:var(--warn)">${icon('alert')} Warning: this folder is inside Dropbox, so every installer will sync to the cloud — pick a folder on your server/share instead.</span>`
      : `Current: <code>${esc(state.downloadDir || '(default share)')}</code> &nbsp;·&nbsp; Tip: in Finder, right-click a folder → <b>Copy as Pathname</b> (⌥⌘C), then paste it above.`;
  }
}

async function saveDownloadDir(dir) {
  dir = (dir || document.getElementById('dl-dir').value || '').trim();
  if (!dir) return;
  try { await api('POST', '/api/settings', { downloadDir: dir }); toast('Download folder set to ' + dir, 'success'); refresh(); }
  catch (e) { toast(e.message, 'error'); }
}
document.getElementById('dl-dir-browse').addEventListener('click', () => browseFolder());
document.getElementById('dl-dir-save').addEventListener('click', () => saveDownloadDir());
// Paste/type a path and press Enter to save it directly.
document.getElementById('dl-dir').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveDownloadDir(); } });

// Finder-style server folder picker: Favorites/Locations sidebar, clickable breadcrumb
// path, a Name/Date/Size list (folders navigable, files shown for context), and a New
// Folder action. "Use this folder" sets + saves it.
async function browseFolder() {
  const start = document.getElementById('dl-dir').value.trim() || state.downloadDir || '';
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal fb-dialog" role="dialog" aria-modal="true" aria-label="Choose folder">
    <div class="modal-title">Choose download folder</div>
    <div class="fb-bar">
      <div class="fb-crumbs" id="fb-crumbs"></div>
      <button class="btn-soft fb-newbtn" data-act="newfolder" title="Create a new folder here">${icon('folder')} New Folder</button>
    </div>
    <div class="fb-body">
      <aside class="fb-side" id="fb-side"><div class="fb-empty">…</div></aside>
      <div class="fb-main">
        <div class="fb-row fb-head"><span class="fb-c-name">Name</span><span class="fb-c-date">Date Modified</span><span class="fb-c-size">Size</span></div>
        <div class="fb-list" id="fb-list"><div class="fb-empty">Loading…</div></div>
      </div>
    </div>
    <div class="fb-foot">
      <span class="fb-rw" id="fb-rw"></span>
      <div class="modal-actions" style="margin:0">
        <button class="dlg-btn ghost" data-act="cancel">Cancel</button>
        <button class="dlg-btn primary" data-act="use">Use this folder</button>
      </div>
    </div></div>`;
  document.body.appendChild(ov);
  requestAnimationFrame(() => ov.classList.add('in'));
  let cur = start;
  const close = () => { ov.classList.remove('in'); setTimeout(() => ov.remove(), 180); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey);
  const fmtDate = (ms) => ms ? new Date(ms).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const fmtSize = (b) => { if (!b) return ''; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, n = b; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i]; };
  const join = (base, name) => { const sep = base.includes('\\') ? '\\' : '/'; return base.replace(/[\\/]+$/, '') + sep + name; };
  const buildCrumbs = (p) => {
    const out = [];
    if (p.includes('\\')) {
      let acc = '';
      p.split('\\').filter(Boolean).forEach((s, i) => { acc = i === 0 ? s + '\\' : acc.replace(/\\$/, '') + '\\' + s; out.push({ name: s, path: acc }); });
    } else {
      out.push({ name: 'Root', path: '/' });
      let acc = '';
      for (const s of p.split('/').filter(Boolean)) { acc += '/' + s; out.push({ name: s, path: acc }); }
    }
    return out;
  };

  // sidebar: Favorites + Locations (server places)
  (async () => {
    let pl; try { pl = await api('GET', '/api/places'); } catch { pl = { favorites: [], locations: [] }; }
    const sec = (title, items) => (items && items.length) ? `<div class="fb-sec">${title}</div>` + items.map((i) =>
      `<div class="fb-place" data-go="${esc(i.path)}" title="${esc(i.path)}">${icon(i.icon || 'folder')}<span>${esc(i.name)}</span></div>`).join('') : '';
    ov.querySelector('#fb-side').innerHTML = (sec('Favorites', pl.favorites) + sec('Locations', pl.locations)) || '<div class="fb-empty">—</div>';
    ov.querySelectorAll('.fb-place').forEach((el) => el.classList.toggle('active', el.dataset.go === cur));
  })();

  async function load(dir) {
    const list = ov.querySelector('#fb-list');
    list.innerHTML = '<div class="fb-empty">Loading…</div>';
    let data;
    try { data = await api('GET', `/api/list-dirs?path=${encodeURIComponent(dir || '')}`); }
    catch (e) { list.innerHTML = `<div class="fb-empty">${esc(e.message)}</div>`; return; }
    cur = data.path;
    ov.querySelector('#fb-crumbs').innerHTML = buildCrumbs(data.path)
      .map((c, i, a) => `<span class="fb-crumb${i === a.length - 1 ? ' cur' : ''}" data-go="${esc(c.path)}">${esc(c.name)}</span>`)
      .join('<span class="fb-sep">›</span>');
    ov.querySelector('#fb-rw').innerHTML = data.writable
      ? `${icon('check')} writable` : `<span style="color:var(--warn)">${icon('alert')} read-only</span>`;
    ov.querySelectorAll('.fb-place').forEach((el) => el.classList.toggle('active', el.dataset.go === data.path));
    const rows = [];
    if (data.parent) rows.push(`<div class="fb-item up" data-go="${esc(data.parent)}"><span class="fb-c-name">${icon('up')}<span class="fb-tx">..</span></span><span class="fb-c-date"></span><span class="fb-c-size"></span></div>`);
    for (const d of data.dirs) rows.push(`<div class="fb-item" data-go="${esc(join(data.path, d.name))}"><span class="fb-c-name">${icon('folder')}<span class="fb-tx">${esc(d.name)}</span></span><span class="fb-c-date">${esc(fmtDate(d.mtime))}</span><span class="fb-c-size"></span></div>`);
    for (const f of (data.files || [])) rows.push(`<div class="fb-item file"><span class="fb-c-name">${icon('file')}<span class="fb-tx">${esc(f.name)}</span></span><span class="fb-c-date">${esc(fmtDate(f.mtime))}</span><span class="fb-c-size">${esc(fmtSize(f.size))}</span></div>`);
    list.innerHTML = rows.length ? rows.join('') : '<div class="fb-empty">Empty folder.</div>';
  }

  // Inline "New Folder" — adds an editable row; Enter creates it on the server.
  function newFolderRow() {
    const list = ov.querySelector('#fb-list');
    let row = ov.querySelector('#fb-newrow');
    if (row) { row.querySelector('input').focus(); return; }
    row = document.createElement('div');
    row.className = 'fb-item'; row.id = 'fb-newrow';
    row.innerHTML = `<span class="fb-c-name">${icon('folder')}<input class="fb-newinput" placeholder="untitled folder" spellcheck="false"></span><span class="fb-c-date"></span><span class="fb-c-size"></span>`;
    list.prepend(row);
    const inp = row.querySelector('input');
    inp.focus();
    inp.addEventListener('keydown', async (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { row.remove(); return; }
      if (e.key !== 'Enter') return;
      const name = inp.value.trim();
      if (!name) { row.remove(); return; }
      inp.disabled = true;
      try { await api('POST', '/api/mkdir', { path: join(cur, name) }); toast('Folder created: ' + name, 'success'); load(cur); }
      catch (err) { toast(err.message, 'error'); inp.disabled = false; inp.focus(); }
    });
    inp.addEventListener('blur', () => { if (!inp.value.trim()) row.remove(); });
  }

  ov.addEventListener('click', (e) => {
    if (e.target === ov) return close();
    const go = e.target.closest('[data-go]');
    if (go) return load(go.dataset.go);
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'newfolder') return newFolderRow();
    if (act.dataset.act === 'use') { close(); saveDownloadDir(cur); }
    else close();
  });
  load(start);
}

// Manual "Check now" — detect newest Maxon versions + auto-fetch installers on demand.
document.getElementById('cat-refresh').addEventListener('click', async (e) => {
  const btn = e.currentTarget; const orig = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = `${icon('refresh', 'spin')} checking…`;
  try {
    const r = await api('POST', '/api/check-maxon');
    const parts = [];
    if (r.bumped && r.bumped.length) parts.push('new: ' + r.bumped.join(', '));
    if (r.fetched && r.fetched.length) parts.push('fetching ' + r.fetched.length + ' installer(s)');
    toast(parts.length ? parts.join(' · ') : 'Checked — all Maxon versions are current.', parts.length ? 'success' : 'info');
    refresh();
  } catch (err) { toast(err.message, 'error'); }
  finally { btn.disabled = false; btn.innerHTML = orig; }
});


// Per-app auto-deploy toggle (saves immediately; enabling kicks off a canary).
async function toggleAutodeploy(key, on) {
  try {
    await api('PUT', `/api/products/${key}`, { autodeploy: on ? 1 : 0 });
    toast(`Auto-deploy ${on ? 'enabled' : 'disabled'} for ${PRODUCT_NAMES[key] || key}`
      + (on ? ' — installs where missing & updates where behind, canary first.' : ''), on ? 'success' : 'info');
  } catch (e) { toast(e.message, 'error'); }
  refresh();
}

// Show/hide a product on the dashboard (checked = shown).
async function toggleDashboardVisible(key, shown) {
  try {
    await api('PUT', `/api/products/${key}`, { dashboard_hidden: shown ? 0 : 1 });
    toast(`${PRODUCT_NAMES[key] || key} ${shown ? 'shown on' : 'hidden from'} the dashboard.`, shown ? 'success' : 'info');
  } catch (e) { toast(e.message, 'error'); }
  refresh();
}

// -------------------------------------------------------------- activity ---
// Per-kind chip: label + icon + colour. Job events get outcome colours instead.
const EV_META = {
  node:       { label: 'machine',   ic: 'server',   cls: 'ev-node' },
  job:        { label: 'install',   ic: 'activity', cls: 'ev-system' },
  deploy:     { label: 'queued',    ic: 'download', cls: 'ev-deploy' },
  package:    { label: 'installer', ic: 'package',  cls: 'ev-package' },
  catalog:    { label: 'version',   ic: 'refresh',  cls: 'ev-catalog' },
  monitoring: { label: 'system',    ic: 'cog',      cls: 'ev-system' },
};
function evChip(e) {
  let m = EV_META[e.kind] || { label: e.kind, ic: 'dot', cls: 'ev-system' };
  if (e.kind === 'job') {
    if (/success/i.test(e.message)) m = { label: 'success', ic: 'check', cls: 'ev-ok' };
    else if (/failed|reaped|stalled/i.test(e.message)) m = { label: 'failed', ic: 'alert', cls: 'ev-bad' };
    else if (/cancelled/i.test(e.message)) m = { label: 'stopped', ic: 'x', cls: 'ev-system' };
  }
  if (e.kind === 'catalog' && /auto-detected|newer/i.test(e.message)) {
    m = { label: 'new version', ic: 'up', cls: 'ev-catalog' };
  }
  return `<span class="ev-chip ${m.cls}">${icon(m.ic)}${m.label}</span>`;
}
const evFilters = { q: '', kind: '' };
function dayLabel(ts) {
  const d = new Date(ts), now = new Date();
  const day = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  if (day(d) === day(now)) return 'Today';
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (day(d) === day(y)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function renderActivity() {
  const t = document.getElementById('event-table');
  let evs = state.events;
  if (evFilters.kind) evs = evs.filter((e) => e.kind === evFilters.kind);
  if (evFilters.q) evs = evs.filter((e) => e.message.toLowerCase().includes(evFilters.q));
  document.getElementById('ev-count').textContent =
    evs.length === state.events.length ? `${evs.length} events` : `${evs.length} of ${state.events.length} events`;
  if (!evs.length) { t.innerHTML = '<tr><td class="empty">No matching events.</td></tr>'; return; }
  let lastDay = '';
  t.innerHTML = evs.map((e) => {
    const dl = dayLabel(e.ts);
    const sep = dl !== lastDay ? `<tr class="ev-day"><td colspan="3">${dl}</td></tr>` : '';
    lastDay = dl;
    return `${sep}<tr class="ev-row">
      <td class="ev-time" title="${new Date(e.ts).toLocaleString()}">${new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
      <td>${evChip(e)}</td>
      <td class="ev-msg">${esc(e.message)}</td>
    </tr>`;
  }).join('');
}
document.getElementById('ev-search').addEventListener('input', (e) => {
  evFilters.q = e.target.value.toLowerCase(); renderActivity();
});
document.getElementById('ev-kind').addEventListener('change', (e) => {
  evFilters.kind = e.target.value; renderActivity();
});

// --------------------------------------------------------------- refresh ---
let editingCatalog = false;
document.addEventListener('focusin', (e) => {
  editingCatalog = e.target.matches('#catalog-table input');
});
document.addEventListener('focusout', () => { editingCatalog = false; });

// Don't re-render the wizard while the user is mid-interaction with it.
function editingWizard() {
  const a = document.activeElement;
  return a && a.closest && a.closest('#wizard-panel');
}

async function refresh() {
  try {
    state = await api('GET', '/api/state');
    // Display order across the whole app (CC first, then After Effects, then the rest).
    const ORDER = ['creativecloud', 'aftereffects', 'maxonapp', 'cinema4d', 'redgiant', 'redshift'];
    const oi = (k) => { const i = ORDER.indexOf(k); return i < 0 ? 99 : i; };
    state.products.sort((a, b) => oi(a.key) - oi(b.key));
    for (const p of state.products) PRODUCT_NAMES[p.key] = p.name;
    // Creative Cloud has no external "latest" feed (Adobe self-manages it), so treat
    // the newest version seen on any node as current. Nodes that reach it show ✓;
    // ones still behind keep the self-updating ↻ until they catch up.
    for (const p of state.products.filter((x) => SELF_UPDATING.has(x.key))) {
      let max = p.latest_version || '';
      for (const n of state.nodes) {
        const sw = (n.software || []).find((s) => s.product_key === p.key);
        if (sw && sw.version && (!max || cmpVersion(sw.version, max) > 0)) max = sw.version;
      }
      p.latest_version = max || p.latest_version;
    }
    renderDashboard();
    if (!editingWizard()) renderWizard();
    renderDeploy();
    if (!editingCatalog) renderCatalog();
    renderActivity();
    refreshInstallerFiles();
    document.getElementById('refresh-indicator').classList.remove('stale');
  } catch {
    document.getElementById('refresh-indicator').classList.add('stale');
  }
}

async function copyCmd(id) {
  await navigator.clipboard.writeText(document.getElementById(id).textContent);
}

async function loadEnrolCommands() {
  try {
    const { lanUrl } = await api('GET', '/api/agent-setup');
    const set = (id, t) => { const e = document.getElementById(id); if (e) e.textContent = t; };
    // Step 1 — enrol (no admin): monitoring agent.
    set('cmd-mac', `curl -fsSL ${lanUrl}/enroll.sh | bash`);
    set('cmd-win', `irm ${lanUrl}/enroll.ps1 | iex`);
    // Step 2 — elevation (one-time, admin): root daemon (mac) / highest-priv task (win).
    set('cmd-mac-elev', `curl -fsSL ${lanUrl}/setup.sh | sudo bash`);
    set('cmd-win-elev', `irm ${lanUrl}/elevate.ps1 | iex`);
  } catch { /* panel just keeps its placeholder */ }
}

// Paint all static icon placeholders (tabs, brand, search, labels).
function paintIcons() {
  document.getElementById('brand-ic').innerHTML = icon('server');
  document.querySelectorAll('[data-ic]').forEach((el) => {
    if (!el.dataset.painted) { el.innerHTML = icon(el.dataset.ic); el.dataset.painted = '1'; }
  });
}
paintIcons();

loadEnrolCommands();
refresh();
setInterval(refresh, 8000);
