// The one "review and update" step every Update button opens: what will update where, anything
// that will make it wait (offline, rendering, restart needed, missing installer), and when it runs.
import { html } from '../lib/html.js';
import { useState } from 'preact/hooks';
import { farm, refresh } from '../lib/store.js';
import { openSheet, toast } from '../lib/ui.js';
import { plural } from '../lib/format.js';
import { latestForOS, productStatus, nvidiaTarget, SELF_UPDATING } from '../lib/domain.js';
import { installerState, queueUpdates } from '../lib/updater.js';
import { Icon, Badge, ProductLogo, OsStatus } from './common.js';
import { WhenPicker, rolloutPlan, resetWhen, when, whenLabel } from './rollouts.js';

const RENDER_GPU = 20;

function waits(nodes, product) {
  const offline = nodes.filter((n) => !n.online);
  const rendering = nodes.filter((n) => n.online && n.gpu_util != null && n.gpu_util >= RENDER_GPU);
  const reboot = product.key === 'nvidia' ? nodes.filter((n) => n.online && n.pending_reboot) : [];
  const elevation = nodes.filter((n) => n.elevated === 0);
  return { offline, rendering, reboot, elevation };
}

function ItemRow({ item }) {
  const [open, setOpen] = useState(false);
  const { product: p, nodes } = item;
  const oses = [...new Set(nodes.map((n) => n.os))];
  const w = waits(nodes, p);
  const versions = [...new Set(nodes.map((n) => (p.key === 'nvidia' ? nvidiaTarget(n, p) : latestForOS(p, n.os))).filter(Boolean))];
  const inst = oses.map((os) => ({ os, ...installerState(p, os) }));
  return html`<div class="us-item">
    <button class="us-head" onClick=${() => setOpen(!open)} aria-expanded=${open}>
      <${ProductLogo} product=${p} size=${28} />
      <span class="us-title"><b>${p.name}</b><span class="dim">→ ${versions.join(' / ') || 'latest'}</span></span>
      <span class="grow"></span>
      <span class="us-count">${plural(nodes.length, 'machine')}</span>
      <${Icon} name="chevronDown" cls=${open ? 'flip-v' : ''} />
    </button>
    <div class="us-notes">
      ${SELF_UPDATING.has(p.key) ? html`<${Badge} tone="info" icon="refresh">Restarts Adobe's updater — the new version lands once Adobe finishes<//>` : null}
      ${inst.filter((i) => !i.ok).map((i) => html`<${Badge} key=${i.os} tone="bad" icon="alert">${i.os === 'macos' ? 'Mac' : 'Windows'}: ${i.label}<//>`)}
      ${inst.filter((i) => i.ok && i.download).map((i) => html`<${Badge} key=${'d' + i.os} tone="info" icon="download">${i.os === 'macos' ? 'Mac' : 'Windows'}: ${i.label}<//>`)}
      ${w.offline.length ? html`<${Badge} tone="warn" icon="power" title=${w.offline.map((n) => n.hostname).join(', ')}>${w.offline.length} offline — updates when back<//>` : null}
      ${w.rendering.length ? html`<${Badge} tone="violet" icon="film" title=${w.rendering.map((n) => n.hostname).join(', ')}>${w.rendering.length} rendering — starts when idle<//>` : null}
      ${w.reboot.length ? html`<${Badge} tone="warn" icon="refresh" title=${w.reboot.map((n) => n.hostname).join(', ')}>${w.reboot.length} need a restart first<//>` : null}
      ${w.elevation.length ? html`<${Badge} tone="warn" icon="shieldOff" title=${w.elevation.map((n) => n.hostname).join(', ')}>${w.elevation.length} not set up for silent installs<//>` : null}
    </div>
    ${open && html`<div class="us-machines">${nodes.map((n) => {
      const st = productStatus(n, p);
      return html`<span key=${n.id} class="us-machine"><${OsStatus} node=${n} /><b>${n.hostname}</b><span class="mono dim">${st.version || '—'} → ${st.target || versions[0] || ''}</span></span>`;
    })}</div>`}
  </div>`;
}

function UpdateSheet({ items, close }) {
  const s = farm.value;
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState(null);
  const machines = new Set(items.flatMap((i) => i.nodes.map((n) => n.id)));
  const updates = items.reduce((c, i) => c + i.nodes.length, 0);
  const blocked = items.every((i) => [...new Set(i.nodes.map((n) => n.os))].every((os) => !installerState(i.product, os).ok));

  const go = async () => {
    setBusy(true);
    try {
      const name = items.length === 1 ? `${items[0].product.name} ${items[0].product.latest_version || ''}`.trim() : items.map((i) => i.product.name).join(', ');
      const plan = rolloutPlan(name, s);
      const r = await queueUpdates(items, plan, { onProgress: setProgress });
      const later = r.rollout.status === 'scheduled';
      if (r.queued.length) {
        toast(later ? `Scheduled for ${whenLabel(r.rollout.run_at)} on ${plural(r.queued.length, 'machine')}.` : `Updating ${plural(r.queued.length, 'machine')} — each starts as soon as it's free.`, 'success', 6000);
      }
      if (r.skipped.length || !r.queued.length) { setResult(r); setBusy(false); refresh(); return; }
      resetWhen();
      refresh();
      close(true);
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  };

  return html`<div class="stack us">
    <div class="us-list">${items.map((it) => html`<${ItemRow} key=${it.product.key} item=${it} />`)}</div>
    <p class="dim" style="margin:0;font-size:.82rem">New versions install on 3 machines first and continue once one succeeds. Installs never start under a render, and each machine does one update at a time.</p>
    <${WhenPicker} s=${s} />
    ${result && html`<div class=${'banner ' + (result.queued.length ? 'warn' : 'bad')}><${Icon} name="alert" /><div>
      ${result.queued.length ? html`<b>Queued on ${plural(result.queued.length, 'machine')}, but some were skipped:</b>` : html`<b>Nothing was queued:</b>`}
      <ul style="margin:6px 0 0;padding-left:18px">${result.skipped.map((t) => html`<li key=${t}>${t}</li>`)}</ul></div></div>`}
    <div class="deploy-go">
      <span class="muted">${busy ? progress || 'Working…' : `${plural(updates, 'update')} on ${plural(machines.size, 'machine')}`}</span>
      <span class="grow"></span>
      <button class="btn ghost" onClick=${() => close(result ? true : null)}>${result ? 'Close' : 'Cancel'}</button>
      ${!result && html`<button class="btn primary" disabled=${busy || blocked || !updates} onClick=${go} title=${blocked ? 'No installer is available for these apps yet' : ''}>
        ${busy ? html`<${Icon} name="spinner" cls="spin" />Working…` : when.value === 'now' ? html`<${Icon} name="download" />Update now` : html`<${Icon} name="clock" />Schedule`}</button>`}
    </div>
  </div>`;
}

// items: [{ product, nodes }]
export function openUpdate(items, { title, subtitle } = {}) {
  items = items.filter((i) => i.nodes.length);
  if (!items.length) { toast('Nothing to update — those machines are current or already updating.', 'info'); return Promise.resolve(null); }
  const machines = new Set(items.flatMap((i) => i.nodes.map((n) => n.id))).size;
  return openSheet((close) => html`<${UpdateSheet} items=${items} close=${close} />`, {
    title: title || (items.length === 1 ? `Update ${items[0].product.name}` : `Update ${plural(items.length, 'app')}`),
    subtitle: subtitle || `${plural(machines, 'machine')} · review, pick when, go`,
    width: 620,
  });
}
