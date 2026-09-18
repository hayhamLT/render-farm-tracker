// A section of the dashboard: a heading you can collapse, with its own controls on the right.
//
// The farm is one page — what's behind, the machines, what happened — so the parts need to be
// skimmable without becoming a wall. Each section remembers whether you left it open.
import { html } from '../lib/html.js';
import { pref } from '../lib/ui.js';
import { Icon } from './common.js';

const opened = {};   // key -> pref signal, made once

export function Section({ id, icon, title, count, tone, summary, actions, open: forceOpen, defaultOpen = true, children }) {
  if (!opened[id]) opened[id] = pref(`section.${id}`, defaultOpen);
  const sig = opened[id];
  const open = forceOpen === undefined ? sig.value : forceOpen;
  return html`<section id=${`sec-${id}`} class=${'sec' + (open ? ' open' : '')}>
    <header class="sec-head">
      <button class="sec-toggle" onClick=${() => { sig.value = !open; }} aria-expanded=${open} aria-controls=${`sec-body-${id}`}>
        <${Icon} name="chevronDown" cls=${'sec-chev' + (open ? '' : ' flip-r')} />
        ${icon ? html`<span class=${'sec-icon ' + (tone || '')}><${Icon} name=${icon} /></span>` : null}
        <h2>${title}</h2>
        ${count != null ? html`<span class=${'sec-count ' + (tone || '')}>${count}</span>` : null}
        ${summary ? html`<span class="dim sec-summary">${summary}</span>` : null}
      </button>
      ${actions ? html`<div class="sec-actions" onClick=${(e) => e.stopPropagation()}>${actions}</div>` : null}
    </header>
    ${open ? html`<div class="sec-body" id=${`sec-body-${id}`}>${children}</div>` : null}
  </section>`;
}

// Scroll a section into view and make sure it's open (deep links: #/machines, #/history).
// The lists above it keep growing as data lands, which moves the target — so the scroll is
// repeated once things have settled, otherwise you end up a screen short of where you asked for.
export function revealSection(id) {
  if (opened[id]) opened[id].value = true;
  const land = (behavior) => {
    const el = document.getElementById(`sec-${id}`);
    if (el) el.scrollIntoView({ behavior, block: 'start' });
  };
  requestAnimationFrame(() => land('auto'));
  setTimeout(() => land('auto'), 250);
  setTimeout(() => land('smooth'), 700);
}

export const sectionOpen = (id, defaultOpen = true) => {
  if (!opened[id]) opened[id] = pref(`section.${id}`, defaultOpen);
  return opened[id];
};
