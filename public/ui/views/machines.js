// Machines — the farm from the update point of view: which machines are behind, updating, or can't
// update right now (offline, rendering, not set up). Select machines to update everything on them.
// A machine's details (#/machines/<hostname>) list its apps with an Update button each, its install
// history and the basics. Deadline shows only when it's down.
import { html } from '../lib/html.js';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { signal } from '@preact/signals-core';
import { farm } from '../lib/store.js';
import { route, go } from '../lib/router.js';
import { get } from '../lib/api.js';
import { pref, openMenu, isTyping } from '../lib/ui.js';
import { ago, plural, parseJSON } from '../lib/format.js';
import {
  normalizeProducts, productStatus, activeJobFor, nodeActivity, deadlineStatus, isTracked, agentOutdated, canShutdown, osVersionLabel, selfUpdateBehind, nudgeWaiting, AGENT_NAME,
} from '../lib/domain.js';
import * as act from '../lib/actions.js';
import { canUpdate, machineUpdates, installerState } from '../lib/updater.js';
import { Icon, OsStatus, ProductLogo, Badge, Empty, ViewToggle } from '../components/common.js';
import { FleetHeader } from '../components/page.js';
import { waitingRollout, whenLabel } from '../components/rollouts.js';
import { Donut } from '../components/viz.js';
import { openUpdate } from '../components/update-sheet.js';
import { askAbout } from '../components/ask.js';
import { Jobs } from './history.js';

const quick = pref('machines.quick', 'all');
const view = pref('machines.view', 'list');
const osFilter = pref('machines.os', 'all');
const sortBy = pref('machines.sort', 'name');
const search = signal('');
const selected = signal(new Set());

const DAY = 24 * 3600 * 1000;

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
      const behind = machineUpdates(s, tracked, n);
      const failed = s.jobs.filter((j) => j.hostname === n.hostname && j.status === 'failed' && j.updated_at > Date.now() - DAY);
      // Newest of: a success still on the jobs list, or what the timeline recorded (30 days).
      const lastOk = s.jobs.filter((j) => j.hostname === n.hostname && j.status === 'success')
        .reduce((t, j) => Math.max(t, j.updated_at), n.last_install || 0);
      return { node: n, activity, dl, behind, failed, lastOk };
    });
    return { s, products, tracked, names, nodes };
  }, [s]);
}

const blockedReason = (n) => (!n.online ? 'offline' : n.elevated === 0 ? 'not set up for silent installs' : null);

const QUICK = [
  ['all', 'All'],
  ['behind', 'Needs updates'],
  ['updating', 'Updating'],
  ['failed', 'Failed'],
  ['blocked', "Can't update"],
];
const matchesQuick = (m, q) => {
  switch (q) {
    case 'behind': return m.behind.length > 0;
    case 'updating': return ['installing', 'downloading', 'queued'].includes(m.activity.key);
    case 'failed': return m.failed.length > 0;
    case 'blocked': return !!blockedReason(m.node);
    default: return true;
  }
};
// Rows are grouped by what you'd act on: problems first, healthy machines folded away.
const GROUPS = [
  { key: 'attention', label: 'Needs attention', hint: 'failed installs or machines that can\'t update', open: true, match: (m) => m.failed.length || blockedReason(m.node) },
  { key: 'updating', label: 'Updating now', hint: '', open: true, match: (m) => ['installing', 'downloading', 'queued'].includes(m.activity.key) },
  { key: 'behind', label: 'Needs updates', hint: '', open: true, match: (m) => m.behind.length > 0 },
  { key: 'current', label: 'Up to date', hint: '', open: false, match: () => true },
];
const groupOf = (m) => GROUPS.find((g) => g.match(m)).key;
const openGroups = pref('machines.groups', {});

const SORTS = {
  name: (a, b) => a.node.hostname.localeCompare(b.node.hostname, undefined, { numeric: true }),
  behind: (a, b) => b.behind.length - a.behind.length || SORTS.name(a, b),
  updated: (a, b) => b.lastOk - a.lastOk || SORTS.name(a, b),
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

// Update everything these machines are behind on — one review sheet, grouped by app.
function updateMachines(model, nodes) {
  const items = model.tracked.filter(canUpdate).map((p) => ({ product: p, nodes: nodes.filter((n) => model.nodes.find((m) => m.node.id === n.id)?.behind.some((x) => x.key === p.key)) }))
    .filter((i) => i.nodes.length);
  const title = nodes.length === 1 ? `Update ${nodes[0].hostname}` : `Update ${plural(nodes.length, 'machine')}`;
  return openUpdate(items, { title, subtitle: `${plural(items.reduce((c, i) => c + i.nodes.length, 0), 'update')} · everything these machines are behind on` });
}

// ---------------------------------------------------------------- status
function StatusCell({ m }) {
  const { node: n, activity: a, dl } = m;
  const tags = [];
  if (!n.online && n.reach && n.reach.ok) {
    tags.push(html`<span class="tag warn" title=${`${n.hostname} answers on the network at ${n.reach.addr} (${n.reach.how}), but its agent hasn't checked in since ${ago(n.last_seen)}. Run the one-click installer on it, or restart it.`}>On, agent silent</span>`);
  } else if (!n.online) tags.push(html`<span class="tag bad">Offline</span>`);
  else if (['installing', 'downloading'].includes(a.key)) tags.push(html`<span class="tag accent"><${Icon} name="spinner" cls="spin" />${a.label} ${a.detail}</span>`);
  else if (a.key === 'queued') tags.push(html`<span class="tag info"><${Icon} name="clock" />${a.label} · ${a.detail}</span>`);
  else if (a.key === 'rendering') tags.push(html`<span class="tag violet" title="Installs wait until it's idle">Rendering</span>`);
  else tags.push(html`<span class="tag muted">Idle</span>`);
  if (n.online && n.pending_reboot) tags.push(html`<span class="tag warn" title="Windows is waiting for a restart — some installs (NVIDIA) won't run until then">Restart pending</span>`);
  if (dl && dl.state === 'down') tags.push(html`<span class="tag bad" title=${dl.detail}>Deadline down</span>`);
  if (n.elevated === 0) tags.push(html`<span class="tag warn" title="Run the elevate command once so installs don't stop at a permission prompt">Not set up</span>`);
  if (n.wake && n.wake.state === 'waking') tags.push(html`<span class="tag accent"><${Icon} name="spinner" cls="spin" />Waking</span>`);
  return html`<span class="tags">${tags}</span>`;
}

function BehindCell({ m, model }) {
  if (m.failed.length) {
    const names = [...new Set(m.failed.map((j) => model.names.get(j.product_key) || j.product_key))];
    return html`<span class="row" style="gap:6px;flex-wrap:nowrap"><span class="tag bad" title=${names.join(', ')}><${Icon} name="alert" />${plural(m.failed.length, 'failed')}</span>${m.behind.length ? html`<span class="dim">+${m.behind.length} to update</span>` : null}</span>`;
  }
  if (!m.behind.length) {
    const any = model.tracked.some((p) => (m.node.software || []).some((x) => x.product_key === p.key));
    return any ? html`<span class="uptodate"><${Icon} name="check" />Up to date</span>` : html`<span class="dim">—</span>`;
  }
  return html`<span class="behind-logos" title=${m.behind.map((p) => `${p.name}: ${productStatus(m.node, p).version} → ${productStatus(m.node, p).target}`).join('\n')}>
    ${m.behind.slice(0, 6).map((p) => html`<${ProductLogo} key=${p.key} product=${p} size=${20} />`)}
    <span class="behind-n">${plural(m.behind.length, 'update')}</span>
  </span>`;
}

// The one state a row is coloured by.
function rowState(m) {
  const { node: n, activity: a } = m;
  if (!n.online) return 'offline';
  if (['installing', 'downloading'].includes(a.key)) return 'updating';
  if (a.key === 'queued') return 'queued';
  if (m.failed.length) return 'failed';
  if (m.behind.length) return 'behind';
  if (a.key === 'rendering') return 'rendering';
  return 'current';
}

// ---------------------------------------------------------------- table
const toggleSel = (id) => { const next = new Set(selected.value); if (next.has(id)) next.delete(id); else next.add(id); selected.value = next; };

function MachineTable({ rows, model, head = true }) {
  return html`<div class="table-wrap"><table class="table mtable">
    ${head ? html`<thead><tr>
      <th style="width:36px"></th><th>Machine</th><th>Status</th><th>Updates</th><th>Last update</th><th></th>
    </tr></thead>` : null}
    <tbody>${rows.map((m) => {
      const { node: n, dl } = m;
      const sel = selected.value.has(n.id);
      return html`<tr key=${n.id} class=${`s-${rowState(m)}${sel ? ' selected' : ''}`} onClick=${() => go('machines', n.hostname)}>
        <td onClick=${(e) => e.stopPropagation()}><input type="checkbox" aria-label=${`Select ${n.hostname}`} checked=${sel} onClick=${() => toggleSel(n.id)} /></td>
        <td class="nowrap"><span class="row" style="gap:10px;flex-wrap:nowrap"><${OsStatus} node=${n} /><b>${n.hostname}</b></span></td>
        <td><${StatusCell} m=${m} /></td>
        <td><${BehindCell} m=${m} model=${model} /></td>
        <td class="nowrap dim">${m.lastOk ? ago(m.lastOk, model.s.now) : '—'}${agentOutdated(model.s, n) ? html` <span class="tag muted" title=${`Agent ${n.agent_version} — updates itself to ${model.s.latestAgentVersion}`}>old agent</span>` : ''}</td>
        <td class="right nowrap" onClick=${(e) => e.stopPropagation()}>
          ${m.behind.length && !blockedReason(n) ? html`<button class="btn sm" onClick=${() => updateMachines(model, [n])}><${Icon} name="download" />Update</button>` : null}
          <button class="btn ghost sm icon" aria-label="Machine actions" onClick=${(e) => openMenu(e.currentTarget, machineMenuItems(n, dl))}><${Icon} name="more" /></button>
        </td>
      </tr>`;
    })}</tbody>
  </table></div>`;
}

// Grid view: one card per machine, same information as a row.
function MachineCard({ m, model }) {
  const { node: n, dl } = m;
  const sel = selected.value.has(n.id);
  const st = rowState(m);
  return html`<article class=${`card mcard3 s-${st}${sel ? ' selected' : ''}`} onClick=${() => go('machines', n.hostname)}>
    <header>
      <label class="mc3-check" onClick=${(e) => e.stopPropagation()}><input type="checkbox" aria-label=${`Select ${n.hostname}`} checked=${sel} onChange=${() => toggleSel(n.id)} /></label>
      <${OsStatus} node=${n} />
      <b class="mc3-name">${n.hostname}</b>
      <button class="btn ghost sm icon" aria-label="Machine actions" onClick=${(e) => { e.stopPropagation(); openMenu(e.currentTarget, machineMenuItems(n, dl)); }}><${Icon} name="more" /></button>
    </header>
    <${StatusCell} m=${m} />
    <div class="mc3-updates"><${BehindCell} m=${m} model=${model} /></div>
    <footer>
      <span class="dim">${m.lastOk ? `updated ${ago(m.lastOk, model.s.now)}` : 'no installs on record'}</span>
      <span class="grow"></span>
      ${m.behind.length && !blockedReason(n) ? html`<button class="btn sm" onClick=${(e) => { e.stopPropagation(); updateMachines(model, [n]); }}><${Icon} name="download" />Update ${m.behind.length}</button>` : null}
    </footer>
  </article>`;
}

function MachineList({ rows, model, head = true }) {
  if (view.value === 'grid') return html`<div class="mgrid3">${rows.map((m) => html`<${MachineCard} key=${m.node.id} m=${m} model=${model} />`)}</div>`;
  return html`<${MachineTable} rows=${rows} model=${model} head=${head} />`;
}

function GroupedMachines({ rows, model }) {
  const groups = GROUPS.map((g) => ({ ...g, rows: rows.filter((m) => groupOf(m) === g.key) })).filter((g) => g.rows.length);
  if (groups.length === 1) return view.value === 'grid'
    ? html`<${MachineList} rows=${groups[0].rows} model=${model} />`
    : html`<div class="card"><${MachineTable} rows=${groups[0].rows} model=${model} /></div>`;
  return html`<div class="stack" style="gap:12px">${groups.map((g) => {
    const shown = openGroups.value[g.key] ?? g.open;
    const ids = g.rows.map((m) => m.node.id);
    const allSel = ids.every((id) => selected.value.has(id));
    return html`<section key=${g.key} class=${'card mgroup g-' + g.key}>
      <header>
        <button class="mg-head" onClick=${() => { openGroups.value = { ...openGroups.value, [g.key]: !shown }; }} aria-expanded=${shown}>
          <${Icon} name="chevronDown" cls=${shown ? '' : 'flip-back'} />
          <b>${g.label}</b><span class="mg-count">${g.rows.length}</span>
          ${g.hint ? html`<span class="dim">${g.hint}</span>` : null}
        </button>
        <span class="grow"></span>
        <button class="btn ghost sm" onClick=${() => { const next = new Set(selected.value); ids.forEach((id) => (allSel ? next.delete(id) : next.add(id))); selected.value = next; }}>${allSel ? 'Deselect' : 'Select all'}</button>
      </header>
      ${shown ? html`<${MachineList} rows=${g.rows} model=${model} head=${false} />` : null}
    </section>`;
  })}</div>`;
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
  const ms = model.nodes.filter((m) => ids.has(m.node.id));
  const nodes = ms.map((m) => m.node);
  const updates = ms.reduce((c, m) => c + m.behind.length, 0);
  const online = nodes.filter((n) => n.online);
  const offline = nodes.filter((n) => !n.online);
  const more = (e) => openMenu(e.currentTarget, [
    { label: `Restart${online.length !== nodes.length ? ` ${online.length}` : ''}`, icon: 'refresh', disabled: !online.length, onSelect: () => act.restart(nodes) },
    { label: `Wake${offline.length !== nodes.length ? ` ${offline.length}` : ''}`, icon: 'power', disabled: !offline.length, onSelect: () => act.wake(nodes) },
    { label: 'Shut down', icon: 'moon', danger: true, disabled: !nodes.some(canShutdown), onSelect: () => act.shutdown(nodes) },
    '-',
    { label: 'Hide from dashboard', icon: 'eyeOff', onSelect: async () => { await act.setHidden(nodes.map((n) => n.hostname), true); selected.value = new Set(); } },
  ]);
  return html`<div class="bulkbar" role="toolbar" aria-label="Actions for selected machines">
    <b>${plural(nodes.length, 'machine')}</b>
    <button class="btn sm primary" disabled=${!updates} onClick=${() => updateMachines(model, nodes)}><${Icon} name="download" />${updates ? `Update everything (${updates})` : 'All up to date'}</button>
    <button class="btn sm" onClick=${more}><${Icon} name="more" />More</button>
    <button class="btn ghost sm icon" aria-label="Clear selection" title="Clear selection (Esc)" onClick=${() => { selected.value = new Set(); }}><${Icon} name="close" /></button>
  </div>`;
}

// ---------------------------------------------------------------- details
function AppStatus({ s, node, p }) {
  const job = activeJobFor(s, node, p.key);
  if (job) {
    const wr = waitingRollout(s, job);
    if (job.status === 'downloading') return html`<span class="tag accent"><${Icon} name="download" />Downloading${job.dl_pct != null ? ` ${job.dl_pct}%` : ''}</span>`;
    if (job.status === 'installing') return html`<span class="tag accent"><${Icon} name="spinner" cls="spin" />Installing</span>`;
    return html`<span class="tag info"><${Icon} name="clock" />${wr ? `Scheduled ${whenLabel(wr.run_at)}` : 'Queued'}</span>`;
  }
  const st = productStatus(node, p);
  switch (st.status) {
    case 'uptodate': return html`<span class="uptodate"><${Icon} name="check" />Current</span>`;
    case 'patch': return canUpdate(p) ? html`<button class="btn sm" disabled=${!!blockedReason(node) || !installerState(p, node.os).ok}
      title=${blockedReason(node) ? `Machine is ${blockedReason(node)}` : installerState(p, node.os).ok ? '' : installerState(p, node.os).label}
      onClick=${() => openUpdate([{ product: p, nodes: [node] }], { title: `Update ${p.name} on ${node.hostname}` })}><${Icon} name="download" />Update to ${st.target}</button>` : html`<span class="tag info">${st.target} available</span>`;
    case 'major': return canUpdate(p) ? html`<button class="btn sm ghost" onClick=${() => openUpdate([{ product: p, nodes: [node] }], { title: `Install ${p.name} ${st.target} on ${node.hostname}`, subtitle: 'New major — installs next to the current version' })}><${Icon} name="up" />Install ${String(st.target).split('.')[0]}</button>` : html`<span class="tag violet">new ${String(st.target).split('.')[0]}</span>`;
    case 'selfupdate': return selfUpdateBehind(node, p) && nudgeWaiting(s, node, p)
      ? html`<span class="tag violet" title=${`Adobe's updater was restarted here ${ago(nudgeWaiting(s, node, p), s.now)} — it applies ${st.target} in the background, and the version shows up on a later check-in.`}><${Icon} name="clock" />Asked Adobe</span>`
      : selfUpdateBehind(node, p)
      ? html`<button class="btn sm" disabled=${!!blockedReason(node)} title=${blockedReason(node) ? `Machine is ${blockedReason(node)}` : `Restarts Adobe's updater so it picks up ${st.target}`}
        onClick=${() => openUpdate([{ product: p, nodes: [node] }], { title: `Update ${p.name} on ${node.hostname}` })}><${Icon} name="refresh" />Update to ${st.target}</button>`
      : html`<span class="dim">Updates itself</span>`;
    default: return html`<span class="dim">—</span>`;
  }
}

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
  const { node: n, dl } = m;
  const s = model.s;
  const apps = model.tracked.filter((p) => (n.software || []).some((x) => x.product_key === p.key) || activeJobFor(s, n, p.key));
  const wol = parseJSON(n.wol_info);
  const jobsHere = { ...s, jobs: s.jobs.filter((j) => j.hostname === n.hostname) };
  return html`<div class="drawer-back" onClick=${close}></div>
  <aside class="drawer" role="dialog" aria-label=${n.hostname}>
    <header>
      <${OsStatus} node=${n} />
      <h2>${n.hostname}</h2>
      <${StatusCell} m=${m} />
      <span class="grow"></span>
      ${m.behind.length ? html`<button class="btn sm primary" disabled=${!!blockedReason(n)} onClick=${() => updateMachines(model, [n])}><${Icon} name="download" />Update all (${m.behind.length})</button>` : null}
      <button class="btn sm" onClick=${(e) => openMenu(e.currentTarget, [...machineMenuItems(n, dl).slice(2), '-', { label: 'Ask the farm about it', icon: 'sparkle', onSelect: () => askAbout(`What's going on with ${n.hostname}? Anything wrong, and what should I do?`) }])}><${Icon} name="more" /></button>
      <button class="btn ghost icon" aria-label="Close" onClick=${close}><${Icon} name="close" /></button>
    </header>
    <div class="content">
      ${!n.online && n.reach && n.reach.ok ? html`<div class="banner warn"><${Icon} name="alert" /><span class="grow">
        <b>On the network, but its agent isn't reporting.</b> It answers at <span class="mono">${n.reach.addr}</span> (${n.reach.how}), yet nothing has checked in since ${ago(n.last_seen, s.now)}.
        Run <span class="mono">Install Tracker Agent - Windows.cmd</span> (or the Mac one) on it from the installer share — that reinstalls and starts the agent.</span></div>` : null}
      ${!n.online && !(n.reach && n.reach.ok) ? html`<div class="banner warn"><${Icon} name="power" /><span class="grow">Offline — last seen ${ago(n.last_seen, s.now)}. Updates wait until it's back.${wol && wol.note ? ` ${wol.note}` : ''}</span>
        <button class="btn sm" disabled=${n.wake && n.wake.state === 'waking'} onClick=${() => act.wake([n])}>${n.wake && n.wake.state === 'waking' ? 'Waking…' : 'Wake'}</button></div>` : null}
      ${n.elevated === 0 ? html`<div class="banner warn"><${Icon} name="shieldOff" /><span class="grow">Not set up for silent installs — run the elevate command once on this machine (Settings → Enroll a machine).</span></div>` : null}
      ${dl && dl.state === 'down' ? html`<div class="banner bad"><${Icon} name="alert" /><span class="grow">${dl.detail}</span>${dl.canFix ? html`<button class="btn sm" onClick=${() => act.fixDeadline([n])}>Fix startup</button>` : null}</div>` : null}

      <section>
        <h3 class="section-title">Apps</h3>
        ${apps.length ? html`<div class="card table-wrap"><table class="table">
          <thead><tr><th>App</th><th>Installed</th><th class="right"></th></tr></thead>
          <tbody>${apps.map((p) => html`<tr key=${p.key}>
            <td class="nowrap"><span class="row" style="flex-wrap:nowrap"><${ProductLogo} product=${p} size=${20} />${p.name}</span></td>
            <td class="mono">${productStatus(n, p).version || '—'}</td>
            <td class="right nowrap"><${AppStatus} s=${s} node=${n} p=${p} /></td>
          </tr>`)}</tbody>
        </table></div>` : html`<p class="dim" style="margin:0">No tracked apps detected on this machine yet.</p>`}
      </section>

      <section>
        <h3 class="section-title">Install history</h3>
        ${jobsHere.jobs.length ? html`<${Jobs} s=${jobsHere} products=${model.products} compact />` : html`<p class="dim" style="margin:0">Nothing installed here through the tracker yet.</p>`}
      </section>

      <section>
        <h3 class="section-title">Machine</h3>
        <dl class="kv">
          <dt>Status</dt><dd>${n.online ? 'Online' : 'Offline'} · last seen ${ago(n.last_seen, s.now)}</dd>
          <dt>OS</dt><dd>${osVersionLabel(n)}</dd>
          <dt>IP</dt><dd class="mono">${(n.ip || '—').replace('::ffff:', '')}${n.reach && n.reach.ok && n.reach.addr && n.reach.addr !== (n.ip || '').replace('::ffff:', '') ? html` <span class="dim">(last check-in) — answers now at ${n.reach.addr}</span>` : ''}</dd>
          <dt>GPU</dt><dd>${n.gpu || '—'}${n.gpu_driver ? html` · driver <span class="mono">${n.gpu_driver}</span>` : ''}</dd>
          <dt>Disk</dt><dd style=${n.disk_free_gb != null && n.disk_free_gb < 20 ? 'color:var(--warn)' : ''}>${n.disk_free_gb != null ? `${Math.round(n.disk_free_gb)} GB free of ${Math.round(n.disk_total_gb || 0)} GB` : '—'}</dd>
          <dt>${AGENT_NAME}</dt><dd class="mono">${n.agent_version || '—'}${agentOutdated(s, n) ? html` <span style="color:var(--warn)">(updating itself to ${s.latestAgentVersion})</span>` : ''}</dd>
          ${dl ? html`<dt>Deadline</dt><dd>${dl.state === 'ok' ? 'Running' : dl.label}</dd>` : null}
        </dl>
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
  const { nodes } = model;

  const q = search.value.trim().toLowerCase();
  const counts = Object.fromEntries(QUICK.map(([k]) => [k, nodes.filter((m) => matchesQuick(m, k)).length]));
  const rows = nodes
    .filter((m) => matchesQuick(m, quick.value))
    .filter((m) => osFilter.value === 'all' || m.node.os === osFilter.value)
    .filter((m) => !q || m.node.hostname.toLowerCase().includes(q) || (m.node.ip || '').includes(q))
    .sort(SORTS[sortBy.value] || SORTS.name);
  const drawerHost = route.value.name === 'machines' ? route.value.params[0] : null;
  const online = nodes.filter((m) => m.node.online).length;

  return html`<div class="page">
    <${FleetHeader} lens="machines" subtitle=${`${nodes.length} machines · ${counts.behind} need updates · ${counts.updating} updating${nodes.length - online ? ` · ${nodes.length - online} offline` : ''}`}>
      <label class="search"><${Icon} name="search" /><input id="machine-search" class="field" placeholder="Search machines   /" value=${search.value} onInput=${(e) => { search.value = e.currentTarget.value; }} style="width:240px" /></label>
    </${FleetHeader}>

    <section class="card card-pad fleet">
      <${Donut} size=${118} stroke=${13} segments=${[
        { key: 'current', label: 'Up to date', value: nodes.filter((m) => rowState(m) === 'current' || rowState(m) === 'rendering').length, color: 'var(--ok)', onClick: () => { quick.value = 'all'; }, active: quick.value === 'all' },
        { key: 'updating', label: 'Updating', value: counts.updating, color: 'var(--accent)', onClick: () => { quick.value = 'updating'; }, active: quick.value === 'updating' },
        { key: 'behind', label: 'Needs updates', value: counts.behind, color: 'var(--info)', onClick: () => { quick.value = 'behind'; }, active: quick.value === 'behind' },
        { key: 'failed', label: 'Failed installs', value: counts.failed, color: 'var(--bad)', onClick: () => { quick.value = 'failed'; }, active: quick.value === 'failed' },
        { key: 'blocked', label: "Can't update", value: counts.blocked, color: 'var(--text-3)', onClick: () => { quick.value = 'blocked'; }, active: quick.value === 'blocked' },
      ]} center=${`${online}/${nodes.length}`} sub="online" label=${`${online} of ${nodes.length} machines online`} />
      <div class="fleet-facts">
        <div><span class="l">Updates waiting</span><b>${nodes.reduce((c, m) => c + m.behind.length, 0)}</b></div>
        <div><span class="l">Rendering now</span><b>${nodes.filter((m) => m.activity.key === 'rendering').length}</b></div>
        <div><span class="l">Restart pending</span><b>${nodes.filter((m) => m.node.online && m.node.pending_reboot).length}</b></div>
        <div><span class="l">Out of Deadline</span><b class=${nodes.filter((m) => m.dl && m.dl.state === 'down').length ? 'bad' : ''}>${nodes.filter((m) => m.dl && m.dl.state === 'down').length}</b></div>
      </div>
    </section>

    <div class="filterbar">
      <div class="pills" role="tablist" aria-label="Filter machines">
        ${QUICK.map(([k, label]) => html`<button key=${k} role="tab" aria-selected=${quick.value === k} class=${'pill' + (quick.value === k ? ' on' : '')} onClick=${() => { quick.value = quick.value === k ? 'all' : k; }} disabled=${k !== 'all' && !counts[k]}>
          ${label}<span class="n">${k === 'all' ? nodes.length : counts[k]}</span></button>`)}
      </div>
      <span class="grow"></span>
      <div class="seg" role="group" aria-label="Operating system">
        ${[['all', 'All'], ['windows', 'Windows'], ['macos', 'Mac']].map(([k, l]) => html`<button key=${k} class=${osFilter.value === k ? 'on' : ''} onClick=${() => { osFilter.value = k; }}>${l}</button>`)}
      </div>
      <button class="btn ghost sm" title="Sort" onClick=${(e) => openMenu(e.currentTarget, [
        ['name', 'Name'], ['behind', 'Most updates'], ['updated', 'Recently updated'], ['os', 'OS'],
      ].map(([k, l]) => ({ label: l, icon: sortBy.value === k ? 'check' : 'dot', onSelect: () => { sortBy.value = k; } })))}><${Icon} name="list" />Sort</button>
      <${ViewToggle} value=${view.value} onChange=${(v) => { view.value = v; }} />
      <${HiddenMachines} />
    </div>

    ${!nodes.length ? html`<${Empty}>No machines yet — enroll one from Settings → Enroll a machine.<//>`
      : !rows.length ? html`<${Empty}>No machines match these filters.<//>`
      : quick.value === 'all' ? html`<${GroupedMachines} rows=${rows} model=${model} />`
      : view.value === 'grid' ? html`<${MachineList} rows=${rows} model=${model} />`
      : html`<div class="card"><${MachineTable} rows=${rows} model=${model} /></div>`}

    <${BulkBar} model=${model} />
    ${drawerHost && html`<${MachineDrawer} hostname=${drawerHost} model=${model} />`}
  </div>`;
}

export { selected as selectedMachines };

// Open Machines with a filter applied (the Updates donut links here).
export function showMachines(filter = 'all') {
  quick.value = filter;
  go('machines');
}
