// Timeline: what every machine was doing, when — rendering, installing, offline, out of Deadline,
// waiting for a restart, plus restarts/wakes/agent and driver changes. Swimlanes you can hover
// for details and drag across to zoom. The same lanes, split per kind, sit in the machine drawer.
import { html } from '../lib/html.js';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals-core';
import { farm } from '../lib/store.js';
import { go } from '../lib/router.js';
import { get } from '../lib/api.js';
import { pref } from '../lib/ui.js';
import { normalizeProducts } from '../lib/domain.js';
import { Icon, OsStatus, Kpi } from '../components/common.js';
import { PageHeader } from '../components/page.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const RANGES = [[6, '6h'], [24, '24h'], [72, '3d'], [168, '7d'], [720, '30d']];

// ---------------------------------------------------------------- data
// Cache per (hours,node) so switching pages or ranges is instant, refreshed every minute.
const cache = new Map();
export function useTimeline(hours, nodeId) {
  const key = `${hours}:${nodeId || ''}`;
  const [data, setData] = useState(cache.get(key) || null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let dead = false;
    setData(cache.get(key) || null);
    const load = () => get(`/api/timeline?hours=${hours}${nodeId ? `&node=${nodeId}` : ''}`)
      .then((d) => { cache.set(key, d); if (!dead) { setData(d); setError(null); } })
      .catch((e) => { if (!dead) setError(e.message); });
    load();
    const t = setInterval(load, MIN);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => { dead = true; clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, [key]);
  return { data, error };
}

// ---------------------------------------------------------------- wording
export function dur(ms) {
  if (ms <= 0) return '0m';
  if (ms < MIN) return '<1m';
  const m = Math.round(ms / MIN);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

const fmtTime = (ts, withDay) => {
  const d = new Date(ts);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (!withDay) return t;
  const today = new Date().toDateString();
  const yest = new Date(Date.now() - DAY).toDateString();
  const day = d.toDateString() === today ? 'Today' : d.toDateString() === yest ? 'Yesterday' : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  return `${day} ${t}`;
};

const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

const POWER = {
  restart: ['Restart requested', 'refresh', 'warn'],
  shutdown: ['Shut down', 'power', 'warn'],
  sleep: ['Put to sleep', 'moon', 'warn'],
  wake: ['Wake-on-LAN sent', 'power', 'info'],
  woke: ['Woke up', 'power', 'ok'],
  nowake: ["Didn't wake", 'power', 'bad'],
};

// One row from the API → { kind, ts, end, cls, label, sub, icon, tone, moment }
export function describe(row, names, now) {
  const [kind, ts, endRaw, state, d] = row;
  const end = endRaw == null ? now : endRaw;
  const ongoing = endRaw == null;
  const base = { kind, ts, end, ongoing, state, moment: ['power', 'agent', 'driver', 'fix'].includes(kind) };
  const took = dur(end - ts) + (ongoing ? ' so far' : '');
  switch (kind) {
    case 'offline': return { ...base, cls: 'offline', label: ongoing ? 'Offline' : 'Was offline', sub: took, icon: 'power', tone: 'muted' };
    case 'render': {
      const avg = d && d.n ? Math.round(d.sum / d.n) : null;
      return { ...base, cls: 'render', label: ongoing ? 'Rendering' : 'Rendered', sub: `${took}${avg != null ? ` · GPU avg ${avg}%, peak ${d.peak}%` : ''}`, icon: 'film', tone: 'violet' };
    }
    case 'install': {
      const app = `${names.get(d && d.product) || (d && d.product) || 'Install'} ${(d && d.version) || ''}`.trim();
      const st = state === 'running' && !ongoing ? 'success' : state;
      const map = { running: ['Installing', 'accent'], success: ['Installed', 'ok'], failed: ['Install failed', 'bad'], cancelled: ['Install stopped', 'muted'] };
      const [verb, tone] = map[st] || map.running;
      return { ...base, cls: `install ${st}`, label: `${verb} ${app}`, sub: d && d.approx ? 'recorded before the timeline started — start time unknown' : took, approx: !!(d && d.approx), icon: st === 'failed' ? 'alert' : 'download', tone };
    }
    case 'deadline': return { ...base, cls: 'deadline', label: ongoing ? 'Out of Deadline' : 'Was out of Deadline', sub: `${took} · Worker not running`, icon: 'film', tone: 'bad' };
    case 'reboot': return { ...base, cls: 'reboot', label: ongoing ? 'Restart pending' : 'Restart was pending', sub: took, icon: 'refresh', tone: 'warn' };
    case 'power': {
      const [label, icon, tone] = POWER[state] || ['Power', 'power', 'info'];
      const sub = state === 'woke' && d ? `${d.secs}s after Wake-on-LAN` : state === 'nowake' && d ? d.reason : state === 'wake' && d && d.relays && d.relays.length ? `also via ${d.relays.join(', ')}` : d && d.via === 'deadline' ? 'via Deadline' : '';
      return { ...base, moment: true, cls: `m-${tone}`, label, sub, icon, tone };
    }
    case 'agent': return { ...base, moment: true, cls: 'm-info', label: 'Agent updated', sub: `${d.from} → ${d.to}`, icon: 'beacon', tone: 'info' };
    case 'driver': return { ...base, moment: true, cls: 'm-violet', label: 'GPU driver changed', sub: `${d.from} → ${d.to}`, icon: 'gpu', tone: 'violet' };
    case 'fix': return { ...base, moment: true, cls: state === 'ok' ? 'm-ok' : 'm-bad', label: `Deadline startup fix ${state === 'ok' ? 'applied' : 'failed'}`, sub: d && d.message, icon: 'zap', tone: state === 'ok' ? 'ok' : 'bad' };
    default: return { ...base, moment: true, cls: 'm-info', label: kind, sub: '', icon: 'dot', tone: 'info' };
  }
}

// Layers you can switch on/off (the legend doubles as the switch).
export const LAYERS = [
  { key: 'render', label: 'Rendering', color: 'var(--violet)' },
  { key: 'install', label: 'Installing', color: 'var(--accent)' },
  { key: 'offline', label: 'Offline', color: 'var(--text-3)' },
  { key: 'deadline', label: 'Out of Deadline', color: 'var(--bad)' },
  { key: 'reboot', label: 'Restart pending', color: 'var(--warn)' },
  { key: 'moments', label: 'Restarts, wakes & changes', color: 'var(--info)' },
];
const layerOf = (it) => (it.moment ? 'moments' : it.kind);

// ---------------------------------------------------------------- axis ticks
const STEPS = [15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY];
function ticks(from, to, target = 8) {
  const step = STEPS.find((s) => (to - from) / s <= target) || 7 * DAY;
  const out = [];
  const offset = new Date().getTimezoneOffset() * MIN;   // align to local midnight/hours
  let t = Math.ceil((from - offset) / step) * step + offset;
  for (; t <= to; t += step) out.push(t);
  return { step, out };
}
const tickLabel = (t, step) => {
  const d = new Date(t);
  if (step >= DAY || (d.getHours() === 0 && d.getMinutes() === 0)) return d.toLocaleDateString([], { weekday: 'short', day: 'numeric' });
  return d.getMinutes() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleTimeString([], { hour: 'numeric' });
};

// ---------------------------------------------------------------- swimlanes
// rows: [{ key, label (node), items: describe()[], onLabel }]
export function Swimlanes({ rows, from, to, layers, compact, onZoom, onRowClick, now }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null);     // { row, t, x, y }
  const [drag, setDrag] = useState(null);       // { x0, x1 }
  const [width, setWidth] = useState(700);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const span = Math.max(1, to - from);
  const pct = (t) => ((Math.min(Math.max(t, from), to) - from) / span) * 100;
  const { step, out } = ticks(from, to, Math.max(2, Math.floor(width / 80)));
  const rowH = compact ? 24 : 30;

  const at = (e) => {
    const r = ref.current.getBoundingClientRect();
    const x = Math.min(Math.max(0, e.clientX - r.left), r.width);
    return { x, w: r.width, h: r.height, t: from + (x / r.width) * span, y: e.clientY - r.top, up: e.clientY > window.innerHeight * 0.55, row: Math.floor((e.clientY - r.top - 24) / rowH) };
  };
  const onDown = (e) => { if (e.button !== 0) return; const p = at(e); setDrag({ x0: p.x, x1: p.x, w: p.w }); };
  const onMove = (e) => {
    const p = at(e);
    if (drag) setDrag({ ...drag, x1: p.x });
    setHover(p.row >= 0 && p.row < rows.length ? p : null);
  };
  const onUp = (e) => {
    if (!drag) return;
    const p = at(e);
    const a = Math.min(drag.x0, p.x); const b = Math.max(drag.x0, p.x);
    setDrag(null);
    if (b - a > 8 && onZoom) {
      const t0 = from + (a / p.w) * span; const t1 = from + (b / p.w) * span;
      if (t1 - t0 >= 5 * MIN) onZoom(t0, t1);
    } else if (onRowClick && p.row >= 0 && p.row < rows.length) onRowClick(rows[p.row]);
  };
  useEffect(() => {
    if (!drag) return undefined;
    const cancel = (e) => { if (e.key === 'Escape') setDrag(null); };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [!!drag]);

  // Hover readout: everything on that row at that moment, plus moments within a few pixels.
  let tip = null;
  if (hover && !drag) {
    const row = rows[hover.row];
    const slack = (8 / Math.max(1, hover.w)) * span;
    const hits = row.items.filter((it) => layers[layerOf(it)] !== false && (it.moment ? Math.abs(it.ts - hover.t) <= slack : it.ts <= hover.t && it.end >= hover.t));
    tip = { row, hits };
  }

  return html`<div class=${'lanes' + (compact ? ' compact' : '')}>
    <div class="lanes-names">
      <div class="lanes-axis-pad"></div>
      ${rows.map((r) => html`<div key=${r.key} class=${'lane-name' + (hover && rows[hover.row] === r ? ' hot' : '')} style=${`height:${rowH}px`}>${r.label}</div>`)}
    </div>
    <div class="lanes-body" ref=${ref} onMouseDown=${onDown} onMouseMove=${onMove} onMouseUp=${onUp}
      onMouseLeave=${() => { setHover(null); setDrag(null); }} style=${onZoom ? 'cursor:crosshair' : ''}>
      <div class="lanes-axis">${out.map((t) => html`<span key=${t} style=${`left:${pct(t)}%`}>${tickLabel(t, step)}</span>`)}</div>
      ${out.map((t) => html`<i key=${'g' + t} class="lanes-grid" style=${`left:${pct(t)}%`}></i>`)}
      ${rows.map((r, i) => html`<div key=${r.key} class=${'lane' + (hover && hover.row === i ? ' hot' : '')} style=${`height:${rowH}px`}>
        ${r.items.filter((it) => layers[layerOf(it)] !== false && it.end >= from && it.ts <= to).map((it, k) => (it.moment
          ? html`<b key=${k} class=${'tl-mark ' + it.cls} style=${`left:${pct(it.ts)}%`}></b>`
          : html`<em key=${k} class=${'tl-span ' + it.cls + (it.ongoing ? ' ongoing' : '')} style=${`left:${pct(it.ts)}%;width:${Math.max(0, pct(it.end) - pct(it.ts))}%`}></em>`))}
      </div>`)}
      ${now >= from && now <= to && html`<i class="lanes-now" style=${`left:${pct(now)}%`} title="Now"></i>`}
      ${hover && !drag && html`<i class="lanes-cursor" style=${`left:${(hover.x / hover.w) * 100}%`}></i>`}
      ${drag && Math.abs(drag.x1 - drag.x0) > 2 && html`<div class="lanes-select" style=${`left:${(Math.min(drag.x0, drag.x1) / drag.w) * 100}%;width:${(Math.abs(drag.x1 - drag.x0) / drag.w) * 100}%`}>
        <span>${dur(((Math.abs(drag.x1 - drag.x0)) / drag.w) * span)}</span></div>`}
      ${tip && html`<div class="lanes-tip" style=${`${hover.up ? `bottom:${hover.h - (24 + hover.row * rowH) + 4}px` : `top:${24 + hover.row * rowH + rowH + 4}px`};${hover.x / hover.w > 0.6 ? `right:${100 - (hover.x / hover.w) * 100}%` : `left:${(hover.x / hover.w) * 100}%`}`}>
        <div class="lanes-tip-head"><b>${tip.row.title || tip.row.key}</b><span>${fmtTime(hover.t, true)}</span></div>
        ${tip.hits.length ? tip.hits.map((it, k) => html`<div key=${k} class="lanes-tip-row"><span class=${'tl-icon sm t-' + it.tone}><${Icon} name=${it.icon} /></span>
          <div><b>${it.label}</b><span>${it.moment || it.approx ? fmtTime(it.approx ? it.end : it.ts, true) : `${fmtTime(it.ts, true)} → ${it.ongoing ? 'now' : fmtTime(it.end, sameDay(it.ts, it.end) ? false : true)}`}${it.sub ? ` · ${it.sub}` : ''}</span></div></div>`)
          : html`<div class="lanes-tip-row dim">${tip.row.quiet || 'Online and idle'}</div>`}
        ${onRowClick && html`<div class="lanes-tip-foot">Click for details${onZoom ? ' · drag to zoom' : ''}</div>`}
      </div>`}
    </div>
  </div>`;
}

export function Legend({ layers, onToggle, counts }) {
  return html`<div class="pills legend">${LAYERS.map((l) => html`<button key=${l.key} class=${'pill' + (layers[l.key] !== false ? ' on-soft' : ' off')}
    onClick=${() => onToggle(l.key)} title=${layers[l.key] !== false ? `Hide ${l.label.toLowerCase()}` : `Show ${l.label.toLowerCase()}`}>
    <i class=${'swatch s-' + l.key} style=${`background:${l.color}`}></i>${l.label}${counts && counts[l.key] != null ? html`<span class="n">${counts[l.key]}</span>` : null}</button>`)}</div>`;
}

// ---------------------------------------------------------------- helpers
const clip = (it, from, to) => Math.max(0, Math.min(it.end, to) - Math.max(it.ts, from));
function summarize(items, from, to) {
  const s = { render: 0, offline: 0, deadline: 0, installs: 0, failed: 0, moments: 0, deadlineDrops: 0 };
  for (const it of items) {
    if (it.end < from || it.ts > to) continue;
    if (it.kind === 'render') s.render += clip(it, from, to);
    else if (it.kind === 'offline') s.offline += clip(it, from, to);
    else if (it.kind === 'deadline') { s.deadline += clip(it, from, to); s.deadlineDrops++; }
    else if (it.kind === 'install') { s.installs++; if (it.state === 'failed') s.failed++; }
    if (it.moment) s.moments++;
  }
  return s;
}

function RangePicker({ value, onChange }) {
  return html`<div class="seg" role="group" aria-label="Time range">${RANGES.map(([h, l]) => html`<button key=${h} class=${value === h ? 'on' : ''} onClick=${() => onChange(h)}>${l}</button>`)}</div>`;
}

// ---------------------------------------------------------------- fleet page
const hoursPref = pref('timeline.hours', 24);
const layersPref = pref('timeline.layers', {});
const sortPref = pref('timeline.sort', 'name');
const q = signal('');

const SORTS = [
  ['name', 'Name'],
  ['render', 'Most rendering'],
  ['trouble', 'Most trouble'],
  ['installs', 'Most installs'],
];

export function TimelineView() {
  const s = farm.value;
  const hours = hoursPref.value;
  const { data, error } = useTimeline(hours);
  const [zoom, setZoom] = useState(null);
  useEffect(() => setZoom(null), [hours]);
  const names = useMemo(() => new Map(normalizeProducts(s).map((p) => [p.key, p.name])), [s && s.products]);
  const layers = layersPref.value;
  const toggle = (k) => { layersPref.value = { ...layers, [k]: layers[k] === false }; };

  const now = Date.now();
  const from = zoom ? zoom[0] : data ? data.from : now - hours * HOUR;
  const to = zoom ? zoom[1] : now;

  const model = useMemo(() => {
    if (!data || !s) return null;
    return s.nodes.map((n) => {
      const items = (data.nodes[n.id] || []).map((r) => describe(r, names, now));
      return { node: n, items, sum: summarize(items, from, to) };
    });
  }, [data, s, from, to]);

  if (!s) return null;
  const needle = q.value.trim().toLowerCase();
  const list = (model || []).filter((m) => !needle || m.node.hostname.toLowerCase().includes(needle));
  const byName = (a, b) => a.node.hostname.localeCompare(b.node.hostname, undefined, { numeric: true });
  const sorters = {
    name: byName,
    render: (a, b) => b.sum.render - a.sum.render || byName(a, b),
    trouble: (a, b) => (b.sum.offline + b.sum.deadline + b.sum.failed * HOUR) - (a.sum.offline + a.sum.deadline + a.sum.failed * HOUR) || byName(a, b),
    installs: (a, b) => b.sum.installs - a.sum.installs || byName(a, b),
  };
  list.sort(sorters[sortPref.value] || byName);

  const tot = (model || []).reduce((acc, m) => {
    for (const k of Object.keys(m.sum)) acc[k] = (acc[k] || 0) + m.sum[k];
    return acc;
  }, {});
  const windowMs = Math.max(1, to - from);
  const machineMs = windowMs * Math.max(1, (model || []).length);
  const counts = {};
  for (const m of model || []) for (const it of m.items) { if (it.end >= from && it.ts <= to) counts[layerOf(it)] = (counts[layerOf(it)] || 0) + 1; }

  const rows = list.map((m) => ({
    key: m.node.hostname,
    title: m.node.hostname,
    label: html`<${OsStatus} node=${m.node} /><span class="lane-host">${m.node.hostname}</span>${m.sum.render > 0 ? html`<span class="lane-stat" title="Rendering in this window">${dur(m.sum.render)}</span>` : null}`,
    items: m.items,
    node: m.node,
    quiet: m.node.online ? 'Online and idle' : 'Offline',
  }));
  const tracked = data && data.since ? data.since : null;

  return html`<div class="page stack">
    <${PageHeader} title="Timeline" subtitle="What every machine was doing, and when. Hover for details, drag across the lanes to zoom in, click a machine to open it.">
      <${RangePicker} value=${hours} onChange=${(h) => { hoursPref.value = h; }} />
    </${PageHeader}>

    <div class="kpis" style="margin-bottom:0">
      <${Kpi} label="Render time" value=${dur(tot.render || 0)} sub=${`${Math.round(((tot.render || 0) / machineMs) * 100)}% of machine time`} />
      <${Kpi} label="Installs" value=${tot.installs || 0} sub=${tot.failed ? `${tot.failed} failed` : 'none failed'} tone=${tot.failed ? 'warn' : ''} />
      <${Kpi} label="Offline time" value=${dur(tot.offline || 0)} sub=${`${Math.round(((tot.offline || 0) / machineMs) * 100)}% of machine time`} />
      <${Kpi} label="Deadline drop-outs" value=${tot.deadlineDrops || 0} sub=${tot.deadline ? `${dur(tot.deadline)} without a Worker` : 'Worker ran everywhere'} tone=${tot.deadlineDrops ? 'bad' : ''} />
    </div>

    <section class="card timeline-lanes">
      <div class="card-head" style="flex-wrap:wrap;gap:10px">
        <${Legend} layers=${layers} onToggle=${toggle} counts=${counts} />
        <span class="grow"></span>
        <label class="search"><${Icon} name="search" /><input class="field" placeholder="Filter machines" value=${q.value} onInput=${(e) => { q.value = e.currentTarget.value; }} style="width:170px" /></label>
        <select class="field" value=${sortPref.value} onChange=${(e) => { sortPref.value = e.currentTarget.value; }} aria-label="Sort">
          ${SORTS.map(([k, l]) => html`<option key=${k} value=${k}>${l}</option>`)}
        </select>
      </div>
      <div class="lanes-toolbar">
        <span class="muted">${fmtTime(from, true)} → ${zoom ? fmtTime(to, !sameDay(from, to)) : 'now'} · ${dur(to - from)}</span>
        ${zoom && html`<button class="btn sm" onClick=${() => setZoom(null)}><${Icon} name="close" />Reset zoom</button>`}
        <span class="grow"></span>
        ${tracked && tracked > from && html`<span class="dim" title="The timeline started recording then; earlier history isn't available.">Recording since ${fmtTime(tracked, true)}</span>`}
      </div>
      ${error && !data ? html`<div class="banner bad" style="margin:12px"><${Icon} name="alert" />Couldn't load the timeline: ${error}</div>`
        : !data ? html`<div class="lanes-loading">${Array.from({ length: 8 }).map((_, i) => html`<span key=${i} class="skeleton" style="height:22px;border-radius:6px"></span>`)}</div>`
        : !rows.length ? html`<div class="empty-inline" style="padding:24px"><${Icon} name="search" /><div><b>No machines match</b></div></div>`
        : html`<${Swimlanes} rows=${rows} from=${from} to=${to} now=${now} layers=${layers}
            onZoom=${(a, b) => setZoom([a, b])} onRowClick=${(r) => go('machines', r.key)} />`}
    </section>
  </div>`;
}

// ---------------------------------------------------------------- machine drawer section
const drawerHours = pref('timeline.drawerHours', 24);
const LANE_ROWS = [
  ['render', 'Rendering'], ['install', 'Installs'], ['offline', 'Offline'], ['deadline', 'Deadline'], ['reboot', 'Restart'], ['moments', 'Events'],
];

export function MachineTimeline({ node }) {
  const s = farm.value;
  const hours = drawerHours.value;
  const { data, error } = useTimeline(hours, node.id);
  const [zoom, setZoom] = useState(null);
  const [all, setAll] = useState(false);
  useEffect(() => setZoom(null), [hours, node.id]);
  const names = useMemo(() => new Map(normalizeProducts(s).map((p) => [p.key, p.name])), [s && s.products]);
  const now = Date.now();
  const items = data ? (data.nodes[node.id] || []).map((r) => describe(r, names, now)) : [];
  const from = zoom ? zoom[0] : data ? data.from : now - hours * HOUR;
  const to = zoom ? zoom[1] : now;
  const rows = LANE_ROWS.map(([k, l]) => ({ key: k, title: l, label: html`<span class="lane-host">${l}</span>`, items: items.filter((it) => layerOf(it) === k), quiet: 'Nothing' }));
  const sum = summarize(items, from, to);
  const story = [...items].filter((it) => it.end >= from && it.ts <= to).sort((a, b) => b.ts - a.ts);
  const shown = all ? story : story.slice(0, 8);
  return html`<section>
    <div class="row" style="justify-content:space-between;margin-bottom:8px">
      <h3 class="section-title" style="margin:0">Timeline</h3>
      <div class="seg" role="group" aria-label="Time range">${RANGES.filter(([h]) => h >= 24).map(([h, l]) => html`<button key=${h} class=${hours === h ? 'on' : ''} onClick=${() => { drawerHours.value = h; }}>${l}</button>`)}</div>
    </div>
    ${error && !data ? html`<div class="banner bad"><${Icon} name="alert" />${error}</div>` : !data ? html`<span class="skeleton" style="height:150px;border-radius:10px"></span>` : html`
      <div class="tl-summary">
        <span><b>${dur(sum.render)}</b> rendering</span>
        <span><b>${sum.installs}</b> install${sum.installs === 1 ? '' : 's'}${sum.failed ? html` <em class="bad">(${sum.failed} failed)</em>` : ''}</span>
        <span><b>${dur(sum.offline)}</b> offline</span>
        <span class=${sum.deadlineDrops ? 'bad' : ''}><b>${sum.deadlineDrops}</b> Deadline drop-out${sum.deadlineDrops === 1 ? '' : 's'}</span>
        ${zoom && html`<button class="btn ghost sm" onClick=${() => setZoom(null)}><${Icon} name="close" />Reset zoom</button>`}
      </div>
      <div class="card" style="padding:4px 10px 8px"><${Swimlanes} compact rows=${rows} from=${from} to=${to} now=${now} layers=${{}} onZoom=${(a, b) => setZoom([a, b])} /></div>
      ${story.length ? html`<ol class="story">${shown.map((it, i) => html`<li key=${i}>
          <span class=${'tl-icon sm t-' + it.tone}><${Icon} name=${it.icon} /></span>
          <div><b>${it.label}</b>${it.sub ? html`<span>${it.sub}</span>` : null}</div>
          <time title=${new Date(it.ts).toLocaleString()}>${fmtTime(it.approx ? it.end : it.ts, true)}</time>
        </li>`)}</ol>
        ${story.length > 8 && html`<button class="btn ghost sm" onClick=${() => setAll(!all)}>${all ? 'Show less' : `Show all ${story.length}`}</button>`}`
        : html`<p class="dim" style="margin:8px 0 0">Nothing recorded in this window${data.since && data.since > from ? ` — recording started ${fmtTime(data.since, true)}` : ''}.</p>`}
    `}
  </section>`;
}
