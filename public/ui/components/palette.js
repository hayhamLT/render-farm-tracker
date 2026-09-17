// ⌘K command palette: jump to any section, machine or app, or run an action — typed, not clicked.
import { html } from '../lib/html.js';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals-core';
import { farm } from '../lib/store.js';
import { go } from '../lib/router.js';
import { normalizeProducts, deadlineStatus, canShutdown, ACTIVE } from '../lib/domain.js';
import * as act from '../lib/actions.js';
import { Icon, OsStatus, ProductLogo } from './common.js';

export const paletteOpen = signal(false);

const SECTIONS = [
  ['overview', 'Overview', 'gauge'], ['machines', 'Machines', 'server'], ['updates', 'Updates', 'download'],
  ['activity', 'Activity', 'activity'], ['catalog', 'Catalog', 'package'], ['settings', 'Settings', 'sliders'], ['help', 'Help', 'help'],
];

function buildItems(s) {
  const items = [];
  for (const [name, label, icon] of SECTIONS) items.push({ group: 'Go to', label, icon, keywords: 'go section page', run: () => go(name) });
  if (!s) return items;
  const offline = s.nodes.filter((n) => !n.online);
  const fixable = s.nodes.filter((n) => { const d = deadlineStatus(n); return d && d.canFix && d.state !== 'ok'; });
  const active = s.jobs.filter((j) => ACTIVE.includes(j.status)).length;
  items.push({ group: 'Actions', label: 'Check for new versions', icon: 'refresh', run: act.checkVersions });
  items.push({ group: 'Actions', label: 'Back up the database', icon: 'server', run: act.backupNow });
  if (offline.length) items.push({ group: 'Actions', label: `Wake all offline machines (${offline.length})`, icon: 'power', run: () => act.wake(offline) });
  if (fixable.length) items.push({ group: 'Actions', label: `Fix Deadline startup on ${fixable.length} machines`, icon: 'zap', run: () => act.fixDeadline(fixable) });
  if (active) items.push({ group: 'Actions', label: `Stop all running updates (${active})`, icon: 'stop', danger: true, run: () => act.stopAll(active) });
  for (const n of s.nodes) {
    const tags = `${n.hostname} ${n.gpu || ''} ${n.os} ${(n.ip || '').replace('::ffff:', '')}`;
    items.push({ group: 'Machines', label: n.hostname, node: n, keywords: tags, hint: n.online ? 'online' : 'offline', run: () => go('machines', n.hostname) });
    if (n.online) items.push({ group: 'Machine actions', label: `Restart ${n.hostname}`, icon: 'refresh', keywords: tags, hidden: true, run: () => act.restart([n]) });
    else items.push({ group: 'Machine actions', label: `Wake ${n.hostname}`, icon: 'power', keywords: tags, hidden: true, run: () => act.wake([n]) });
    if (canShutdown(n)) items.push({ group: 'Machine actions', label: `Shut down ${n.hostname}`, icon: 'moon', keywords: tags, hidden: true, run: () => act.shutdown([n]) });
    const d = deadlineStatus(n);
    if (d && d.canFix && d.state !== 'ok') items.push({ group: 'Machine actions', label: `Fix Deadline startup on ${n.hostname}`, icon: 'zap', keywords: tags + ' deadline', hidden: true, run: () => act.fixDeadline([n]) });
  }
  for (const p of normalizeProducts(s)) {
    items.push({ group: 'Apps', label: p.name, product: p, keywords: `${p.key} ${p.latest_version || ''}`, hint: p.latest_version || '', run: () => go('updates') });
  }
  return items;
}

// All query words must appear; earlier and label matches rank higher.
function score(item, words) {
  const label = item.label.toLowerCase();
  const hay = `${label} ${(item.keywords || '').toLowerCase()} ${item.group.toLowerCase()}`;
  let sc = 0;
  for (const w of words) {
    const i = hay.indexOf(w);
    if (i < 0) return -1;
    sc += label.startsWith(w) ? 30 : label.includes(w) ? 15 : 5;
  }
  return sc;
}

export function Palette() {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef(null);
  const open = paletteOpen.value;
  const all = useMemo(() => (open ? buildItems(farm.value) : []), [open, farm.value]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); paletteOpen.value = !paletteOpen.value; }
    };
    const onOpen = () => { paletteOpen.value = true; };
    window.addEventListener('keydown', onKey);
    window.addEventListener('palette:open', onOpen);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('palette:open', onOpen); };
  }, []);
  useEffect(() => { if (open) { setQ(''); setIdx(0); setTimeout(() => inputRef.current && inputRef.current.focus(), 0); } }, [open]);
  if (!open) return null;

  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const results = (words.length
    ? all.map((it) => [it, score(it, words)]).filter(([, sc]) => sc >= 0).sort((a, b) => b[1] - a[1]).map(([it]) => it)
    : all.filter((it) => !it.hidden && ['Go to', 'Actions'].includes(it.group))).slice(0, 40);
  const close = () => { paletteOpen.value = false; };
  const run = (it) => { close(); it.run(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(results.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter' && results[idx]) { e.preventDefault(); run(results[idx]); }
  };
  let lastGroup = '';
  return html`<div class="overlay" style="place-items:start center" onMouseDown=${(e) => { if (e.target === e.currentTarget) close(); }}>
    <div class="palette" role="dialog" aria-label="Command palette">
      <input ref=${inputRef} value=${q} placeholder="Search machines, apps, actions…" aria-label="Search"
        onInput=${(e) => { setQ(e.currentTarget.value); setIdx(0); }} onKeyDown=${onKey} />
      <div class="results" role="listbox">
        ${!results.length && html`<div class="empty" style="padding:20px">Nothing matches “${q}”.</div>`}
        ${results.map((it, i) => {
          const head = it.group !== lastGroup ? html`<div class="group">${it.group}</div>` : null;
          lastGroup = it.group;
          return html`${head}<button key=${it.group + it.label} role="option" aria-selected=${i === idx} class=${'item' + (i === idx ? ' active' : '')}
            onMouseMove=${() => setIdx(i)} onClick=${() => run(it)} style=${it.danger ? 'color:var(--bad-text)' : ''}>
            ${it.node ? html`<${OsStatus} node=${it.node} />` : it.product ? html`<${ProductLogo} product=${it.product} size=${18} />` : html`<${Icon} name=${it.icon || 'chevron'} />`}
            <span>${it.label}</span>${it.hint && html`<span class="hint">${it.hint}</span>`}
          </button>`;
        })}
      </div>
      <footer><span><span class="kbd">↑↓</span> move</span><span><span class="kbd">↵</span> open</span><span><span class="kbd">esc</span> close</span></footer>
    </div>
  </div>`;
}
