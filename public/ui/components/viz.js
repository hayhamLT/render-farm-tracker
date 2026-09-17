// Visual building blocks: rings, sparklines, area charts, stacked bars, animated numbers,
// skeletons — plain SVG, no chart library.
import { html } from '../lib/html.js';
import { useEffect, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals-core';
import { get } from '../lib/api.js';

// ---- metrics history (shared, refreshed every minute while something uses it) ----
export const metrics = signal(null);
let metricsHours = 0;
let metricsTimer = null;
export function useMetrics(hours = 24) {
  useEffect(() => {
    const load = () => get(`/api/metrics?hours=${hours}`).then((m) => { metrics.value = m; }).catch(() => {});
    if (hours !== metricsHours || !metrics.value) { metricsHours = hours; load(); }
    clearInterval(metricsTimer);
    metricsTimer = setInterval(load, 60000);
    return () => {};
  }, [hours]);
  return metrics.value;
}

// ---- animated number ----
export function Num({ value, format = (v) => v }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (typeof value !== 'number' || typeof from.current !== 'number' || value === from.current) { setShown(value); from.current = value; return undefined; }
    const start = performance.now();
    const a = from.current;
    let raf;
    const step = (t) => {
      const k = Math.min(1, (t - start) / 450);
      const eased = 1 - (1 - k) ** 3;
      setShown(Math.round(a + (value - a) * eased));
      if (k < 1) raf = requestAnimationFrame(step); else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return html`<span class="num">${format(shown)}</span>`;
}

// ---- ring (donut) with segments ----
// segments: [{ value, color }]; total defaults to the sum.
export function Ring({ segments, total, size = 120, stroke = 12, children, label }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const sum = total || segments.reduce((s, x) => s + x.value, 0) || 1;
  let offset = 0;
  return html`<div class="ring" style=${`width:${size}px;height:${size}px`} role="img" aria-label=${label}>
    <svg viewBox=${`0 0 ${size} ${size}`} width=${size} height=${size}>
      <circle cx=${size / 2} cy=${size / 2} r=${r} fill="none" stroke="var(--surface-3)" stroke-width=${stroke} />
      ${segments.filter((s) => s.value > 0).map((s, i) => {
        const len = (s.value / sum) * c;
        const el = html`<circle key=${i} class="ring-seg" cx=${size / 2} cy=${size / 2} r=${r} fill="none" stroke=${s.color} stroke-width=${stroke}
          stroke-dasharray=${`${Math.max(0, len - (segments.length > 1 ? 2 : 0))} ${c}`} stroke-dashoffset=${-offset}
          stroke-linecap=${segments.length > 1 ? 'butt' : 'round'} transform=${`rotate(-90 ${size / 2} ${size / 2})`} />`;
        offset += len;
        return el;
      })}
    </svg>
    <div class="ring-center">${children}</div>
  </div>`;
}

// ---- sparkline ----
export function Sparkline({ values, width = 120, height = 28, color = 'var(--accent)', max = 100, fill = true, title }) {
  const pts = (values || []).map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (pts.length < 2) return html`<svg class="spark" width=${width} height=${height} aria-hidden="true"><line x1="0" x2=${width} y1=${height - 1} y2=${height - 1} stroke="var(--surface-3)" stroke-dasharray="3 3" /></svg>`;
  const n = values.length - 1 || 1;
  const x = (i) => (i / n) * width;
  const y = (v) => height - 2 - (Math.min(v, max) / max) * (height - 4);
  const line = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(pts[pts.length - 1][0]).toFixed(1)},${height} L${x(pts[0][0]).toFixed(1)},${height} Z`;
  const id = useRef('g' + Math.random().toString(36).slice(2)).current;
  return html`<svg class="spark" width=${width} height=${height} viewBox=${`0 0 ${width} ${height}`} preserveAspectRatio="none" role=${title ? 'img' : null} aria-label=${title}>
    <defs><linearGradient id=${id} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color=${color} stop-opacity="0.35" /><stop offset="1" stop-color=${color} stop-opacity="0" /></linearGradient></defs>
    ${fill && html`<path d=${area} fill=${`url(#${id})`} />`}
    <path d=${line} fill="none" stroke=${color} stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
  </svg>`;
}

// ---- area chart with hover readout ----
// series: [{ key, label, color }]; rows: [{ ts, [key]: value }]
export function AreaChart({ rows, series, height = 160, max, format = (v) => v, stacked = false }) {
  const ref = useRef(null);
  const [w, setW] = useState(600);
  const [hover, setHover] = useState(null);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.round(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  if (!rows || rows.length < 2) {
    return html`<div ref=${ref} class="chart-empty" style=${`height:${height}px`}>Collecting history — the chart fills in as the tracker samples the farm every minute.</div>`;
  }
  const padT = 8; const padB = 18;
  const h = height - padT - padB;
  const top = max || Math.max(1, ...rows.map((r) => (stacked ? series.reduce((s, x) => s + (r[x.key] || 0), 0) : Math.max(...series.map((x) => r[x.key] || 0)))));
  const t0 = rows[0].ts; const t1 = rows[rows.length - 1].ts;
  const X = (ts) => ((ts - t0) / Math.max(1, t1 - t0)) * w;
  const Y = (v) => padT + h - (v / top) * h;
  const paths = [];
  const base = rows.map(() => 0);
  for (const s of series) {
    const vals = rows.map((r, i) => (stacked ? base[i] + (r[s.key] || 0) : r[s.key] || 0));
    const line = rows.map((r, i) => `${i ? 'L' : 'M'}${X(r.ts).toFixed(1)},${Y(vals[i]).toFixed(1)}`).join(' ');
    const bottom = stacked ? rows.map((r, i) => `L${X(r.ts).toFixed(1)},${Y(base[i]).toFixed(1)}`).reverse().join(' ') : `L${X(t1)},${Y(0)} L${X(t0)},${Y(0)}`;
    paths.push({ s, line, area: `${line} ${bottom} Z` });
    if (stacked) vals.forEach((v, i) => { base[i] = v; });
  }
  const onMove = (e) => {
    const rect = ref.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    let best = 0;
    rows.forEach((r, i) => { if (Math.abs(X(r.ts) - px) < Math.abs(X(rows[best].ts) - px)) best = i; });
    setHover(best);
  };
  const hr = hover != null ? rows[hover] : null;
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return html`<div ref=${ref} class="chart" style=${`height:${height}px`} onMouseMove=${onMove} onMouseLeave=${() => setHover(null)}>
    <svg width=${w} height=${height}>
      ${[0.25, 0.5, 0.75, 1].map((k) => html`<line key=${k} x1="0" x2=${w} y1=${Y(top * k)} y2=${Y(top * k)} stroke="var(--border)" stroke-dasharray="2 4" />`)}
      ${paths.map(({ s, area }) => html`<path key=${s.key + 'a'} d=${area} fill=${s.color} opacity=${stacked ? 0.55 : 0.16} />`)}
      ${paths.map(({ s, line }) => html`<path key=${s.key + 'l'} d=${line} fill="none" stroke=${s.color} stroke-width="1.8" stroke-linejoin="round" />`)}
      ${hr && html`<line x1=${X(hr.ts)} x2=${X(hr.ts)} y1=${padT} y2=${padT + h} stroke="var(--text-3)" />`}
      <text x="0" y=${height - 4} class="axis">${fmtTime(t0)}</text>
      <text x=${w} y=${height - 4} class="axis" text-anchor="end">${fmtTime(t1)}</text>
    </svg>
    ${hr && html`<div class="chart-tip" style=${`left:${Math.min(w - 160, Math.max(0, X(hr.ts) + 10))}px`}>
      <b>${fmtTime(hr.ts)}</b>${series.map((s) => html`<span key=${s.key}><i style=${`background:${s.color}`}></i>${s.label}<b>${format(hr[s.key] ?? 0)}</b></span>`)}
    </div>`}
  </div>`;
}

// ---- stacked progress bar ----
// parts: [{ value, color, label }]
export function StackBar({ parts, total, height = 8, title }) {
  const sum = total || parts.reduce((s, p) => s + p.value, 0) || 1;
  return html`<div class="stackbar" style=${`height:${height}px`} title=${title || parts.filter((p) => p.value).map((p) => `${p.label}: ${p.value}`).join(' · ')}>
    ${parts.filter((p) => p.value > 0).map((p, i) => html`<i key=${i} style=${`width:${(p.value / sum) * 100}%;background:${p.color}`}></i>`)}
  </div>`;
}

export const Skeleton = ({ h = 16, w = '100%', r = 8 }) => html`<span class="skeleton" style=${`height:${h}px;width:${w};border-radius:${r}px`}></span>`;

export function PageSkeleton() {
  return html`<div class="page stack">
    <${Skeleton} h=${28} w="240px" />
    <div class="kpis">${[1, 2, 3, 4].map((i) => html`<div class="card card-pad" key=${i}><${Skeleton} h=${12} w="50%" /><div style="height:10px"></div><${Skeleton} h=${30} w="40%" /></div>`)}</div>
    <div class="card card-pad"><${Skeleton} h=${220} /></div>
  </div>`;
}

// Colors for machine states — one palette everywhere (map tiles, legends, charts).
export const STATE_COLOR = {
  rendering: 'var(--violet)',
  installing: 'var(--accent)',
  downloading: 'var(--accent)',
  queued: 'var(--info)',
  idle: 'var(--ok)',
  reboot: 'var(--warn)',
  offline: 'var(--text-3)',
  deadline: 'var(--bad)',
};

// ---- donut with a clickable legend (filters the view it belongs to) ----
// segments: [{ key, label, value, color, onClick?, active? }]
export function Donut({ segments, size = 132, stroke = 14, center, sub, label }) {
  const shown = segments.filter((s) => s.value > 0);
  const total = shown.reduce((s, x) => s + x.value, 0);
  return html`<div class="donut">
    <div class="donut-main">
      <${Ring} segments=${shown.map((s) => ({ value: s.value, color: s.color }))} total=${total || 1} size=${size} stroke=${stroke} label=${label}>
        <span class="donut-center">${center}</span>
      <//>
      ${sub && html`<span class="donut-sub">${sub}</span>`}
    </div>
    <ul class="donut-legend">${segments.map((s) => html`<li key=${s.key}>
      <button type="button" class=${'dl-row' + (s.active ? ' on' : '') + (s.onClick && s.value ? '' : ' flat')} disabled=${!s.onClick || !s.value} onClick=${s.onClick}
        title=${s.onClick && s.value ? `Show ${s.label.toLowerCase()}` : ''}>
        <i style=${`background:${s.color}`}></i><span class="dl-label">${s.label}</span><b>${s.value}</b>
      </button></li>`)}</ul>
  </div>`;
}
