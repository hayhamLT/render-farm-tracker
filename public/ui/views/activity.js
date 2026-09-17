// Activity: the tracker's event log, live, filterable, grouped by day.
import { html } from '../lib/html.js';
import { signal } from '@preact/signals-core';
import { farm } from '../lib/store.js';
import { Icon, Badge, Empty } from '../components/common.js';

const kind = signal('');
const query = signal('');

const KINDS = [['', 'All'], ['job', 'Installs'], ['deploy', 'Rollouts'], ['node', 'Machines'], ['catalog', 'Versions'], ['package', 'Installers'], ['monitoring', 'System']];

function chip(e) {
  if (e.kind === 'job') {
    if (/success|corrected to success/.test(e.message)) return ['ok', 'success'];
    if (/failed|stalled|reaped/.test(e.message)) return ['bad', 'failed'];
    if (/cancelled|stopped|Stopping/.test(e.message)) return ['', 'stopped'];
    return ['accent', 'install'];
  }
  if (e.kind === 'node') {
    if (/did not wake|failed/.test(e.message)) return ['bad', 'machine'];
    if (/woke up|done/.test(e.message)) return ['ok', 'machine'];
    return ['info', 'machine'];
  }
  if (e.kind === 'catalog') return /auto-detected|newer/i.test(e.message) ? ['violet', 'new version'] : ['', 'catalog'];
  return [{ deploy: 'accent', package: '', monitoring: '' }[e.kind] || '', { deploy: 'rollout', package: 'installer', monitoring: 'system' }[e.kind] || e.kind];
}

const dayLabel = (ts) => {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};

export function ActivityView() {
  const s = farm.value;
  if (!s) return html`<div class="page"><${Empty}>Loading…<//></div>`;
  const q = query.value.toLowerCase();
  const rows = s.events.filter((e) => (!kind.value || e.kind === kind.value) && (!q || e.message.toLowerCase().includes(q)));
  let lastDay = '';
  return html`<div class="page stack">
    <div class="page-head"><h1>Activity</h1><span class="muted">${rows.length === s.events.length ? `${s.events.length} most recent events` : `${rows.length} of ${s.events.length} events`}</span></div>
    <div class="toolbar">
      <div class="row" style="gap:6px">${KINDS.map(([k, l]) => html`<button key=${k} class=${'chip' + (kind.value === k ? ' on' : '')} onClick=${() => { kind.value = k; }}>${l}</button>`)}</div>
      <span class="grow"></span>
      <label class="search"><${Icon} name="search" /><input class="field" placeholder="Search events" value=${query.value} onInput=${(e) => { query.value = e.currentTarget.value; }} style="width:260px" /></label>
    </div>
    <section class="card">
      ${!rows.length ? html`<${Empty}>No matching events.<//>` : html`<ol class="events">${rows.map((e) => {
        const day = dayLabel(e.ts);
        const head = day !== lastDay ? html`<li class="day" key=${'d' + e.id}>${day}</li>` : null;
        lastDay = day;
        const [tone, label] = chip(e);
        return html`${head}<li key=${e.id}>
          <time class="mono dim" title=${new Date(e.ts).toLocaleString()}>${new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
          <${Badge} tone=${tone}>${label}<//>
          <span class="msg">${e.message}</span>
        </li>`;
      })}</ol>`}
    </section>
  </div>`;
}
