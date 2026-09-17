// Machines: every render node — grid or table, quick filters, multi-select with bulk actions,
// a per-machine menu, hidden machines, and a detail drawer (#/machines/<hostname>).
import { html } from '../lib/html.js';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { signal } from '@preact/signals-core';
import { farm } from '../lib/store.js';
import { route, go } from '../lib/router.js';
import { get } from '../lib/api.js';
import { pref, openMenu, isTyping } from '../lib/ui.js';
import { ago, cmpVersion, parseJSON, plural } from '../lib/format.js';
import {
  normalizeProducts, productStatus, activeJobFor, outdatedProducts, nodeActivity, deadlineStatus,
  isTracked, newestPackage, agentOutdated, canShutdown, nodeIssues, AGENT_NAME,
} from '../lib/domain.js';
import * as act from '../lib/actions.js';
import { Icon, OsStatus, ProductLogo, Badge, Kpi, Bar, Empty } from '../components/common.js';

const view = pref('machines.view', 'grid');
const quick = pref('machines.quick', 'all');
const osFilter = pref('machines.os', 'all');
const sortBy = pref('machines.sort', 'name');
const search = signal('');
const selected = signal(new Set());

const QUICK = [
  ['all', 'All'],
  ['online', 'Online'],
  ['offline', 'Offline'],
  ['rendering', 'Rendering'],
  ['updating', 'Updating'],
  ['behind', 'Behind'],
  ['deadline', 'Deadline issues'],
  ['reboot', 'Needs reboot'],
];

export function useMachineModel() {
  const s = farm.value;
  return useMemo(() => {
    if (!s) return null;
    const products = normalizeProducts(s);
    const tracked = products.filter(isTracked);
    const names = new Map(products.map((p) => [p.key, p.name]));
    const nodes = s.nodes.map((n) => {
      const activity = nodeActivity(s, n, names);
      const dl = deadlineStatus(n);
      const behind = outdatedProducts(s, tracked, n);
      return { node: n, activity, dl, behind };
    });
    return { s, products, tracked, names, nodes };
  }, [s]);
}

const matchesQuick = (m, q) => {
  const { node: n, activity: a, dl, behind } = m;
  switch (q) {
    case 'online': return n.online;
    case 'offline': return !n.online;
    case 'rendering': return a.key === 'rendering';
    case 'updating': return ['installing', 'downloading', 'queued'].includes(a.key);
    case 'behind': return behind.length > 0;
    case 'deadline': return !!dl && dl.state !== 'ok';
    case 'reboot': return n.online && !!n.pending_reboot;
    default: return true;
  }
};

const SORTS = {
  name: (a, b) => a.node.hostname.localeCompare(b.node.hostname, undefined, { numeric: true }),
  behind: (a, b) => b.behind.length - a.behind.length || SORTS.name(a, b),
  seen: (a, b) => (b.node.last_seen || 0) - (a.node.last_seen || 0),
  gpu: (a, b) => (b.node.gpu_util ?? -1) - (a.node.gpu_util ?? -1) || SORTS.name(a, b),
  os: (a, b) => a.node.os.localeCompare(b.node.os) || SORTS.name(a, b),
};

// ---------------------------------------------------------------- per-machine menu
export function machineMenuItems(node, dl) {
  return [
    { label: 'Details', icon: 'chevron', onSelect: () => go('machines', node.hostname) },
    '-',
    node.online
      ? { label: 'Restart', icon: 'refresh', onSelect: () => act.restart([node]) }
      : { label: node.wake && node.wake.state === 'waking' ? 'Waking…' : 'Wake', icon: 'power', disabled: node.wake && node.wake.state === 'waking', onSelect: () => act.wake([node]) },
    { label: node.os === 'macos' ? 'Sleep (shut down)' : 'Shut down', icon: 'moon', danger: true, disabled: !canShutdown(node),
      title: canShutdown(node) ? null : 'Needs the machine online with a recent agent', onSelect: () => act.shutdown([node]) },
    dl && dl.state !== 'ok' && dl.canFix ? { label: 'Fix Deadline startup', icon: 'zap', onSelect: () => act.fixDeadline([node]) } : null,
    '-',
    { label: 'Hide from dashboard', icon: 'eyeOff', onSelect: () => act.setHidden([node.hostname], true) },
  ];
}

// ---------------------------------------------------------------- product cell
function StatusChip({ s, node, product, compact }) {
  const job = activeJobFor(s, node, product.key);
  if (job) {
    if (job.status === 'downloading') return html`<${Badge} tone="accent" icon="download" title="Downloading the installer">${job.dl_pct != null ? job.dl_pct + '%' : 'downloading'}<//>`;
    if (job.status === 'installing') return html`<${Badge} tone="accent" icon="spinner" title="Installing now">${job.cancel_requested_at ? 'stopping…' : 'installing'}<//>`;
    return html`<${Badge} tone="info" icon="clock" title=${job.log || 'Queued — starts when the machine is free'}>queued<//>`;
  }
  const st = productStatus(node, product);
  switch (st.status) {
    case 'uptodate': return compact ? html`<span style="color:var(--ok)" title="Up to date"><${Icon} name="check" /></span>` : html`<${Badge} tone="ok" icon="check">current<//>`;
    case 'patch': {
      const pkg = newestPackage(s, product.key, node.os);
      if (pkg && node.online && cmpVersion(pkg.version, st.version) > 0) {
        return html`<${Badge} tone="info" icon="up" title=${`Update ${product.name} ${st.version} → ${pkg.version} on ${node.hostname}`}
          onClick=${(e) => { e.stopPropagation(); act.quickUpdate(node, pkg, product.name); }}>${pkg.version}<//>`;
      }
      return html`<${Badge} tone="info" icon="up" title=${`Update available → ${st.target}`} onClick=${(e) => { e.stopPropagation(); go('updates'); }}>${st.target}<//>`;
    }
    case 'major': return html`<${Badge} tone="violet" title=${`New major ${st.target} — opt-in side-by-side install`} onClick=${(e) => { e.stopPropagation(); go('updates'); }}>new ${String(st.target).split('.')[0]}<//>`;
    case 'missing': return compact ? html`<span class="dim" title="Not installed">—</span>` : html`<${Badge} title="Not installed">not installed<//>`;
    case 'selfupdate': return html`<${Badge} icon="refresh" title="Adobe keeps this updated automatically">auto<//>`;
    case 'na': return html`<span class="dim" title="Not applicable on this machine">–</span>`;
    default: return html`<${Badge} title="No latest version known yet">?<//>`;
  }
}

// ---------------------------------------------------------------- badges on a machine
function DeadlineBadge({ node, dl }) {
  if (!dl || dl.state === 'ok') return null;
  const tone = dl.state === 'down' ? 'bad' : 'warn';
  return html`<${Badge} tone=${tone} icon="alert" title=${dl.detail + (dl.canFix ? ' Click to fix.' : '')}
    onClick=${dl.canFix ? (e) => { e.stopPropagation(); act.fixDeadline([node]); } : null}>${dl.label}<//>`;
}

function ActivityBadge({ a }) {
  const icon = { installing: 'spinner', downloading: 'download', queued: 'clock', rendering: 'film', reboot: 'refresh', offline: 'power' }[a.key];
  const tone = { accent: 'accent', info: 'info', violet: 'violet', warn: 'warn', bad: 'bad' }[a.tone] || '';
  if (a.key === 'idle') return html`<span class="dim" style="font-size:.78rem">Idle</span>`;
  return html`<${Badge} tone=${tone} icon=${icon} title=${a.detail}>${a.label}${a.detail && a.key !== 'rendering' ? ` · ${a.detail}` : ''}<//>`;
}

function WakeIndicator({ node }) {
  const w = node.wake;
  if (!w) return null;
  if (w.state === 'waking') return html`<${Badge} tone="accent" icon="spinner" title=${`Wake-on-LAN sent ${ago(w.requestedAt)}${w.relays && w.relays.length ? ` (also via ${w.relays.join(', ')})` : ''}`}>waking<//>`;
  if (w.state === 'failed' && !node.online) return html`<${Badge} tone="warn" title=${w.reason}>wake failed<//>`;
  return null;
}

const toggleSel = (id) => {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id); else next.add(id);
  selected.value = next;
};

// ---------------------------------------------------------------- grid card
function MachineCard({ m, model }) {
  const { node: n, activity: a, dl } = m;
  const sel = selected.value.has(n.id);
  return html`<article class=${`card mcard ${n.online ? '' : 'offline'} ${sel ? 'selected' : ''}`} onClick=${() => go('machines', n.hostname)}>
    <header class="mcard-head">
      <input type="checkbox" aria-label=${`Select ${n.hostname}`} checked=${sel} onClick=${(e) => { e.stopPropagation(); toggleSel(n.id); }} />
      <${OsStatus} node=${n} />
      <span class="mcard-name">${n.hostname}</span>
      <button class="btn ghost sm icon" aria-label="Machine actions" onClick=${(e) => { e.stopPropagation(); openMenu(e.currentTarget, machineMenuItems(n, dl)); }}><${Icon} name="more" /></button>
    </header>
    <div class="mcard-badges">
      <${ActivityBadge} a=${a} />
      <${WakeIndicator} node=${n} />
      <${DeadlineBadge} node=${n} dl=${dl} />
      ${n.online && n.pending_reboot ? html`<${Badge} tone="warn" icon="refresh" title="Windows has a restart pending">reboot<//>` : null}
      ${n.elevated === 0 ? html`<${Badge} tone="warn" icon="shieldOff" title="Needs elevation — installs would stop at a permission prompt">not ready<//>` : null}
    </div>
    <div class="mcard-meta">
      <span title=${n.gpu || ''}>${n.gpu ? n.gpu.replace(/NVIDIA GeForce |NVIDIA /g, '') : '—'}</span>
      <span>seen ${ago(n.last_seen, model.s.now)}</span>
    </div>
    <ul class="mcard-products">
      ${model.tracked.map((p) => {
        const st = productStatus(n, p);
        if (st.status === 'na') return null;
        return html`<li key=${p.key}>
          <${ProductLogo} product=${p} size=${16} />
          <span class="pname">${p.name}</span>
          <span class="pver mono">${st.version || '—'}</span>
          <${StatusChip} s=${model.s} node=${n} product=${p} compact />
        </li>`;
      })}
    </ul>
  </article>`;
}

// ---------------------------------------------------------------- table
function MachineTable({ rows, model }) {
  const allSel = rows.length && rows.every((m) => selected.value.has(m.node.id));
  return html`<div class="card table-wrap"><table class="table">
    <thead><tr>
      <th style="width:32px"><input type="checkbox" aria-label="Select all shown" checked=${allSel}
        onClick=${() => { selected.value = allSel ? new Set() : new Set(rows.map((m) => m.node.id)); }} /></th>
      <th>Machine</th><th>Activity</th><th>Deadline</th><th>GPU load</th><th>Behind</th>
      <th class="hide-sm">${AGENT_NAME}</th><th class="hide-sm">Driver</th><th class="hide-sm">Disk</th><th>Seen</th><th></th>
    </tr></thead>
    <tbody>${rows.map((m) => {
      const { node: n, activity: a, dl, behind } = m;
      const sel = selected.value.has(n.id);
      return html`<tr key=${n.id} class=${sel ? 'selected' : ''} style="cursor:pointer" onClick=${() => go('machines', n.hostname)}>
        <td onClick=${(e) => e.stopPropagation()}><input type="checkbox" aria-label=${`Select ${n.hostname}`} checked=${sel} onClick=${() => toggleSel(n.id)} /></td>
        <td class="nowrap"><span class="row" style="gap:10px;flex-wrap:nowrap"><${OsStatus} node=${n} /><b>${n.hostname}</b><${WakeIndicator} node=${n} /></span></td>
        <td><${ActivityBadge} a=${a} /></td>
        <td>${dl ? (dl.state === 'ok' ? html`<span style="color:var(--ok)" title=${dl.detail}><${Icon} name="check" /></span>` : html`<${DeadlineBadge} node=${n} dl=${dl} />`) : html`<span class="dim">—</span>`}</td>
        <td>${n.online && n.gpu_util != null ? html`<span class="row" style="flex-wrap:nowrap;gap:8px"><${Bar} pct=${n.gpu_util} /><span class="mono dim">${n.gpu_util}%</span></span>` : html`<span class="dim">—</span>`}</td>
        <td>${behind.length ? html`<${Badge} tone="info" title=${behind.map((p) => p.name).join(', ')}>${behind.length}<//>` : html`<span class="dim">0</span>`}</td>
        <td class="hide-sm mono" style=${agentOutdated(model.s, n) ? 'color:var(--warn)' : ''} title=${agentOutdated(model.s, n) ? `Latest is ${model.s.latestAgentVersion}` : ''}>${n.agent_version || '—'}</td>
        <td class="hide-sm mono dim">${n.gpu_driver || '—'}</td>
        <td class="hide-sm mono" style=${n.disk_free_gb != null && n.disk_free_gb < 20 ? 'color:var(--warn)' : ''}>${n.disk_free_gb != null ? `${Math.round(n.disk_free_gb)} GB` : '—'}</td>
        <td class="nowrap dim">${ago(n.last_seen, model.s.now)}</td>
        <td class="right" onClick=${(e) => e.stopPropagation()}><button class="btn ghost sm icon" aria-label="Machine actions" onClick=${(e) => openMenu(e.currentTarget, machineMenuItems(n, dl))}><${Icon} name="more" /></button></td>
      </tr>`;
    })}</tbody>
  </table></div>`;
}

// ---------------------------------------------------------------- hidden machines
function HiddenMachines() {
  const [hidden, setHidden] = useState(null);
  const [open, setOpen] = useState(false);
  const load = () => get('/api/hidden-nodes').then((r) => setHidden(r.hidden || [])).catch(() => setHidden([]));
  useEffect(() => { load(); }, [farm.value && farm.value.nodes.length]);
  if (!hidden || !hidden.length) return null;
  return html`<span style="position:relative">
    <button class="chip" onClick=${() => { setOpen(!open); load(); }}><${Icon} name="eyeOff" />Hidden <span class="n">${hidden.length}</span></button>
    ${open && html`<div class="menu" style="position:absolute;top:34px;right:0;min-width:220px">
      ${hidden.map((h) => html`<button key=${h} onClick=${async () => { setOpen(false); await act.setHidden([h], false); load(); }}>
        <${Icon} name="eye" /><span>${h}</span><span class="dim" style="margin-left:auto;font-size:.78rem">unhide</span></button>`)}
    </div>`}
  </span>`;
}

// ---------------------------------------------------------------- bulk bar
function BulkBar({ model }) {
  const ids = selected.value;
  if (!ids.size) return null;
  const nodes = model.nodes.map((m) => m.node).filter((n) => ids.has(n.id));
  const online = nodes.filter((n) => n.online).length;
  const offline = nodes.length - online;
  const fixable = model.nodes.filter((m) => ids.has(m.node.id) && m.dl && m.dl.canFix && m.dl.state !== 'ok').length;
  return html`<div class="bulkbar" role="toolbar" aria-label="Actions for selected machines">
    <b>${plural(nodes.length, 'machine')} selected</b>
    <button class="btn sm" disabled=${!online} onClick=${() => act.restart(nodes)}><${Icon} name="refresh" />Restart${online && offline ? ` ${online}` : ''}</button>
    <button class="btn sm" disabled=${!offline} onClick=${() => act.wake(nodes)}><${Icon} name="power" />Wake${offline && online ? ` ${offline}` : ''}</button>
    <button class="btn sm" disabled=${!fixable} onClick=${() => act.fixDeadline(nodes)}><${Icon} name="zap" />Fix Deadline${fixable ? ` ${fixable}` : ''}</button>
    <button class="btn sm danger" disabled=${!nodes.some(canShutdown)} onClick=${() => act.shutdown(nodes)}><${Icon} name="moon" />Shut down</button>
    <button class="btn sm" onClick=${async () => { await act.setHidden(nodes.map((n) => n.hostname), true); selected.value = new Set(); }}><${Icon} name="eyeOff" />Hide</button>
    <button class="btn ghost sm icon" aria-label="Clear selection" title="Clear selection (Esc)" onClick=${() => { selected.value = new Set(); }}><${Icon} name="close" /></button>
  </div>`;
}

// ---------------------------------------------------------------- drawer
function MachineDrawer({ hostname, model }) {
  const m = model.nodes.find((x) => x.node.hostname === hostname);
  const close = () => go('machines');
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !isTyping(e)) close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!m) {
    return html`<div class="drawer-back" onClick=${close}></div><aside class="drawer"><header><h2>${hostname}</h2><span class="grow"></span>
      <button class="btn ghost icon" aria-label="Close" onClick=${close}><${Icon} name="close" /></button></header>
      <div class="content"><${Empty}>No machine called ${hostname} (it may be hidden).<//></div></aside>`;
  }
  const { node: n, activity: a, dl } = m;
  const s = model.s;
  const issues = nodeIssues(s, model.tracked, n);
  const wol = parseJSON(n.wol_info);
  const fix = parseJSON(n.deadline_fix);
  const jobs = s.jobs.filter((j) => j.hostname === n.hostname).slice(0, 12);
  const events = s.events.filter((e) => e.message.includes(n.hostname)).slice(0, 12);
  return html`<div class="drawer-back" onClick=${close}></div>
  <aside class="drawer" role="dialog" aria-label=${n.hostname}>
    <header>
      <${OsStatus} node=${n} />
      <h2>${n.hostname}</h2>
      <${ActivityBadge} a=${a} />
      <span class="grow"></span>
      <button class="btn sm" onClick=${(e) => openMenu(e.currentTarget, machineMenuItems(n, dl))}><${Icon} name="more" />Actions</button>
      <button class="btn ghost icon" aria-label="Close" onClick=${close}><${Icon} name="close" /></button>
    </header>
    <div class="content">
      ${issues.length ? html`<div class="row">${issues.map((i) => html`<${Badge} tone=${i.tone}>${i.label}<//>`)}</div>` : html`<div class="banner info"><${Icon} name="check" />Nothing needs attention on this machine.</div>`}

      <section>
        <h3 class="section-title">Machine</h3>
        <dl class="kv">
          <dt>Status</dt><dd>${n.online ? 'Online' : 'Offline'} · last seen ${ago(n.last_seen, s.now)}</dd>
          <dt>IP</dt><dd class="mono">${(n.ip || '—').replace('::ffff:', '')}</dd>
          <dt>OS</dt><dd>${n.os_version || n.os}</dd>
          <dt>GPU</dt><dd>${n.gpu || '—'}${n.gpu_driver ? html` · driver <span class="mono">${n.gpu_driver}</span>` : ''}${n.online && n.gpu_util != null ? ` · ${n.gpu_util}% load` : ''}</dd>
          <dt>Disk</dt><dd>${n.disk_free_gb != null ? `${Math.round(n.disk_free_gb)} GB free of ${Math.round(n.disk_total_gb || 0)} GB` : '—'}</dd>
          <dt>${AGENT_NAME}</dt><dd class="mono">${n.agent_version || '—'}${agentOutdated(s, n) ? html` <span style="color:var(--warn)">(latest ${s.latestAgentVersion})</span>` : ''}</dd>
          <dt>Installs</dt><dd>${n.elevated === 1 ? 'Ready — run without prompts' : n.elevated === 0 ? html`<span style="color:var(--warn)">Needs elevation</span>` : '—'}</dd>
          ${n.pending_reboot ? html`<dt>Windows</dt><dd style="color:var(--warn)">Restart pending</dd>` : null}
        </dl>
      </section>

      ${dl && html`<section>
        <h3 class="section-title">Deadline</h3>
        <div class=${'banner ' + (dl.state === 'down' ? 'bad' : dl.state === 'fragile' ? 'warn' : 'info')}>
          <${Icon} name=${dl.state === 'ok' ? 'check' : 'alert'} /><span class="grow">${dl.detail}</span>
          ${dl.state !== 'ok' && dl.canFix ? html`<button class="btn sm" onClick=${() => act.fixDeadline([n])}><${Icon} name="zap" />Fix startup</button>` : null}
        </div>
        <dl class="kv" style="margin-top:10px">
          <dt>Worker</dt><dd>${dl.info.worker ? 'running' : 'not running'}${'launcher' in dl.info ? ` · Launcher ${dl.info.launcher ? 'running' : 'not running'}` : ''}</dd>
          <dt>Starts via</dt><dd>${(dl.info.how || []).join(', ') || 'nothing'}</dd>
          <dt>Auto-login</dt><dd>${dl.info.autologon == null ? '—' : dl.info.autologon ? 'on' : 'off'}${dl.info.user ? ` · desktop user ${dl.info.user}` : ''}</dd>
          ${fix && html`<dt>Last fix</dt><dd style=${fix.ok ? '' : 'color:var(--bad-text)'}>${ago(fix.at, s.now)} — ${fix.message}</dd>`}
        </dl>
      </section>`}

      ${!n.online && html`<section>
        <h3 class="section-title">Wake-on-LAN</h3>
        <p class="muted" style="margin:0 0 8px">${wol ? wol.note : n.os === 'macos' ? 'Macs wake from sleep only, over wired Ethernet.' : 'Network card readiness not reported yet.'}</p>
        ${n.wake && n.wake.state === 'failed' && html`<div class="banner warn" style="margin-bottom:8px"><${Icon} name="alert" />${n.wake.reason}</div>`}
        <button class="btn primary" disabled=${n.wake && n.wake.state === 'waking'} onClick=${() => act.wake([n])}><${Icon} name="power" />${n.wake && n.wake.state === 'waking' ? 'Waking…' : 'Wake'}</button>
      </section>`}

      <section>
        <h3 class="section-title">Software</h3>
        <div class="card table-wrap"><table class="table">
          <thead><tr><th>App</th><th>Installed</th><th>Status</th></tr></thead>
          <tbody>${model.products.map((p) => {
            const st = productStatus(n, p);
            if (st.status === 'na' && !(n.software || []).some((x) => x.product_key === p.key)) return null;
            return html`<tr key=${p.key} style=${isTracked(p) ? '' : 'opacity:.6'}>
              <td class="nowrap"><span class="row" style="flex-wrap:nowrap"><${ProductLogo} product=${p} size=${18} />${p.name}</span></td>
              <td class="mono">${st.version || '—'}</td>
              <td><${StatusChip} s=${s} node=${n} product=${p} /></td>
            </tr>`;
          })}</tbody>
        </table></div>
      </section>

      <section>
        <h3 class="section-title">Recent jobs</h3>
        ${jobs.length ? html`<ul class="plain-list">${jobs.map((j) => html`<li key=${j.id}>
          <${Badge} tone=${j.status === 'success' ? 'ok' : j.status === 'failed' ? 'bad' : ['pending', 'downloading', 'installing'].includes(j.status) ? 'accent' : ''}>${j.status}<//>
          <span>${model.names.get(j.product_key) || j.product_key} <span class="mono">${j.package_version}</span></span>
          <span class="dim" style="margin-left:auto">${ago(j.updated_at, s.now)}</span></li>`)}</ul>` : html`<p class="dim" style="margin:0">No jobs on this machine.</p>`}
      </section>

      <section>
        <h3 class="section-title">Activity</h3>
        ${events.length ? html`<ul class="plain-list">${events.map((e) => html`<li key=${e.id}><span class="dim nowrap">${ago(e.ts, s.now)}</span><span>${e.message}</span></li>`)}</ul>` : html`<p class="dim" style="margin:0">Nothing recent.</p>`}
      </section>
    </div>
  </aside>`;
}

// ---------------------------------------------------------------- page
export function MachinesView() {
  const model = useMachineModel();
  useEffect(() => {
    const onKey = (e) => {
      if (isTyping(e)) return;
      if (e.key === 'Escape' && selected.value.size && !route.value.params[0]) selected.value = new Set();
      if (e.key === '/') { e.preventDefault(); document.getElementById('machine-search')?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!model) return html`<div class="page"><${Empty}>Loading…<//></div>`;
  const { s, nodes } = model;

  const q = search.value.trim().toLowerCase();
  const counts = Object.fromEntries(QUICK.map(([k]) => [k, nodes.filter((m) => matchesQuick(m, k)).length]));
  const rows = nodes
    .filter((m) => matchesQuick(m, quick.value))
    .filter((m) => osFilter.value === 'all' || m.node.os === osFilter.value)
    .filter((m) => !q || m.node.hostname.toLowerCase().includes(q) || (m.node.gpu || '').toLowerCase().includes(q) || (m.node.ip || '').includes(q))
    .sort(SORTS[sortBy.value] || SORTS.name);

  const online = nodes.filter((m) => m.node.online).length;
  const rendering = counts.rendering;
  const updating = counts.updating;
  const dlDown = nodes.filter((m) => m.dl && m.dl.state === 'down').length;
  const dlFragile = nodes.filter((m) => m.dl && m.dl.state === 'fragile').length;
  const win = nodes.filter((m) => m.node.os === 'windows').length;
  const setQuick = (k) => { quick.value = quick.value === k ? 'all' : k; };

  const drawerHost = route.value.name === 'machines' ? route.value.params[0] : null;

  return html`<div class="page">
    <div class="kpis">
      <${Kpi} label="Machines" value=${nodes.length} sub=${`${win} Windows · ${nodes.length - win} Mac`} onClick=${() => { quick.value = 'all'; }} active=${quick.value === 'all'} />
      <${Kpi} label="Online" value=${`${online}/${nodes.length}`} tone=${online === nodes.length ? 'ok' : 'warn'} sub=${online === nodes.length ? 'all reachable' : `${nodes.length - online} offline`} onClick=${() => setQuick('offline')} active=${quick.value === 'offline'} />
      <${Kpi} label="Rendering" value=${rendering} sub="GPU busy right now" onClick=${() => setQuick('rendering')} active=${quick.value === 'rendering'} />
      <${Kpi} label="Updating" value=${updating} sub=${updating ? 'installing or queued' : 'nothing running'} onClick=${() => setQuick('updating')} active=${quick.value === 'updating'} />
      <${Kpi} label="Deadline issues" value=${dlDown + dlFragile} tone=${dlDown ? 'bad' : dlFragile ? 'warn' : 'ok'} sub=${dlDown || dlFragile ? `${dlDown} down · ${dlFragile} no auto-start` : 'all workers healthy'} onClick=${() => setQuick('deadline')} active=${quick.value === 'deadline'} />
      <${Kpi} label="Behind" value=${counts.behind} tone=${counts.behind ? 'warn' : 'ok'} sub=${counts.behind ? 'machines with updates' : 'everything current'} onClick=${() => setQuick('behind')} active=${quick.value === 'behind'} />
    </div>

    <div class="toolbar">
      <div class="row" style="gap:6px">
        ${QUICK.map(([k, label]) => html`<button key=${k} class=${'chip' + (quick.value === k ? ' on' : '')} onClick=${() => { quick.value = k; }}>${label}${k !== 'all' ? html` <span class="n">${counts[k]}</span>` : ''}</button>`)}
      </div>
      <span class="grow"></span>
      <label class="search"><${Icon} name="search" /><input id="machine-search" class="field" placeholder="Search machines, GPUs, IPs…  /" value=${search.value} onInput=${(e) => { search.value = e.currentTarget.value; }} style="width:240px" /></label>
      <div class="seg" role="group" aria-label="Operating system">
        ${[['all', 'All'], ['windows', 'Windows'], ['macos', 'Mac']].map(([k, l]) => html`<button key=${k} class=${osFilter.value === k ? 'on' : ''} onClick=${() => { osFilter.value = k; }}>${l}</button>`)}
      </div>
      <select class="field" aria-label="Sort" value=${sortBy.value} onChange=${(e) => { sortBy.value = e.currentTarget.value; }}>
        <option value="name">Sort: name</option><option value="behind">Sort: most behind</option><option value="gpu">Sort: GPU load</option><option value="seen">Sort: last seen</option><option value="os">Sort: OS</option>
      </select>
      <div class="seg" role="group" aria-label="View">
        <button class=${view.value === 'grid' ? 'on' : ''} title="Cards" onClick=${() => { view.value = 'grid'; }}><${Icon} name="grid" /></button>
        <button class=${view.value === 'table' ? 'on' : ''} title="Table" onClick=${() => { view.value = 'table'; }}><${Icon} name="table" /></button>
      </div>
      <${HiddenMachines} />
    </div>

    <p class="dim" style="margin:0 0 10px;font-size:.8rem">${rows.length === nodes.length ? plural(nodes.length, 'machine') : `${rows.length} of ${nodes.length} machines`}
      ${rows.length ? html` · <button class="linkish" onClick=${() => { selected.value = new Set(rows.map((r) => r.node.id)); }}>select all shown</button>` : ''}</p>

    ${!nodes.length ? html`<${Empty}>No machines yet — enroll one from Help → Getting started.<//>`
      : !rows.length ? html`<${Empty}>No machines match these filters.<//>`
      : view.value === 'table' ? html`<${MachineTable} rows=${rows} model=${model} />`
      : html`<div class="mgrid">${rows.map((m) => html`<${MachineCard} key=${m.node.id} m=${m} model=${model} />`)}</div>`}

    <${BulkBar} model=${model} />
    ${drawerHost && html`<${MachineDrawer} hostname=${drawerHost} model=${model} />`}
  </div>`;
}

export { selected as selectedMachines };

// Open Machines with a quick filter applied (used by Overview's shortcuts).
export function showMachines(filter = 'all') {
  quick.value = filter;
  go('machines');
}
