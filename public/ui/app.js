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
import { FarmView } from './views/farm.js';
import { CatalogView } from './views/catalog.js';
import { SettingsView } from './views/settings.js';
import { HelpView } from './views/help.js';
import { Palette } from './components/palette.js';
import { AskPanel, askOpen, askShortcut } from './components/ask.js';
import { startAlerts } from './lib/alerts.js';
import { updatesWaiting } from './lib/updater.js';

const ACTIVE = ['pending', 'downloading', 'installing'];

// Updates, machines and history are one page (views/farm.js), not three. They keep their own
// addresses so old links, bookmarks and the g-shortcuts still work — those now scroll to the
// right part of the dashboard instead of loading a different page.
const ROUTES = [
  { name: 'updates', label: 'Updates', icon: 'download', key: 'u', nav: 'Farm', view: () => html`<${FarmView} />` },
  { name: 'machines', label: 'Machines', icon: 'server', key: 'm', lens: true, view: () => html`<${FarmView} />` },
  { name: 'history', label: 'History', icon: 'activity', key: 'h', lens: true, view: () => html`<${FarmView} />` },
  { name: 'catalog', label: 'Apps', icon: 'package', key: 'a', view: () => html`<${CatalogView} />` },
  { name: 'settings', label: 'Settings', icon: 'sliders', key: 's', view: () => html`<${SettingsView} />` },
  { name: 'help', label: 'Help', icon: 'help', key: '?', view: () => html`<${HelpView} />` },
];
const FARM = ROUTES.filter((t) => t.nav === 'Farm' || t.lens).map((t) => t.name);
const NAV = ROUTES.filter((t) => !t.lens);
// Old addresses from before the updates-first layout.
const MOVED = { overview: 'updates', timeline: 'machines', activity: 'history' };

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
  const failed = s ? s.jobs.filter((j) => j.status === 'failed' && j.updated_at > Date.now() - 24 * 3600 * 1000).length : 0;
  const offline = s ? s.nodes.filter((n) => !n.online).length : 0;
  const available = updatesWaiting(s);
  const counts = {
    updates: running ? { n: running, cls: 'accent', title: `${running} updating or queued` } : available ? { n: available, cls: 'info', title: `${available} updates available` } : null,
  };
  // The Farm item carries the update count; a red dot says something in there needs a look,
  // so an offline machine or a failed install is still noticeable from any page.
  const alert = offline || failed
    ? [offline ? `${offline} offline` : '', failed ? `${failed} failed in the last 24 h` : ''].filter(Boolean).join(' · ')
    : null;
  return html`<aside class="sidebar">
    <div class="brand"><span class="brand-mark"><${Icon} name="zap" /></span><div><b>deadline_farm</b><span>tracker</span></div></div>
    <nav class="nav" aria-label="Sections">
      ${NAV.map((t) => {
        const isFarm = t.nav === 'Farm';
        const on = isFarm ? FARM.includes(r) : r === t.name;
        const label = t.nav || t.label;
        return html`<button key=${t.name} class=${'nav-item' + (on ? ' active' : '')} onClick=${() => go(t.name)}
          title=${isFarm ? `Updates, machines and history  ·  g then u / m / h${alert ? `  ·  ${alert}` : ''}` : `${t.label}  ·  g then ${t.key}`}
          aria-current=${on ? 'page' : null}>
          <${Icon} name=${t.icon} /><span class="label">${label}</span>
          ${isFarm && alert ? html`<span class="nav-alert" title=${alert}></span>` : null}
          ${counts[t.name] && html`<span class=${'nav-count ' + counts[t.name].cls} title=${counts[t.name].title}>${counts[t.name].n}</span><span class="dotcount"></span>`}
        </button>`;
      })}
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
  // Scroll to the top when changing section — except within the farm page, where the section
  // itself scrolls into view (views/farm.js).
  const name = route.value.name;
  useEffect(() => { if (!FARM.includes(name)) window.scrollTo({ top: 0 }); }, [name]);
  useEffect(() => { if (MOVED[name]) go(MOVED[name], ...route.value.params); }, [name]);
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
