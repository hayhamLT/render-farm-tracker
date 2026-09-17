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
import { Icon, OsStatus, ProductLogo, Badge, Bar, Empty } from '../components/common.js';
import { PageHeader } from '../components/page.js';
import { MachineTimeline } from './timeline.js';
import { waitingRollout, whenLabel } from '../components/rollouts.js';
import { Sparkline, AreaChart, StackBar, Num, useMetrics, metrics, STATE_COLOR } from '../components/viz.js';

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
    const wr = waitingRollout(s, job);
    if (wr) return html`<${Badge} tone="info" icon="clock" title=${`Part of “${wr.name}”`}>${whenLabel(wr.run_at)}<//>`;
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
// The one state a machine is shown in (same rules as the Overview map).
function cardState(m) {
  const { node: n, activity: a, dl } = m;
  if (!n.online) return { key: 'offline', label: 'Offline' };
  if (dl && dl.state === 'down') return { key: 'deadline', label: 'Out of Deadline' };
  if (['installing', 'downloading'].includes(a.key)) return { key: 'installing', label: a.label, detail: a.detail };
  if (a.key === 'queued') return { key: 'queued', label: 'Queued', detail: a.detail };
  if (a.key === 'rendering') return { key: 'rendering', label: 'Rendering' };
  if (n.pending_reboot) return { key: 'reboot', label: 'Reboot pending' };
  return { key: 'idle', label: 'Idle' };
}

const gpuSeries = (id) => {
  const series = metrics.value && metrics.value.nodes && metrics.value.nodes[id];
  return series ? series.map((p) => p[1]) : [];
};

function MachineCard({ m, model }) {
  const { node: n, dl, behind } = m;
  const sel = selected.value.has(n.id);
  const st = cardState(m);
  const color = STATE_COLOR[st.key];
  const tracked = model.tracked.filter((p) => productStatus(n, p).status !== 'na');
  const current = tracked.filter((p) => ['uptodate', 'selfupdate'].includes(productStatus(n, p).status)).length;
  const gpu = n.online && n.gpu_util != null ? n.gpu_util : null;
  return html`<article class=${`card mcard2 s-${st.key} ${sel ? 'selected' : ''} ${selected.value.size ? 'selecting' : ''}`} style=${`--state:${color}`}
    onClick=${() => (selected.value.size ? toggleSel(n.id) : go('machines', n.hostname))}>
    <header class="mc-head">
      <label class="mc-check" onClick=${(e) => e.stopPropagation()}><input type="checkbox" aria-label=${`Select ${n.hostname}`} checked=${sel} onChange=${() => toggleSel(n.id)} /></label>
      <${OsStatus} node=${n} />
      <div class="mc-title"><b>${n.hostname}</b><span class="mc-state">${st.label}${st.detail ? html` <span class="muted">· ${st.detail}</span>` : ''}</span></div>
      <button class="btn ghost sm icon mc-more" aria-label="Machine actions" onClick=${(e) => { e.stopPropagation(); openMenu(e.currentTarget, machineMenuItems(n, dl)); }}><${Icon} name="more" /></button>
    </header>

    <div class="mc-gpu">
      <div class="mc-gpu-num">${gpu != null ? html`<${Num} value=${gpu} /><small>%</small>` : html`<span class="dim">—</span>`}<span class="mc-gpu-label">GPU</span></div>
      <${Sparkline} values=${gpuSeries(n.id)} width=${150} height=${36} color=${n.online ? 'var(--violet)' : 'var(--text-3)'} title="GPU load, last 48 h" />
    </div>

    <div class="mc-pills">
      ${dl ? (dl.state === 'ok'
        ? html`<${Badge} tone="ok" icon="film" title=${dl.detail}>Deadline<//>`
        : html`<${Badge} tone=${dl.state === 'down' ? 'bad' : 'warn'} icon="alert" title=${dl.detail + (dl.canFix ? ' Click to fix.' : '')}
            onClick=${dl.canFix ? (e) => { e.stopPropagation(); act.fixDeadline([n]); } : null}>${dl.state === 'down' ? 'Deadline down' : 'No auto-start'}<//>`) : null}
      ${behind.length
        ? html`<${Badge} tone="info" icon="up" title=${behind.map((p) => p.name).join(', ')} onClick=${(e) => { e.stopPropagation(); go('machines', n.hostname); }}>${plural(behind.length, 'update')}<//>`
        : tracked.length ? html`<${Badge} tone="ok" icon="check">Up to date<//>` : null}
      ${n.online && n.pending_reboot ? html`<${Badge} tone="warn" icon="refresh" title="Windows has a restart pending">Reboot<//>` : null}
      ${n.elevated === 0 ? html`<${Badge} tone="warn" icon="shieldOff" title="Needs elevation">Not ready<//>` : null}
      <${WakeIndicator} node=${n} />
    </div>

    ${tracked.length ? html`<${StackBar} height=${4} total=${tracked.length} title=${`${current} of ${tracked.length} apps current`} parts=${[
      { value: current, color: 'var(--ok)', label: 'current' },
      { value: behind.length, color: 'var(--info)', label: 'behind' },
    ]} />` : null}

    <footer class="mc-foot">
      <span title=${n.gpu || ''}>${n.gpu ? n.gpu.replace(/NVIDIA GeForce |NVIDIA /g, '') : n.os === 'macos' ? 'Apple silicon' : '—'}</span>
      <span>${ago(n.last_seen, model.s.now)}</span>
    </footer>

    <div class="mc-quick" onClick=${(e) => e.stopPropagation()}>
      ${n.online
        ? html`<button class="btn sm" onClick=${() => act.restart([n])}><${Icon} name="refresh" />Restart</button>`
        : html`<button class="btn sm primary" disabled=${n.wake && n.wake.state === 'waking'} onClick=${() => act.wake([n])}><${Icon} name="power" />Wake</button>`}
      <button class="btn sm" onClick=${() => go('machines', n.hostname)}>Details<${Icon} name="chevron" /></button>
    </div>
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
        <td><span class="row" style="flex-wrap:nowrap;gap:8px"><${Sparkline} values=${gpuSeries(n.id)} width=${90} height=${22} color="var(--violet)" /><span class="mono" style="width:38px;text-align:right">${n.online && n.gpu_util != null ? `${n.gpu_util}%` : '—'}</span></span></td>
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

      <section class="card card-pad" style="padding:12px 14px">
        <div class="row" style="justify-content:space-between;margin-bottom:6px"><h3 class="section-title" style="margin:0">GPU load · 48 h</h3>
          <span class="mono">${n.online && n.gpu_util != null ? `${n.gpu_util}% now` : 'offline'}</span></div>
        <${AreaChart} rows=${((metrics.value && metrics.value.nodes && metrics.value.nodes[n.id]) || []).map((p) => ({ ts: p[0], gpu: p[1] ?? 0 }))} height=${120} max=${100}
          series=${[{ key: 'gpu', label: 'GPU load', color: '#a78bfa' }]} format=${(v) => `${Math.round(v)}%`} />
      </section>

      <${MachineTimeline} node=${n} />

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
  useMetrics(48);
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
  const setQuick = (k) => { quick.value = quick.value === k ? 'all' : k; };
  const TONE = { online: 'var(--ok)', offline: 'var(--text-3)', rendering: 'var(--violet)', updating: 'var(--accent)', behind: 'var(--info)', deadline: 'var(--bad-text)', reboot: 'var(--warn)' };

  const drawerHost = route.value.name === 'machines' ? route.value.params[0] : null;

  return html`<div class="page">
    <${PageHeader} title="Machines" subtitle=${`${online} of ${nodes.length} online · ${counts.rendering} rendering · ${counts.updating} updating${counts.deadline ? ` · ${counts.deadline} with Deadline issues` : ''}`}>
      <label class="search"><${Icon} name="search" /><input id="machine-search" class="field" placeholder="Search name, GPU or IP   /" value=${search.value} onInput=${(e) => { search.value = e.currentTarget.value; }} style="width:260px" /></label>
    </${PageHeader}>

    <div class="filterbar">
      <div class="pills" role="tablist" aria-label="Filter machines">
        ${QUICK.map(([k, label]) => html`<button key=${k} role="tab" aria-selected=${quick.value === k} class=${'pill' + (quick.value === k ? ' on' : '')} onClick=${() => setQuick(k)} disabled=${k !== 'all' && !counts[k]}>
          ${k !== 'all' ? html`<i style=${`background:${TONE[k]}`}></i>` : null}${label}<span class="n">${k === 'all' ? nodes.length : counts[k]}</span></button>`)}
      </div>
      <span class="grow"></span>
      <div class="seg" role="group" aria-label="Operating system">
        ${[['all', 'All'], ['windows', 'Windows'], ['macos', 'Mac']].map(([k, l]) => html`<button key=${k} class=${osFilter.value === k ? 'on' : ''} onClick=${() => { osFilter.value = k; }}>${l}</button>`)}
      </div>
      <select class="field" aria-label="Sort" value=${sortBy.value} onChange=${(e) => { sortBy.value = e.currentTarget.value; }}>
        <option value="name">Name</option><option value="behind">Most updates</option><option value="gpu">GPU load</option><option value="seen">Last seen</option><option value="os">OS</option>
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
      : html`<div class="mgrid2">${rows.map((m) => html`<${MachineCard} key=${m.node.id} m=${m} model=${model} />`)}</div>`}

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
