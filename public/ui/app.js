// App shell: top bar with tabs, live indicator and ⌘K; routes to views; global hosts.
import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import '@preact/signals';                       // makes components re-render when signals they read change
import { html } from './lib/html.js';
import { start, farm, link } from './lib/store.js';
import { route, go } from './lib/router.js';
import { isTyping } from './lib/ui.js';
import { ago } from './lib/format.js';
import { Icon, ToastHost, DialogHost, MenuHost } from './components/common.js';
import { MachinesView } from './views/machines.js';
import { OverviewView } from './views/overview.js';
import { UpdatesView } from './views/updates.js';
import { ActivityView } from './views/activity.js';
import { CatalogView } from './views/catalog.js';
import { SettingsView } from './views/settings.js';
import { HelpView } from './views/help.js';
import { Palette } from './components/palette.js';

const ACTIVE = ['pending', 'downloading', 'installing'];

const ROUTES = [
  { name: 'overview', label: 'Overview', icon: 'gauge', key: 'o', view: () => html`<${OverviewView} />` },
  { name: 'machines', label: 'Machines', icon: 'server', key: 'm', view: () => html`<${MachinesView} />` },
  { name: 'updates', label: 'Updates', icon: 'download', key: 'u', view: () => html`<${UpdatesView} />` },
  { name: 'activity', label: 'Activity', icon: 'activity', key: 'a', view: () => html`<${ActivityView} />` },
  { name: 'catalog', label: 'Catalog', icon: 'package', key: 'c', view: () => html`<${CatalogView} />` },
  { name: 'settings', label: 'Settings', icon: 'sliders', key: 's', view: () => html`<${SettingsView} />` },
  { name: 'help', label: 'Help', icon: 'help', key: 'h', view: () => html`<${HelpView} />` },
];

function LiveIndicator() {
  const l = link.value;
  const s = farm.value;
  const label = { live: 'Live', polling: 'Reconnecting…', offline: 'Offline', connecting: 'Connecting…' }[l.mode];
  const tone = { live: 'ok', polling: 'warn', offline: 'bad', connecting: 'warn' }[l.mode];
  const title = l.mode === 'live' ? 'Updates appear the moment they happen'
    : l.mode === 'polling' ? 'Live stream interrupted — refreshing every 8 s until it reconnects'
    : l.mode === 'offline' ? `Can't reach the tracker${s ? ` — data from ${ago(s.now)}` : ''}` : 'Connecting to the tracker';
  return html`<span class="live" title=${title}><span class=${`dot ${tone} ${l.mode === 'live' ? '' : 'pulse'}`}></span>${label}</span>`;
}

function Topbar() {
  const s = farm.value;
  const r = route.value.name;
  const running = s ? s.jobs.filter((j) => ACTIVE.includes(j.status)).length : 0;
  const failed = s ? s.jobs.filter((j) => j.status === 'failed').length : 0;
  const badge = { updates: running ? { n: running, cls: 'count', style: 'background:var(--accent);color:var(--bg)' } : failed ? { n: failed, cls: 'count' } : null };
  return html`<header class="topbar">
    <nav class="tabs" aria-label="Sections">
      ${ROUTES.map((t) => html`<button key=${t.name} class=${'tab' + (r === t.name ? ' active' : '')} onClick=${() => go(t.name)} title=${`${t.label} (g then ${t.key})`}>
        <${Icon} name=${t.icon} /><span class="label">${t.label}</span>
        ${badge[t.name] && html`<span class=${badge[t.name].cls} style=${badge[t.name].style}>${badge[t.name].n}</span>`}
      </button>`)}
    </nav>
    <span class="spacer"></span>
    <button class="btn sm ghost hide-sm" onClick=${() => window.dispatchEvent(new CustomEvent('palette:open'))} title="Search machines, apps and actions">
      <${Icon} name="search" />Search<span class="kbd">⌘K</span>
    </button>
    <${LiveIndicator} />
  </header>`;
}

function App() {
  // g + letter jumps between sections.
  useEffect(() => {
    let armed = 0;
    const onKey = (e) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'g') { armed = Date.now(); return; }
      if (Date.now() - armed < 1200) {
        const t = ROUTES.find((x) => x.key === e.key);
        if (t) { e.preventDefault(); go(t.name); }
        armed = 0;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const current = ROUTES.find((t) => t.name === route.value.name) || ROUTES[1];
  return html`<div class="app">
    <${Topbar} />
    <main>${current.view()}</main>
    <${ToastHost} /><${DialogHost} /><${MenuHost} /><${Palette} />
  </div>`;
}

start();
render(html`<${App} />`, document.getElementById('root'));
