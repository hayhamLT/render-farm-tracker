// Small shared components.
import { html } from '../lib/html.js';
import { useEffect, useRef } from 'preact/hooks';
import { ICONS } from './icon-paths.js';
import { TILE } from '../lib/presets.js';
import { osVersionShort } from '../lib/domain.js';
import { url } from '../lib/api.js';
import { toasts, dismissToast, dialog, menu, closeMenu } from '../lib/ui.js';

export function Icon({ name, cls = '', title }) {
  return html`<svg class=${'icon ' + cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden=${title ? null : 'true'} role=${title ? 'img' : null}
    dangerouslySetInnerHTML=${{ __html: (title ? `<title>${title}</title>` : '') + (ICONS[name] || '') }} />`;
}

// Machine state as its OS mark: green when online, red when offline, with the OS version.
export function OsStatus({ node }) {
  const v = osVersionShort(node);
  const full = node.os_version || (node.os === 'windows' ? 'Windows' : 'macOS');
  return html`<span class="os-status" title=${`${full} · ${node.online ? 'online' : 'offline'}`}
    style=${`position:relative;display:inline-flex;color:${node.online ? 'var(--ok)' : 'var(--bad)'}`}>
    <${Icon} name=${node.os === 'windows' ? 'windows' : 'apple'} />
    ${v && html`<span style="position:absolute;right:-7px;bottom:-5px;font:700 9px/1 var(--font);color:var(--text-2);background:var(--bg);border-radius:4px;padding:1px 2px">${v}</span>`}
  </span>`;
}

const ICON_FILES = { aftereffects: 'png', creativecloud: 'png', cinema4d: 'png', maxonapp: 'png', redshift: 'svg', redgiant: 'png', blender: 'png', ffmpeg: 'png', notchlc: 'png', nvidia: 'png' };

export function ProductLogo({ product, size = 20 }) {
  const box = `width:${size}px;height:${size}px;border-radius:${Math.round(size / 4)}px;flex:none;object-fit:contain`;
  if (ICON_FILES[product.key]) return html`<img src=${url(`icons/${product.key}.${ICON_FILES[product.key]}`)} alt="" style=${box} loading="lazy" />`;
  const [abbr, bg, fg] = TILE[product.key] || [(product.name || product.key).slice(0, 2).toUpperCase(), '#22303f', '#9fb3c8'];
  const mono = html`<span style=${`${box};display:inline-grid;place-items:center;background:${bg};color:${fg};font:700 ${Math.round(size * 0.42)}px/1 var(--font)`}>${abbr}</span>`;
  if (product.icon_url) {
    return html`<img src=${product.icon_url} alt="" style=${box} loading="lazy"
      onError=${(e) => { e.currentTarget.replaceWith(Object.assign(document.createElement('span'), { textContent: abbr, style: `${box};display:inline-grid;place-items:center;background:${bg};color:${fg};font:700 ${Math.round(size * 0.42)}px/1 var(--font)` })); }} />`;
  }
  return mono;
}

export const Badge = ({ tone = '', icon, children, title, onClick }) => (onClick
  ? html`<button type="button" class=${'badge ' + tone} title=${title} onClick=${onClick}>${icon && html`<${Icon} name=${icon} />`}${children}</button>`
  : html`<span class=${'badge ' + tone} title=${title}>${icon && html`<${Icon} name=${icon} />`}${children}</span>`);

export function Kpi({ label, value, sub, tone = '', onClick, active, title }) {
  const body = html`<span class="l">${label}</span><span class="v">${value}</span>${sub && html`<span class="s">${sub}</span>`}`;
  return onClick
    ? html`<button type="button" class=${`card kpi ${tone} ${active ? 'on' : ''}`} onClick=${onClick} title=${title}>${body}</button>`
    : html`<div class=${`card kpi ${tone}`} title=${title}>${body}</div>`;
}

export const Bar = ({ pct, indet }) => html`<span class=${'bar' + (indet ? ' indet' : '')}><i style=${indet ? '' : `width:${Math.max(2, Math.min(100, pct || 0))}%`}></i></span>`;

export const Empty = ({ children }) => html`<div class="empty">${children}</div>`;

// ---- hosts: one each, mounted by the app shell ----
export function ToastHost() {
  return html`<div class="toasts" role="status" aria-live="polite">
    ${toasts.value.map((t) => html`<div class=${'toast ' + t.type} key=${t.id}>
      <${Icon} name=${t.type === 'error' ? 'alert' : t.type === 'success' ? 'check' : 'activity'} />
      <span>${t.message}</span>
      <button class="x" aria-label="Dismiss" onClick=${() => dismissToast(t.id)}><${Icon} name="close" /></button>
    </div>`)}
  </div>`;
}

export function DialogHost() {
  const d = dialog.value;
  const okRef = useRef(null);
  useEffect(() => {
    if (!d) return undefined;
    if (d.kind === 'confirm' && okRef.current) okRef.current.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); d.resolve(d.kind === 'confirm' ? false : null); }
      if (e.key === 'Enter' && d.kind === 'confirm' && !e.isComposing) { e.preventDefault(); d.resolve(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [d]);
  if (!d) return null;
  const backdrop = (e) => { if (e.target === e.currentTarget) d.resolve(d.kind === 'confirm' ? false : null); };
  if (d.kind === 'confirm') {
    return html`<div class="overlay" onMouseDown=${backdrop}>
      <div class="dialog" role="alertdialog" aria-modal="true" aria-label=${d.title}>
        <header>${d.title}</header>
        <div class="body"><p style="margin:0">${d.message}</p>${d.details && html`<p class="dim" style="margin:10px 0 0;font-size:.84rem">${d.details}</p>`}</div>
        <footer>
          <button class="btn ghost" onClick=${() => d.resolve(false)}>${d.cancelLabel}</button>
          <button ref=${okRef} class=${'btn ' + (d.danger ? 'danger' : 'primary')} onClick=${() => d.resolve(true)}>${d.confirmLabel}</button>
        </footer>
      </div>
    </div>`;
  }
  return html`<div class="overlay" onMouseDown=${backdrop}>
    <div class=${'dialog' + (d.wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label=${d.title}>
      ${d.title && html`<header>${d.title}</header>`}
      ${d.render(d.resolve)}
    </div>
  </div>`;
}

export function MenuHost() {
  const m = menu.value;
  const ref = useRef(null);
  useEffect(() => {
    if (!m) return undefined;
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) closeMenu(); };
    const esc = (e) => { if (e.key === 'Escape') closeMenu(); };
    const t = setTimeout(() => document.addEventListener('mousedown', away), 0);
    window.addEventListener('keydown', esc);
    window.addEventListener('scroll', closeMenu, true);
    // Flip above the anchor if it would run off the bottom.
    if (ref.current) {
      const r = ref.current.getBoundingClientRect();
      if (r.bottom > window.innerHeight - 8) ref.current.style.top = `${Math.max(8, m.bottomAnchor - r.height - 4)}px`;
    }
    return () => { clearTimeout(t); document.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc); window.removeEventListener('scroll', closeMenu, true); };
  }, [m]);
  if (!m) return null;
  return html`<div class="menu" ref=${ref} role="menu" style=${`top:${m.top}px;right:${m.right}px`}>
    ${m.items.filter(Boolean).map((it, i) => (it === '-'
      ? html`<hr key=${i} />`
      : html`<button key=${i} role="menuitem" class=${it.danger ? 'danger' : ''} disabled=${it.disabled} title=${it.title}
          onClick=${() => { closeMenu(); it.onSelect(); }}>
          ${it.icon && html`<${Icon} name=${it.icon} />`}<span>${it.label}</span>
          ${it.hint && html`<span class="dim" style="margin-left:auto;font-size:.78rem">${it.hint}</span>`}
        </button>`))}
  </div>`;
}
