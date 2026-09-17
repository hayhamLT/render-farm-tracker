// Overview — the command center: farm health at a glance, 24 h trends, a live map of every
// machine, what needs attention (with one-click fixes), rollouts in flight, and recent activity.
import { html } from '../lib/html.js';
import { useMemo, useState } from 'preact/hooks';
import { farm } from '../lib/store.js';
import { go } from '../lib/router.js';
import { ago, cmpVersion, plural } from '../lib/format.js';
import { AGENT_NAME, agentOutdated, deadlineStatus, ACTIVE } from '../lib/domain.js';
import * as act from '../lib/actions.js';
import { useMachineModel, showMachines } from './machines.js';
import { Icon, Badge, ProductLogo } from '../components/common.js';
import { PageHeader } from '../components/page.js';
import { Ring, AreaChart, Sparkline, StackBar, Num, useMetrics, STATE_COLOR } from '../components/viz.js';

// The one state each machine is shown in on the map (worst/most important first).
export function mapState(m) {
  const { node: n, activity: a, dl } = m;
  if (!n.online) return { key: 'offline', label: 'Offline' };
  if (dl && dl.state === 'down') return { key: 'deadline', label: 'Out of Deadline' };
  if (['installing', 'downloading'].includes(a.key)) return { key: 'installing', label: a.label, detail: a.detail };
  if (a.key === 'queued') return { key: 'queued', label: 'Queued', detail: a.detail };
  if (a.key === 'rendering') return { key: 'rendering', label: 'Rendering', detail: a.detail };
  if (n.pending_reboot) return { key: 'reboot', label: 'Reboot pending' };
  return { key: 'idle', label: 'Idle' };
}

const LEGEND = [
  ['rendering', 'Rendering', 'rendering'],
  ['installing', 'Updating', 'updating'],
  ['queued', 'Queued', 'updating'],
  ['idle', 'Idle', 'online'],
  ['reboot', 'Reboot pending', 'reboot'],
  ['deadline', 'Out of Deadline', 'deadline'],
  ['offline', 'Offline', 'offline'],
];

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function FarmMap({ model }) {
  const [hover, setHover] = useState(null);
  const tiles = model.nodes
    .map((m) => ({ m, st: mapState(m) }))
    .sort((a, b) => a.m.node.hostname.localeCompare(b.m.node.hostname, undefined, { numeric: true }));
  return html`<div class="farm-map" onMouseLeave=${() => setHover(null)}>
    ${tiles.map(({ m, st }) => {
      const n = m.node;
      const gpu = n.online && n.gpu_util != null ? n.gpu_util : null;
      return html`<button key=${n.id} class=${`tile t-${st.key}`} onClick=${() => go('machines', n.hostname)}
        onMouseEnter=${(e) => setHover({ m, st, rect: e.currentTarget.getBoundingClientRect() })}
        onFocus=${(e) => setHover({ m, st, rect: e.currentTarget.getBoundingClientRect() })}
        aria-label=${`${n.hostname}: ${st.label}${st.detail ? ' · ' + st.detail : ''}`}>
        <span class="tile-name">${n.hostname}</span>
        <span class="tile-state">${st.label}</span>
        ${gpu != null ? html`<span class="tile-gpu"><i style=${`width:${gpu}%`}></i></span>` : html`<span class="tile-gpu no-gpu"></span>`}
      </button>`;
    })}
    ${hover && html`<div class="map-tip" style=${`left:${Math.min(window.innerWidth - 270, hover.rect.left)}px;top:${hover.rect.bottom + 8}px`}>
      <b>${hover.m.node.hostname}</b>
      <span class="row" style="gap:6px"><i class="sw" style=${`background:${STATE_COLOR[hover.st.key]}`}></i>${hover.st.label}${hover.st.detail ? html` · <span class="muted">${hover.st.detail}</span>` : ''}</span>
      <span class="muted">${hover.m.node.gpu || 'GPU unknown'}${hover.m.node.online && hover.m.node.gpu_util != null ? ` · ${hover.m.node.gpu_util}% load` : ''}</span>
      ${hover.m.behind.length ? html`<span style="color:var(--info)">${plural(hover.m.behind.length, 'update')} available</span>` : null}
      <span class="dim">seen ${ago(hover.m.node.last_seen)}</span>
    </div>`}
  </div>`;
}

function Rollouts({ s, names }) {
  const groups = new Map();
  for (const j of s.jobs) {
    const k = `${j.product_key}|${j.package_version}`;
    if (!groups.has(k)) groups.set(k, { key: j.product_key, version: j.package_version, jobs: [] });
    groups.get(k).jobs.push(j);
  }
  const live = [...groups.values()].filter((g) => g.jobs.some((j) => ACTIVE.includes(j.status)))
    .sort((a, b) => b.jobs.filter((j) => ACTIVE.includes(j.status)).length - a.jobs.filter((j) => ACTIVE.includes(j.status)).length);
  if (!live.length) {
    return html`<div class="empty-inline"><${Icon} name="check" /><div><b>No rollouts running</b><p class="muted">Queue updates from the Updates page — they start on every idle machine at once.</p></div></div>`;
  }
  return html`<ul class="rollouts">${live.slice(0, 6).map((g) => {
    const c = (st) => g.jobs.filter((j) => (Array.isArray(st) ? st.includes(j.status) : j.status === st)).length;
    const done = c('success'); const running = c(['downloading', 'installing']); const queued = c('pending'); const failed = c(['failed', 'cancelled']);
    const total = g.jobs.length;
    const p = s.products.find((x) => x.key === g.key) || { key: g.key, name: g.key };
    return html`<li key=${g.key + g.version}>
      <${ProductLogo} product=${p} size=${28} />
      <div class="grow" style="min-width:0">
        <div class="row" style="justify-content:space-between;flex-wrap:nowrap"><b>${names.get(g.key) || g.key} <span class="mono dim">${g.version}</span></b><span class="mono muted">${done}/${total}</span></div>
        <${StackBar} parts=${[
          { value: done, color: 'var(--ok)', label: 'done' },
          { value: running, color: 'var(--accent)', label: 'installing' },
          { value: queued, color: 'var(--info)', label: 'queued' },
          { value: failed, color: 'var(--bad)', label: 'failed/stopped' },
        ]} total=${total} height=${7} />
        <div class="legend" style="margin-top:5px;font-size:.74rem">
          ${running ? html`<span><i style="background:var(--accent)"></i>${running} installing</span>` : null}
          ${queued ? html`<span><i style="background:var(--info)"></i>${queued} queued</span>` : null}
          ${failed ? html`<span><i style="background:var(--bad)"></i>${failed} failed</span>` : null}
        </div>
      </div>
    </li>`;
  })}</ul>`;
}

export function OverviewView() {
  const model = useMachineModel();
  const s = farm.value;
  const hist = useMetrics(24);
  const [chart, setChart] = useState('activity');
  const data = useMemo(() => {
    if (!model) return null;
    const states = model.nodes.map((m) => mapState(m).key);
    const count = (k) => states.filter((x) => x === k).length;
    return { count, states };
  }, [model]);
  if (!model || !s) return null;
  const nodes = model.nodes.map((m) => m.node);
  const { count } = data;

  const online = nodes.filter((n) => n.online).length;
  const offline = nodes.filter((n) => !n.online);
  const dlDown = model.nodes.filter((m) => m.dl && m.dl.state === 'down').map((m) => m.node);
  const dlFragile = model.nodes.filter((m) => m.dl && m.dl.state === 'fragile').map((m) => m.node);
  const fixableDown = dlDown.filter((n) => { const d = deadlineStatus(n); return d && d.canFix; });
  const fixableFragile = dlFragile.filter((n) => { const d = deadlineStatus(n); return d && d.canFix; });
  const reboot = nodes.filter((n) => n.online && n.pending_reboot);
  const lowDisk = nodes.filter((n) => n.disk_free_gb != null && n.disk_free_gb < 20);
  const failedJobs = s.jobs.filter((j) => j.status === 'failed');
  const staleAgents = nodes.filter((n) => agentOutdated(s, n));
  const notReady = nodes.filter((n) => n.elevated === 0);
  const behind = model.nodes.filter((m) => m.behind.length);
  const updates = model.nodes.reduce((c, m) => c + m.behind.length, 0);
  const hosts = (list, max = 5) => list.slice(0, max).map((n) => n.hostname).join(', ') + (list.length > max ? ` +${list.length - max}` : '');

  const items = [
    dlDown.length && { tone: 'bad', icon: 'film', title: `${plural(dlDown.length, 'machine')} out of the Deadline farm`, detail: `Online, but the Worker isn't running — ${hosts(dlDown)}`,
      actions: [fixableDown.length && { label: `Fix ${fixableDown.length}`, primary: true, run: () => act.fixDeadline(fixableDown) }, { label: 'Show', run: () => showMachines('deadline') }] },
    offline.length && { tone: 'bad', icon: 'power', title: `${plural(offline.length, 'machine')} offline`, detail: hosts(offline), actions: [{ label: 'Wake', primary: true, run: () => act.wake(offline) }] },
    failedJobs.length && { tone: 'bad', icon: 'alert', title: plural(failedJobs.length, 'failed install'), detail: [...new Set(failedJobs.map((j) => `${j.hostname} · ${model.names.get(j.product_key) || j.product_key}`))].slice(0, 3).join(' · '), actions: [{ label: 'Review', run: () => go('updates') }] },
    dlFragile.length && { tone: 'warn', icon: 'zap', title: `${plural(dlFragile.length, 'machine')} would leave Deadline on restart`, detail: `Nothing starts Deadline automatically — ${hosts(dlFragile)}`,
      actions: [fixableFragile.length && { label: `Fix ${fixableFragile.length}`, primary: true, run: () => act.fixDeadline(fixableFragile) }] },
    reboot.length && { tone: 'warn', icon: 'refresh', title: `${plural(reboot.length, 'machine')} waiting on a Windows restart`, detail: `Driver installs won't run until they restart — ${hosts(reboot)}`, actions: [{ label: 'Show', run: () => showMachines('reboot') }] },
    lowDisk.length && { tone: 'warn', icon: 'server', title: `Low disk on ${plural(lowDisk.length, 'machine')}`, detail: lowDisk.map((n) => `${n.hostname} ${Math.round(n.disk_free_gb)} GB free`).join(' · '), actions: [] },
    notReady.length && { tone: 'warn', icon: 'shieldOff', title: `${plural(notReady.length, 'machine')} not elevated`, detail: `Installs would stop at a permission prompt — ${hosts(notReady)}`, actions: [{ label: 'How to fix', run: () => go('help') }] },
    staleAgents.length && { tone: 'info', icon: 'beacon', title: `${plural(staleAgents.length, 'machine')} on an older ${AGENT_NAME}`, detail: `They update themselves when idle — ${hosts(staleAgents)}`, actions: [] },
  ].filter(Boolean);
  const bad = items.filter((i) => i.tone === 'bad').length;

  const healthy = count('rendering') + count('installing') + count('queued') + count('idle') + count('reboot');
  const segments = LEGEND.map(([k]) => ({ value: count(k), color: STATE_COLOR[k] }));
  const summary = !bad && !items.length ? 'Everything is running smoothly.'
    : bad ? `${plural(bad, 'issue')} need${bad === 1 ? 's' : ''} attention.` : `${plural(items.length, 'thing')} to look at.`;

  const gpuSeries = (hist && hist.farm || []).map((r) => r.gpu_avg);
  const recent = s.events.slice(0, 7);

  return html`<div class="page stack">
    <${PageHeader} title=${`${greeting()}.`} subtitle=${`${healthy} of ${nodes.length} machines are ready to render. ${summary}`}>
      <button class="btn" onClick=${act.checkVersions}><${Icon} name="refresh" />Check versions</button>
      <button class="btn primary" onClick=${() => go('updates')}><${Icon} name="download" />${updates ? `${plural(updates, 'update')} available` : 'Updates'}</button>
    </${PageHeader}>

    <div class="ov-hero">
      <section class="card card-pad health">
        <${Ring} segments=${segments} total=${nodes.length} size=${156} stroke=${14} label="Farm state">
          <div><div class="ring-big"><${Num} value=${online} /><span class="dim">/${nodes.length}</span></div><div class="ring-sub">online</div></div>
        <//>
        <div class="health-legend">
          <h2 class="card-title" style="margin-bottom:10px">Farm right now</h2>
          ${LEGEND.map(([k, label, filter]) => html`<button key=${k} class="hl-row" disabled=${!count(k)} onClick=${() => showMachines(filter === 'updating' ? 'updating' : filter === 'online' ? 'online' : filter)}>
            <i style=${`background:${STATE_COLOR[k]}`}></i><span>${label}</span><b><${Num} value=${count(k)} /></b></button>`)}
        </div>
      </section>

      <section class="card card-pad trend">
        <div class="row" style="justify-content:space-between;margin-bottom:8px">
          <h2 class="card-title" style="margin:0">Last 24 hours</h2>
          <div class="seg">
            <button class=${chart === 'activity' ? 'on' : ''} onClick=${() => setChart('activity')}>Activity</button>
            <button class=${chart === 'gpu' ? 'on' : ''} onClick=${() => setChart('gpu')}>GPU load</button>
            <button class=${chart === 'online' ? 'on' : ''} onClick=${() => setChart('online')}>Online</button>
          </div>
        </div>
        ${chart === 'activity' && html`<${AreaChart} rows=${hist && hist.farm} stacked height=${178}
          series=${[{ key: 'rendering', label: 'Rendering', color: '#a78bfa' }, { key: 'updating', label: 'Updating', color: '#22d3ee' }]} format=${(v) => Math.round(v)} />`}
        ${chart === 'gpu' && html`<${AreaChart} rows=${hist && hist.farm} height=${178} max=${100}
          series=${[{ key: 'gpu_avg', label: 'Average GPU load', color: '#a78bfa' }]} format=${(v) => `${Math.round(v)}%`} />`}
        ${chart === 'online' && html`<${AreaChart} rows=${hist && hist.farm} height=${178}
          series=${[{ key: 'online', label: 'Online', color: '#22c55e' }, { key: 'deadline_down', label: 'Out of Deadline', color: '#ef4444' }]} format=${(v) => Math.round(v)} />`}
      </section>

      <section class="card card-pad stats">
        <button class="stat hover-lift" onClick=${() => go('updates')}><span class="stat-l">Updates available</span><span class="stat-v"><${Num} value=${updates} /></span><span class="stat-s">${behind.length ? `on ${plural(behind.length, 'machine')}` : 'farm is current'}</span></button>
        <button class="stat hover-lift" onClick=${() => showMachines('deadline')}><span class="stat-l">In Deadline</span><span class=${'stat-v' + (dlDown.length ? ' bad' : '')}><${Num} value=${model.nodes.filter((m) => m.dl && m.dl.state !== 'down').length} /><span class="dim">/${model.nodes.filter((m) => m.dl).length}</span></span><span class="stat-s">${dlDown.length ? `${dlDown.length} out · ${dlFragile.length} fragile` : 'all Workers up'}</span></button>
        <div class="stat"><span class="stat-l">Average GPU load</span><span class="stat-v"><${Num} value=${Math.round(nodes.filter((n) => n.online && n.gpu_util != null).reduce((a, n, _, arr) => a + n.gpu_util / arr.length, 0))} />%</span>
          <${Sparkline} values=${gpuSeries} width=${150} height=${30} color="var(--violet)" title="Average GPU load, 24 h" /></div>
      </section>
    </div>

    <section class="card card-pad">
      <div class="row" style="justify-content:space-between;margin-bottom:12px">
        <h2 class="card-title" style="margin:0"><${Icon} name="grid" />Farm map</h2>
        <div class="legend">${LEGEND.map(([k, label]) => html`<span key=${k}><i style=${`background:${STATE_COLOR[k]}`}></i>${label}</span>`)}</div>
      </div>
      <${FarmMap} model=${model} />
    </section>

    <div class="ov-split">
      <section class="card">
        <div class="card-head"><h2>Needs attention</h2>${items.length ? html`<${Badge} tone=${bad ? 'bad' : 'warn'}>${items.length}<//>` : null}</div>
        ${items.length ? html`<ul class="attention">${items.map((i) => html`<li key=${i.title} class=${i.tone}>
          <span class="att-icon"><${Icon} name=${i.icon} /></span>
          <span class="att-text"><b>${i.title}</b><span class="muted">${i.detail}</span></span>
          <span class="row" style="flex-wrap:nowrap">${i.actions.filter(Boolean).map((a) => html`<button class=${'btn sm' + (a.primary ? ' primary' : '')} onClick=${a.run}>${a.label}</button>`)}</span>
        </li>`)}</ul>` : html`<div class="empty-inline"><${Icon} name="check" /><div><b>All clear</b><p class="muted">Every machine is online, in Deadline and ready.</p></div></div>`}
      </section>
      <div class="stack">
        <section class="card">
          <div class="card-head"><h2>Rollouts</h2><span class="grow"></span><button class="btn sm ghost" onClick=${() => go('updates')}>Open Updates<${Icon} name="chevron" /></button></div>
          <div class="card-pad" style="padding-top:12px"><${Rollouts} s=${s} names=${model.names} /></div>
        </section>
        <section class="card">
          <div class="card-head"><h2>Latest activity</h2><span class="grow"></span><button class="btn sm ghost" onClick=${() => go('activity')}>All activity<${Icon} name="chevron" /></button></div>
          <ul class="feed">${recent.map((e) => html`<li key=${e.id} class=${Date.now() - e.ts < 60000 ? 'flash' : ''}><span class=${'feed-dot k-' + e.kind}></span><span class="grow">${e.message}</span><span class="dim nowrap">${ago(e.ts, s.now)}</span></li>`)}</ul>
        </section>
      </div>
    </div>
  </div>`;
}
