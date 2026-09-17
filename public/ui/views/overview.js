// Overview: what needs attention across the farm right now, with one-click fixes, plus the
// farm's shape (agent rollout, OS and driver spread) and backups.
import { html } from '../lib/html.js';
import { farm } from '../lib/store.js';
import { go } from '../lib/router.js';
import { ago, cmpVersion, plural } from '../lib/format.js';
import { AGENT_NAME, agentOutdated, deadlineStatus, osVersionShort } from '../lib/domain.js';
import * as act from '../lib/actions.js';
import { useMachineModel, showMachines } from './machines.js';
import { Icon, Kpi, Badge, Empty } from '../components/common.js';

function Distribution({ title, icon, rows, empty }) {
  const total = rows.reduce((s, r) => s + r.count, 0) || 1;
  return html`<section class="card card-pad">
    <h2 class="card-title"><${Icon} name=${icon} />${title}</h2>
    ${rows.length ? html`<div class="dist">${rows.map((r) => html`<div class="dist-row" key=${r.label}>
      <span class="dist-label">${r.label}${r.tag ? html` <${Badge} tone=${r.tagTone || 'ok'}>${r.tag}<//>` : ''}</span>
      <span class="dist-bar"><i class=${r.tone || ''} style=${`width:${Math.round((r.count / total) * 100)}%`}></i></span>
      <span class="dist-n mono">${r.count}</span></div>`)}</div>` : html`<p class="dim" style="margin:0">${empty}</p>`}
  </section>`;
}

export function OverviewView() {
  const model = useMachineModel();
  const s = farm.value;
  if (!model || !s) return html`<div class="page"><${Empty}>Loading…<//></div>`;
  const nodes = model.nodes.map((m) => m.node);

  const offline = nodes.filter((n) => !n.online);
  const dlDown = model.nodes.filter((m) => m.dl && m.dl.state === 'down').map((m) => m.node);
  const dlFragile = model.nodes.filter((m) => m.dl && m.dl.state === 'fragile').map((m) => m.node);
  const fixable = [...dlDown, ...dlFragile].filter((n) => { const d = deadlineStatus(n); return d && d.canFix; });
  const reboot = nodes.filter((n) => n.online && n.pending_reboot);
  const lowDisk = nodes.filter((n) => n.disk_free_gb != null && n.disk_free_gb < 20);
  const failedJobs = s.jobs.filter((j) => j.status === 'failed');
  const staleAgents = nodes.filter((n) => agentOutdated(s, n));
  const notReady = nodes.filter((n) => n.elevated === 0);
  const rendering = model.nodes.filter((m) => m.activity.key === 'rendering');
  const updating = model.nodes.filter((m) => ['installing', 'downloading', 'queued'].includes(m.activity.key));
  const behind = model.nodes.filter((m) => m.behind.length);

  const hosts = (list, max = 6) => list.slice(0, max).map((n) => n.hostname).join(', ') + (list.length > max ? ` +${list.length - max}` : '');
  const items = [
    dlDown.length && { tone: 'bad', icon: 'film', title: `${plural(dlDown.length, 'machine')} out of the Deadline farm`, detail: `Online but the Worker isn't running: ${hosts(dlDown)}`,
      action: fixable.some((n) => dlDown.includes(n)) && { label: 'Fix Deadline startup', run: () => act.fixDeadline(dlDown) } },
    offline.length && { tone: 'bad', icon: 'power', title: `${plural(offline.length, 'machine')} offline`, detail: hosts(offline), action: { label: 'Wake', run: () => act.wake(offline) } },
    failedJobs.length && { tone: 'bad', icon: 'alert', title: `${plural(failedJobs.length, 'failed install')}`, detail: [...new Set(failedJobs.map((j) => `${j.hostname} · ${model.names.get(j.product_key) || j.product_key}`))].slice(0, 4).join(' · '), action: { label: 'Review', run: () => go('updates') } },
    dlFragile.length && { tone: 'warn', icon: 'zap', title: `${plural(dlFragile.length, 'machine')} would drop out of Deadline on restart`, detail: `Nothing starts Deadline automatically: ${hosts(dlFragile)}`,
      action: fixable.some((n) => dlFragile.includes(n)) && { label: 'Fix all', run: () => act.fixDeadline(dlFragile) } },
    reboot.length && { tone: 'warn', icon: 'refresh', title: `${plural(reboot.length, 'machine')} waiting on a Windows restart`, detail: `Installs like the NVIDIA driver won't run until they restart: ${hosts(reboot)}`, action: { label: 'Show', run: () => showMachines('reboot') } },
    lowDisk.length && { tone: 'warn', icon: 'server', title: `Low disk space on ${plural(lowDisk.length, 'machine')}`, detail: lowDisk.map((n) => `${n.hostname} ${Math.round(n.disk_free_gb)} GB`).join(' · ') },
    notReady.length && { tone: 'warn', icon: 'shieldOff', title: `${plural(notReady.length, 'machine')} not elevated`, detail: `Installs would stop at a permission prompt: ${hosts(notReady)}`, action: { label: 'How to fix', run: () => go('help') } },
    staleAgents.length && { tone: 'info', icon: 'beacon', title: `${plural(staleAgents.length, 'machine')} on an older ${AGENT_NAME}`, detail: `Agents update themselves when idle — ${hosts(staleAgents)}` },
  ].filter(Boolean);

  const agentRows = Object.entries(nodes.reduce((c, n) => { const v = n.agent_version || 'unknown'; c[v] = (c[v] || 0) + 1; return c; }, {}))
    .sort((a, b) => (a[0] === 'unknown' ? 1 : b[0] === 'unknown' ? -1 : cmpVersion(b[0], a[0])))
    .map(([v, count]) => ({ label: v === 'unknown' ? 'no agent' : v, count, tag: v === s.latestAgentVersion ? 'latest' : null, tone: v === s.latestAgentVersion ? 'ok' : 'old' }));
  const osRows = Object.entries(nodes.reduce((c, n) => { const k = `${n.os === 'windows' ? 'Windows' : 'macOS'} ${osVersionShort(n)}`.trim(); c[k] = (c[k] || 0) + 1; return c; }, {}))
    .sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count }));
  const nv = nodes.filter((n) => n.gpu_driver && /nvidia|geforce|rtx|gtx/i.test(n.gpu || ''));
  const drvCounts = nv.reduce((c, n) => { c[n.gpu_driver] = (c[n.gpu_driver] || 0) + 1; return c; }, {});
  const topDrv = Object.entries(drvCounts).sort((a, b) => b[1] - a[1])[0];
  const drvRows = Object.entries(drvCounts).sort((a, b) => cmpVersion(b[0], a[0])).map(([label, count]) => ({ label, count, tag: topDrv && label === topDrv[0] ? 'most common' : null, tagTone: 'accent' }));

  const lb = s.lastBackup;
  return html`<div class="page stack">
    <div class="kpis" style="margin:0">
      <${Kpi} label="Online" value=${`${nodes.length - offline.length}/${nodes.length}`} tone=${offline.length ? 'warn' : 'ok'} sub=${offline.length ? `${offline.length} offline` : 'all reachable'} onClick=${() => showMachines(offline.length ? 'offline' : 'all')} />
      <${Kpi} label="In the Deadline farm" value=${`${model.nodes.filter((m) => m.dl && m.dl.state !== 'down').length}/${model.nodes.filter((m) => m.dl).length}`} tone=${dlDown.length ? 'bad' : 'ok'} sub=${dlDown.length ? `${dlDown.length} out` : 'every Worker running'} onClick=${() => showMachines('deadline')} />
      <${Kpi} label="Rendering now" value=${rendering.length} sub="GPU busy" onClick=${() => showMachines('rendering')} />
      <${Kpi} label="Updating" value=${updating.length} sub=${behind.length ? `${behind.length} machines still behind` : 'farm is current'} onClick=${() => go('updates')} />
      <${Kpi} label="Needs attention" value=${items.length} tone=${items.some((i) => i.tone === 'bad') ? 'bad' : items.length ? 'warn' : 'ok'} sub=${items.length ? 'see below' : 'all clear'} />
    </div>

    <section class="card">
      <div class="card-head"><h2>Needs attention</h2><span class="grow"></span><span class="dim" style="font-size:.8rem">updates live</span></div>
      ${items.length ? html`<ul class="attention">${items.map((i) => html`<li key=${i.title} class=${i.tone}>
        <span class="att-icon"><${Icon} name=${i.icon} /></span>
        <span class="att-text"><b>${i.title}</b><span class="muted">${i.detail}</span></span>
        ${i.action && html`<button class="btn sm" onClick=${i.action.run}>${i.action.label}</button>`}
      </li>`)}</ul>` : html`<div class="empty"><${Icon} name="check" /> All clear — every machine is online, in Deadline and up to date.</div>`}
    </section>

    <div class="ov-grid">
      <${Distribution} title=${`${AGENT_NAME} agent`} icon="beacon" rows=${agentRows} empty="No agents reporting." />
      <${Distribution} title="Operating systems" icon="server" rows=${osRows} empty="No machines." />
      <${Distribution} title="NVIDIA drivers" icon="gpu" rows=${drvRows} empty="No NVIDIA machines reporting." />
      <section class="card card-pad">
        <h2 class="card-title"><${Icon} name="server" />Backups</h2>
        ${lb ? html`<p style="margin:0 0 4px">Last backup <b>${ago(lb.at, s.now)}</b></p><p class="dim" style="margin:0 0 12px;font-size:.84rem">${Math.round((lb.size || 0) / 1024)} KB · automatic nightly and at startup · kept outside the repo</p>`
          : html`<p class="dim" style="margin:0 0 12px">No backup yet since the tracker started.</p>`}
        <button class="btn sm" onClick=${act.backupNow}><${Icon} name="download" />Back up now</button>
      </section>
    </div>
  </div>`;
}
