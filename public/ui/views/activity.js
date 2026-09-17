// Activity log (History → Activity log): a live timeline of everything the tracker did — installs, rollouts, machines,
// versions — filterable, grouped by day, with machine names linked to their details.
import { html } from '../lib/html.js';
import { signal } from '@preact/signals-core';
import { farm } from '../lib/store.js';
import { go } from '../lib/router.js';
import { ago } from '../lib/format.js';
import { Icon } from '../components/common.js';

const kind = signal('');
const query = signal('');

const KINDS = [['', 'Everything'], ['job', 'Installs'], ['deploy', 'Rollouts'], ['node', 'Machines'], ['catalog', 'Versions'], ['package', 'Installers'], ['monitoring', 'System']];

function look(e) {
  const m = e.message;
  if (e.kind === 'job') {
    if (/corrected to success|success/.test(m)) return { icon: 'check', tone: 'ok', label: 'Installed' };
    if (/failed|stalled|reaped/.test(m)) return { icon: 'alert', tone: 'bad', label: 'Failed' };
    if (/cancelled|stopped|Stopping/i.test(m)) return { icon: 'stop', tone: 'muted', label: 'Stopped' };
    return { icon: 'download', tone: 'accent', label: 'Install' };
  }
  if (e.kind === 'node') {
    if (/did not wake|failed/.test(m)) return { icon: 'power', tone: 'bad', label: 'Machine' };
    if (/woke up|: done/.test(m)) return { icon: 'power', tone: 'ok', label: 'Machine' };
    if (/Deadline/.test(m)) return { icon: 'film', tone: 'violet', label: 'Deadline' };
    if (/Reboot|Restart|Shut down/i.test(m)) return { icon: 'refresh', tone: 'warn', label: 'Power' };
    return { icon: 'server', tone: 'info', label: 'Machine' };
  }
  if (e.kind === 'catalog') return /auto-detected|newer/i.test(m) ? { icon: 'zap', tone: 'violet', label: 'New version' } : { icon: 'package', tone: 'muted', label: 'Catalog' };
  if (e.kind === 'deploy') return { icon: 'activity', tone: 'accent', label: 'Rollout' };
  if (e.kind === 'package') return { icon: 'file', tone: 'muted', label: 'Installer' };
  return { icon: 'cog', tone: 'muted', label: 'System' };
}

const dayLabel = (ts) => {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
};

// Link machine names inside a message.
function Message({ text, hosts }) {
  if (!hosts.length) return text;
  const re = new RegExp(`\\b(${hosts.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'g');
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const h = m[0];
    parts.push(html`<button class="linkish host" onClick=${() => go('machines', h)}>${h}</button>`);
    last = m.index + h.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function ActivityLog() {
  const s = farm.value;
  if (!s) return null;
  const q = query.value.toLowerCase();
  const counts = Object.fromEntries(KINDS.map(([k]) => [k, k ? s.events.filter((e) => e.kind === k).length : s.events.length]));
  const rows = s.events.filter((e) => (!kind.value || e.kind === kind.value) && (!q || e.message.toLowerCase().includes(q)));
  const hosts = s.nodes.map((n) => n.hostname).sort((a, b) => b.length - a.length);
  let lastDay = '';
  return html`<div class="stack">
    <div class="row">
      <label class="search"><${Icon} name="search" /><input class="field" placeholder="Search activity" value=${query.value} onInput=${(e) => { query.value = e.currentTarget.value; }} style="width:260px" /></label>
      <span class="dim">The last ${s.events.length} things the tracker did — live.</span>
    </div>
    <div class="pills">${KINDS.map(([k, l]) => html`<button key=${k} class=${'pill' + (kind.value === k ? ' on' : '')} disabled=${!counts[k]} onClick=${() => { kind.value = k; }}>${l}<span class="n">${counts[k]}</span></button>`)}</div>
    <section class="card timeline-card">
      ${!rows.length ? html`<div class="empty-inline"><${Icon} name="search" /><div><b>Nothing matches</b><p class="muted">Try another filter or search.</p></div></div>` : html`<ol class="timeline">${rows.map((e) => {
        const day = dayLabel(e.ts);
        const head = day !== lastDay ? html`<li class="tl-day" key=${'d' + e.id}>${day}</li>` : null;
        lastDay = day;
        const l = look(e);
        return html`${head}<li key=${e.id} class=${'tl-item' + (Date.now() - e.ts < 90000 ? ' flash' : '')}>
          <span class=${'tl-icon t-' + l.tone}><${Icon} name=${l.icon} /></span>
          <div class="tl-body"><span class="tl-label">${l.label}</span><span class="tl-msg"><${Message} text=${e.message} hosts=${hosts} /></span></div>
          <time class="tl-time" title=${new Date(e.ts).toLocaleString()}>${new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}<span>${ago(e.ts, s.now)}</span></time>
        </li>`;
      })}</ol>`}
    </section>
  </div>`;
}
