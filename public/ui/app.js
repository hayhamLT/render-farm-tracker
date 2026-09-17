// App shell: top bar with tabs, live indicator and ⌘K; routes to views; global hosts.
import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import '@preact/signals';                       // makes components re-render when signals they read change
import { html } from './lib/html.js';
import { start, farm, link } from './lib/store.js';
import { route, go } from './lib/router.js';
import { isTyping, pref } from './lib/ui.js';
import { PageSkeleton } from './components/viz.js';
import { ago } from './lib/format.js';
import { Icon, ToastHost, DialogHost, MenuHost } from './components/common.js';
import { MachinesView } from './views/machines.js';
import { OverviewView } from './views/overview.js';
import { UpdatesView } from './views/updates.js';
import { ActivityView } from './views/activity.js';
import { TimelineView } from './views/timeline.js';
import { CatalogView } from './views/catalog.js';
import { SettingsView } from './views/settings.js';
import { HelpView } from './views/help.js';
import { Palette } from './components/palette.js';
import { AskPanel, askOpen, askShortcut } from './components/ask.js';
import { startAlerts } from './lib/alerts.js';

const ACTIVE = ['pending', 'downloading', 'installing'];

const ROUTES = [
  { name: 'overview', label: 'Overview', icon: 'gauge', key: 'o', view: () => html`<${OverviewView} />` },
  { name: 'machines', label: 'Machines', icon: 'server', key: 'm', view: () => html`<${MachinesView} />` },
  { name: 'timeline', label: 'Timeline', icon: 'clock', key: 't', view: () => html`<${TimelineView} />` },
  { name: 'updates', label: 'Updates', icon: 'download', key: 'u', view: () => html`<${UpdatesView} />` },
  { name: 'activity', label: 'Activity', icon: 'activity', key: 'a', view: () => html`<${ActivityView} />` },
  { name: 'catalog', label: 'Catalog', icon: 'package', key: 'c', view: () => html`<${CatalogView} />` },
  { name: 'settings', label: 'Settings', icon: 'sliders', key: 's', view: () => html`<${SettingsView} />` },
  { name: 'help', label: 'Help', icon: 'help', key: 'h', view: () => html`<${HelpView} />` },
];

function LiveIndicator({ compact }) {
  const l = link.value;
  const s = farm.value;
  const label = { live: 'Live', polling: 'Reconnecting…', offline: 'Offline', connecting: 'Connecting…' }[l.mode];
  const tone = { live: 'ok', polling: 'warn', offline: 'bad', connecting: 'warn' }[l.mode];
  const title = l.mode === 'live' ? 'Live — changes appear the moment they happen'
    : l.mode === 'polling' ? 'Live stream interrupted — refreshing every 8 s until it reconnects'
    : l.mode === 'offline' ? `Can't reach the tracker${s ? ` — data from ${ago(s.now)}` : ''}` : 'Connecting to the tracker';
  return html`<span class="live" title=${title} style="padding:4px 11px"><span class=${`dot ${tone} ${l.mode === 'live' ? '' : 'pulse'}`}></span>${compact ? null : html`<span class="label">${label}</span>`}</span>`;
}

const collapsed = pref('shell.collapsed', false);

function Sidebar() {
  const s = farm.value;
  const r = route.value.name;
  const waiting = new Set(s && s.rollouts ? s.rollouts.filter((x) => x.status === 'scheduled').map((x) => x.id) : []);
  const running = s ? s.jobs.filter((j) => ACTIVE.includes(j.status) && !(j.status === 'pending' && waiting.has(j.rollout_id))).length : 0;
  const failed = s ? s.jobs.filter((j) => j.status === 'failed').length : 0;
  const attention = s ? s.nodes.filter((n) => {
    if (!n.online) return true;
    try { const d = n.deadline_info ? JSON.parse(n.deadline_info) : null; return !!(d && d.installed && !d.worker); } catch { return false; }
  }).length : 0;
  const counts = {
    machines: attention ? { n: attention, cls: 'bad', title: `${attention} offline or out of Deadline` } : null,
    updates: running ? { n: running, cls: 'accent', title: `${running} running or queued` } : failed ? { n: failed, cls: 'bad', title: `${failed} failed` } : null,
  };
  return html`<aside class="sidebar">
    <div class="brand"><span class="brand-mark"><${Icon} name="zap" /></span><div><b>deadline_farm</b><span>tracker</span></div></div>
    <nav class="nav" aria-label="Sections">
      ${ROUTES.map((t) => html`<button key=${t.name} class=${'nav-item' + (r === t.name ? ' active' : '')} onClick=${() => go(t.name)} title=${`${t.label}  ·  g then ${t.key}`} aria-current=${r === t.name ? 'page' : null}>
        <${Icon} name=${t.icon} /><span class="label">${t.label}</span>
        ${counts[t.name] && html`<span class=${'nav-count ' + counts[t.name].cls} title=${counts[t.name].title}>${counts[t.name].n}</span><span class="dotcount"></span>`}
      </button>`)}
    </nav>
    <div class="sidebar-foot">
      <button class=${'search-btn ask-btn' + (askOpen.value ? ' on' : '')} onClick=${() => { askOpen.value = !askOpen.value; }} title="Ask questions about the farm, answered by the local AI">
        <${Icon} name="sparkle" /><span class="label">Ask the farm</span><span class="kbd">${askShortcut()}</span></button>
      <button class="search-btn" onClick=${() => window.dispatchEvent(new CustomEvent('palette:open'))} title="Search machines, apps and actions (⌘K)">
        <${Icon} name="search" /><span class="label">Search</span><span class="kbd">⌘K</span></button>
      <div class="row" style="justify-content:space-between;flex-wrap:nowrap">
        <${LiveIndicator} compact=${collapsed.value} />
        <button class="btn ghost sm icon collapse-btn" aria-label=${collapsed.value ? 'Expand sidebar' : 'Collapse sidebar'} title=${collapsed.value ? 'Expand' : 'Collapse'}
          onClick=${() => { collapsed.value = !collapsed.value; }}><${Icon} name=${collapsed.value ? 'chevron' : 'chevron'} cls=${collapsed.value ? '' : 'flip'} /></button>
      </div>
    </div>
  </aside>`;
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
  // Scroll to the top when changing section (not when opening a machine drawer).
  const name = route.value.name;
  useEffect(() => { window.scrollTo({ top: 0 }); }, [name]);
  const current = ROUTES.find((t) => t.name === name) || ROUTES[0];
  return html`<div class=${'shell' + (collapsed.value ? ' collapsed' : '') + (askOpen.value ? ' ask-open' : '')}>
    <${Sidebar} />
    <main class="content">${farm.value ? current.view() : html`<${PageSkeleton} />`}</main>
    <${AskPanel} />
    <${ToastHost} /><${DialogHost} /><${MenuHost} /><${Palette} />
  </div>`;
}

start();
startAlerts();
render(html`<${App} />`, document.getElementById('root'));
