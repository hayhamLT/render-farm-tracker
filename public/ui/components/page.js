// Page header: title, one-line summary, and the page's main actions.
//
// The farm is ONE page looked at three ways — what's behind (Updates), what each machine is
// doing (Machines), what already happened (History). They used to be three tabs, so finding
// that Creative Cloud was behind on six machines and then asking whether those machines were
// healthy meant leaving the page. FleetHeader gives all three the same title and a lens
// switcher; each lens keeps its own address, so every existing link between them now just
// moves the switch instead of jumping somewhere else.
import { html } from '../lib/html.js';
import { route, go } from '../lib/router.js';
import { farm } from '../lib/store.js';
import { updatesWaiting } from '../lib/updater.js';

export function PageHeader({ title, subtitle, children, below }) {
  return html`<header class="page-header">
    <div><h1>${title}</h1>${subtitle && html`<p>${subtitle}</p>`}</div>
    ${children && html`<div class="actions">${children}</div>`}
    ${below && html`<div class="lens-row">${below}</div>`}
  </header>`;
}

export const FLEET_LENSES = ['updates', 'machines', 'history'];

// Counts that mean something: updates waiting, how many machines there are, failures today.
function lensCounts(s) {
  if (!s) return {};
  const day = Date.now() - 24 * 3600 * 1000;
  const offline = s.nodes.filter((n) => !n.online).length;
  const failed = s.jobs.filter((j) => j.status === 'failed' && j.updated_at > day).length;
  const waiting = updatesWaiting(s);
  return {
    updates: waiting ? { n: waiting, title: `${waiting} waiting` } : null,
    machines: { n: s.nodes.length, tone: offline ? 'bad' : '', title: offline ? `${offline} offline` : `${s.nodes.length} machines` },
    history: failed ? { n: failed, tone: 'bad', title: `${failed} failed in the last 24 h` } : null,
  };
}

export function LensBar({ lens }) {
  const counts = lensCounts(farm.value);
  const LABEL = { updates: 'Updates', machines: 'Machines', history: 'History' };
  return html`<nav class="lens" role="tablist" aria-label="How to look at the farm">
    ${FLEET_LENSES.map((k) => {
      const c = counts[k];
      return html`<button key=${k} role="tab" aria-selected=${k === lens} class=${'lens-tab' + (k === lens ? ' on' : '')}
        onClick=${() => (k === lens ? null : go(k))}>${LABEL[k]}
        ${c ? html`<span class=${'n ' + (c.tone || '')} title=${c.title}>${c.n}</span>` : null}</button>`;
    })}
  </nav>`;
}

// The header every farm lens shares: same title, same switcher, its own summary and actions.
export function FleetHeader({ lens, subtitle, children }) {
  const l = lens || route.value.name;
  return html`<${PageHeader} title="Farm" subtitle=${subtitle} below=${html`<${LensBar} lens=${l} />`}>${children}<//>`;
}
