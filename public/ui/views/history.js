// History — what the tracker installed where, and how it went: every install (retry, stop, logs),
// every rollout with its result, and the full activity log.
import { html } from '../lib/html.js';
import { useEffect, useState } from 'preact/hooks';
import { signal } from '@preact/signals-core';
import { farm } from '../lib/store.js';
import { go } from '../lib/router.js';
import { pref } from '../lib/ui.js';
import { ago, elapsed } from '../lib/format.js';
import { normalizeProducts, ACTIVE } from '../lib/domain.js';
import * as act from '../lib/actions.js';
import { Icon, OsStatus, ProductLogo, Badge, Bar, Empty } from '../components/common.js';
import { PageHeader } from '../components/page.js';
import { RolloutList, waitingRollout, whenLabel } from '../components/rollouts.js';
import { Donut, DayBars } from '../components/viz.js';
import { get } from '../lib/api.js';
import { ActivityLog } from './activity.js';

const tab = pref('history.tab', 'installs');
const jobStatus = pref('jobs.status', 'all');
const jobProduct = signal('');
const jobSearch = signal('');
const openLogs = signal(new Set());

function JobStatus({ j, s }) {
  if (ACTIVE.includes(j.status) && j.cancel_requested_at) return html`<${Badge} tone="warn" icon="spinner" title=${`Stop sent — waiting for ${j.hostname} to confirm`}>stopping…<//>`;
  if (j.status === 'downloading') return html`<span class="row" style="flex-wrap:nowrap;gap:8px"><${Bar} pct=${j.dl_pct} indet=${j.dl_pct == null} /><span class="mono dim">${j.dl_pct != null ? j.dl_pct + '%' : 'downloading'}</span></span>`;
  if (j.status === 'installing' && j.stalled) return html`<${Badge} tone="warn" icon="alert" title="No progress for much longer than usual — Stop, then Retry">stalled<//>`;
  if (j.status === 'installing' && j.inst_overrun) return html`<span class="row" style="flex-wrap:nowrap;gap:8px" title="Taking longer than usual — still running"><${Bar} indet /><span class="dim">finishing…</span></span>`;
  if (j.status === 'installing') return html`<span class="row" style="flex-wrap:nowrap;gap:8px" title="Estimated from typical install time"><${Bar} pct=${j.inst_pct} indet=${j.inst_pct == null} /><span class="mono dim">${j.inst_pct != null ? j.inst_pct + '%' : 'installing'}</span></span>`;
  if (j.status === 'pending') {
    const wr = waitingRollout(s, j);
    if (wr) return html`<${Badge} tone="info" icon="clock" title=${`Part of “${wr.name}” — starts ${whenLabel(wr.run_at)}`}>scheduled · ${whenLabel(wr.run_at)}<//>`;
    const node = s.nodes.find((n) => n.hostname === j.hostname);
    if (node && !node.online) return html`<${Badge} tone="warn" icon="power" title="Runs when the machine is back online">machine offline<//>`;
    if (node && node.elevated === 0) return html`<${Badge} tone="warn" icon="shieldOff">needs elevation<//>`;
    if (/deferr|rendering/i.test(j.log || '')) return html`<${Badge} tone="violet" icon="film" title=${j.log}>waiting — rendering<//>`;
    const busyHere = s.jobs.some((o) => o.id !== j.id && o.hostname === j.hostname && ['downloading', 'installing'].includes(o.status));
    if (busyHere) return html`<${Badge} tone="info" icon="clock" title="One update at a time per machine">after current job<//>`;
    const same = s.jobs.filter((o) => o.product_key === j.product_key && o.package_version === j.package_version);
    if (!same.some((o) => o.status === 'success') && same.filter((o) => ['downloading', 'installing'].includes(o.status)).length >= 3) {
      return html`<${Badge} tone="info" icon="clock" title="A new version runs on 3 machines first; once one succeeds, everyone starts">testing on 3 first<//>`;
    }
    return html`<${Badge} tone="info" icon="clock" title="Starts on the machine's next check-in">queued<//>`;
  }
  if (j.status === 'success') return html`<${Badge} tone="ok" icon="check" title=${/^Verified on check-in:/.test(j.log || '') ? 'The installer returned an error code, but the machine reports the new version' : ''}>success<//>`;
  if (j.status === 'failed') return html`<${Badge} tone="bad" icon="alert">${/REBOOT NEEDED/.test(j.log || '') ? 'failed · reboot needed' : 'failed'}<//>`;
  return html`<${Badge}>stopped<//>`;
}

function JobTime({ j, now }) {
  if (['downloading', 'installing'].includes(j.status)) return html`<span class="mono">${elapsed(now - (j.started_at || j.updated_at))}</span>`;
  if (['success', 'failed', 'cancelled'].includes(j.status)) {
    const d = j.started_at ? j.updated_at - j.started_at : j.install_ms;
    return d > 0 ? html`<span class="mono dim">${elapsed(d)}</span>` : html`<span class="dim">—</span>`;
  }
  return html`<span class="dim">—</span>`;
}

function useTick(ms) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

export function Jobs({ s, products, compact = false }) {
  const now = useTick(1000);
  const names = new Map(products.map((p) => [p.key, p]));
  const bucket = (st) => (ACTIVE.includes(st) ? 'active' : st === 'success' ? 'done' : 'failed');
  const counts = { active: 0, queued: 0, done: 0, failed: 0 };
  for (const j of s.jobs) {
    if (j.status === 'pending') counts.queued++;
    counts[bucket(j.status)]++;
  }
  const q = jobSearch.value.toLowerCase();
  const rows = s.jobs
    .filter((j) => jobStatus.value === 'all' || bucket(j.status) === jobStatus.value)
    .filter((j) => !jobProduct.value || j.product_key === jobProduct.value)
    .filter((j) => !q || j.hostname.toLowerCase().includes(q))
    .sort((a, b) => b.updated_at - a.updated_at);
  const toggleLog = (id) => { const next = new Set(openLogs.value); if (next.has(id)) next.delete(id); else next.add(id); openLogs.value = next; };
  if (compact) {
    return html`<div class="card table-wrap"><table class="table">
      <tbody>${rows.slice(0, 10).map((j) => {
        const p = names.get(j.product_key) || { key: j.product_key, name: j.product_key };
        return html`<tr key=${j.id}>
          <td class="nowrap"><span class="row" style="flex-wrap:nowrap"><${ProductLogo} product=${p} size=${18} />${p.name} <span class="mono dim">${j.package_version}</span></span></td>
          <td><${JobStatus} j=${j} s=${s} /></td>
          <td class="right dim nowrap">${ago(j.updated_at, now)}</td>
          <td class="right nowrap">${['failed', 'cancelled'].includes(j.status) ? html`<button class="btn sm ghost" onClick=${() => act.retryJob(j)}><${Icon} name="refresh" />Retry</button>` : null}
            ${j.log ? html`<button class="btn sm ghost" onClick=${() => toggleLog(j.id)}>Log</button>` : null}</td>
        </tr>${openLogs.value.has(j.id) && html`<tr key=${'log' + j.id}><td colspan="4"><pre class="log">${j.log}</pre></td></tr>`}`;
      })}</tbody></table></div>`;
  }
  return html`<section class="card">
    <div class="card-head">
      <h2>Installs</h2>
      <span class="dim" style="font-size:.84rem">${counts.active - counts.queued} running · ${counts.queued} queued · ${counts.done} done · ${counts.failed} failed/stopped</span>
      <span class="grow"></span>
      ${counts.done + counts.failed > 0 && html`<button class="btn sm ghost" onClick=${() => act.clearFinished(counts.done + counts.failed)}><${Icon} name="trash" />Clear finished</button>`}
      ${counts.active > 0 && html`<button class="btn sm danger" onClick=${() => act.stopAll(counts.active)}><${Icon} name="stop" />Stop all</button>`}
    </div>
    <div class="toolbar" style="padding:10px 16px 0">
      <div class="seg">${[['all', 'All'], ['active', 'Active'], ['done', 'Done'], ['failed', 'Failed']].map(([k, l]) => html`<button key=${k} class=${jobStatus.value === k ? 'on' : ''} onClick=${() => { jobStatus.value = k; }}>${l}${k !== 'all' ? html` <span class="dim">${counts[k]}</span>` : ''}</button>`)}</div>
      <select class="field" value=${jobProduct.value} onChange=${(e) => { jobProduct.value = e.currentTarget.value; }}><option value="">All apps</option>${products.map((p) => html`<option value=${p.key}>${p.name}</option>`)}</select>
      <label class="search"><${Icon} name="search" /><input class="field" placeholder="Filter machines" value=${jobSearch.value} onInput=${(e) => { jobSearch.value = e.currentTarget.value; }} /></label>
    </div>
    ${!rows.length ? html`<${Empty}>${s.jobs.length ? 'No jobs match these filters.' : 'No update jobs yet.'}<//>` : html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Machine</th><th>App</th><th>Status</th><th>Time</th><th class="right">Updated</th><th></th></tr></thead>
      <tbody>${rows.slice(0, 150).map((j) => {
        const p = names.get(j.product_key) || { key: j.product_key, name: j.product_key };
        const node = s.nodes.find((n) => n.hostname === j.hostname);
        const active = ACTIVE.includes(j.status);
        return html`<tr key=${j.id}>
          <td class="nowrap"><span class="row" style="flex-wrap:nowrap;gap:9px">${node ? html`<${OsStatus} node=${node} />` : null}<button class="linkish" style="color:var(--text)" onClick=${() => go('machines', j.hostname)}>${j.hostname}</button></span></td>
          <td class="nowrap"><span class="row" style="flex-wrap:nowrap"><${ProductLogo} product=${p} size=${18} />${p.name} <span class="mono dim">${j.package_version}</span></span></td>
          <td><${JobStatus} j=${j} s=${s} /></td>
          <td><${JobTime} j=${j} now=${now} /></td>
          <td class="right dim nowrap">${ago(j.updated_at, now)}</td>
          <td class="right nowrap">
            ${active && !j.cancel_requested_at ? html`<button class="btn sm ghost" onClick=${() => act.stopJob(j)}><${Icon} name="stop" />Stop</button>` : null}
            ${['failed', 'cancelled'].includes(j.status) ? html`<button class="btn sm ghost" onClick=${() => act.retryJob(j)}><${Icon} name="refresh" />Retry</button>` : null}
            ${j.log ? html`<button class="btn sm ghost" aria-expanded=${openLogs.value.has(j.id)} onClick=${() => toggleLog(j.id)}>Log</button>` : null}
          </td>
        </tr>
        ${openLogs.value.has(j.id) && html`<tr key=${'log' + j.id}><td colspan="6"><pre class="log">${j.log}</pre></td></tr>`}`;
      })}</tbody>
    </table>${rows.length > 150 ? html`<p class="dim" style="padding:0 16px 12px">+${rows.length - 150} older — narrow with the filters.</p>` : ''}</div>`}
  </section>`;
}


// Installs per day for the last two weeks, from the timeline the server records.
function InstallChart() {
  const [rows, setRows] = useState(null);
  const [since, setSince] = useState(null);
  useEffect(() => {
    get('/api/timeline?hours=336')
      .then((d) => { setSince(d.since || null); setRows(Object.values(d.nodes || {}).flat().filter((r) => r[0] === 'install')); })
      .catch(() => setRows([]));
  }, []);
  if (!rows) return html`<span class="skeleton" style="height:150px;border-radius:12px"></span>`;
  const DAY = 24 * 3600 * 1000;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const from = start.getTime() - i * DAY;
    const mine = rows.filter((r) => (r[2] || r[1]) >= from && (r[2] || r[1]) < from + DAY);
    const ok = mine.filter((r) => r[3] === 'success').length;
    const bad = mine.filter((r) => r[3] === 'failed').length;
    const stopped = mine.filter((r) => r[3] === 'cancelled').length;
    const d = new Date(from);
    days.push({
      label: i === 0 ? 'today' : d.toLocaleDateString([], { weekday: 'narrow' }),
      title: `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}: ${ok} installed${bad ? `, ${bad} failed` : ''}${stopped ? `, ${stopped} stopped` : ''}`,
      parts: [{ value: ok, color: 'var(--ok)' }, { value: bad, color: 'var(--bad)' }, { value: stopped, color: 'var(--text-3)' }],
    });
  }
  const tot = days.reduce((a, d) => { a.ok += d.parts[0].value; a.bad += d.parts[1].value; a.stopped += d.parts[2].value; return a; }, { ok: 0, bad: 0, stopped: 0 });
  const done = tot.ok + tot.bad;
  if (!done && !tot.stopped) return null;
  return html`<section class="card card-pad hist-chart">
    <${Donut} size=${112} stroke=${12} center=${`${done ? Math.round((tot.ok / done) * 100) : 100}%`} sub="succeeded" label="install outcomes, last 14 days"
      segments=${[
        { key: 'ok', label: 'Installed', value: tot.ok, color: 'var(--ok)' },
        { key: 'bad', label: 'Failed', value: tot.bad, color: 'var(--bad)' },
        { key: 'stopped', label: 'Stopped', value: tot.stopped, color: 'var(--text-3)' },
      ]} />
    <div class="grow" style="min-width:280px">
      <div class="row" style="justify-content:space-between;margin-bottom:6px"><b>Installs per day</b><span class="dim" style="font-size:.8rem">last 14 days</span></div>
      <${DayBars} days=${days} height=${96} />
      ${since && since > Date.now() - 13 * DAY ? html`<p class="dim" style="margin:6px 0 0;font-size:.76rem">Installs have been recorded since ${new Date(since).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} — earlier days are empty.</p>` : null}
    </div>
  </section>`;
}

export function HistoryView() {
  const s = farm.value;
  if (!s) return null;
  const products = normalizeProducts(s);
  const failed = s.jobs.filter((j) => j.status === 'failed').length;
  const TABS = [['installs', 'Installs', s.jobs.length], ['rollouts', 'Rollouts', (s.rollouts || []).length], ['log', 'Activity log', s.events.length]];
  return html`<div class="page stack">
    <${PageHeader} title="History" subtitle=${`Every install and rollout${failed ? ` · ${failed} failed` : ''}`} />
    ${tab.value === 'installs' ? html`<${InstallChart} />` : null}
    <div class="pills">${TABS.map(([k, l, n]) => html`<button key=${k} class=${'pill' + (tab.value === k ? ' on' : '')} onClick=${() => { tab.value = k; }}>${l}<span class="n">${n}</span></button>`)}</div>
    ${tab.value === 'installs' ? html`<${Jobs} s=${s} products=${products} />`
      : tab.value === 'rollouts' ? html`<section class="card card-pad">${(s.rollouts || []).length ? html`<${RolloutList} s=${s} limitDone=${30} />` : html`<${Empty}>No rollouts yet.<//>`}</section>`
      : html`<${ActivityLog} />`}
  </div>`;
}
