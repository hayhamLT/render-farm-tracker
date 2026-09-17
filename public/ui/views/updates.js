// Updates — the home page. What's out of date, one click to update it: everything at once, several
// apps together, or one app on hand-picked machines. Machine state only shows where it changes what
// happens (offline, rendering, needs a restart). Rollouts in progress sit on top.
import { html } from '../lib/html.js';
import { useMemo } from 'preact/hooks';
import { signal } from '@preact/signals-core';
import { farm } from '../lib/store.js';
import { go } from '../lib/router.js';
import { openMenu } from '../lib/ui.js';
import { plural, cmpVersion } from '../lib/format.js';
import {
  normalizeProducts, isTracked, appliesToOS, productStatus, inProgressNodes, latestForOS, nodesByKind, nvidiaTarget, SELF_UPDATING,
} from '../lib/domain.js';
import * as act from '../lib/actions.js';
import { canUpdate, installerState, updateTargets } from '../lib/updater.js';
import { Icon, OsStatus, ProductLogo } from '../components/common.js';
import { PageHeader } from '../components/page.js';
import { StackBar } from '../components/viz.js';
import { RolloutList } from '../components/rollouts.js';
import { openUpdate } from '../components/update-sheet.js';
import { openRollout } from './deploy.js';

const selectedApps = signal(new Set());   // product keys ticked for a batch update
const expanded = signal(null);            // product key whose machines are shown
const picks = signal({});                 // product key -> Set(node ids) chosen by hand

const RENDER_GPU = 20;
const OSES = ['windows', 'macos'];

function appModel(s, p) {
  const applicable = s.nodes.filter((n) => appliesToOS(p, n.os) && productStatus(n, p).status !== 'na');
  const installed = applicable.filter((n) => (n.software || []).some((x) => x.product_key === p.key));
  const current = installed.filter((n) => ['uptodate', 'selfupdate'].includes(productStatus(n, p).status));
  const behind = updateTargets(s, p);
  const majors = nodesByKind(s, p, OSES, ['major']);
  const updating = inProgressNodes(s, p, OSES);
  const from = [...new Set(behind.map((n) => productStatus(n, p).version).filter(Boolean))].sort((a, b) => cmpVersion(a, b));
  const targets = [...new Set(installed.map((n) => (p.key === 'nvidia' ? nvidiaTarget(n, p) : latestForOS(p, n.os))).filter(Boolean))];
  const oses = [...new Set(behind.map((n) => n.os))];
  const installers = oses.map((os) => ({ os, ...installerState(p, os) }));
  return { p, installed, current, behind, majors, updating, from, targets, installers };
}

const chosenFor = (m) => {
  const set = picks.value[m.p.key];
  return set ? m.behind.filter((n) => set.has(n.id)) : m.behind;
};

function MachineState({ n }) {
  if (!n.online) return html`<span class="tag bad">offline</span>`;
  if (n.gpu_util != null && n.gpu_util >= RENDER_GPU) return html`<span class="tag violet" title="Installs wait until the render finishes">rendering</span>`;
  if (n.pending_reboot) return html`<span class="tag warn" title="Windows is waiting for a restart">restart pending</span>`;
  return null;
}

function Installers({ m }) {
  const bad = m.installers.filter((i) => !i.ok);
  const dl = m.installers.filter((i) => i.ok && i.download);
  if (bad.length) return html`<span class="ur-inst bad" title=${bad.map((i) => `${i.os === 'macos' ? 'Mac' : 'Windows'}: ${i.label}`).join('\n')}><${Icon} name="alert" />${bad.length === m.installers.length ? 'No installer yet' : `No ${bad[0].os === 'macos' ? 'Mac' : 'Windows'} installer`}</span>`;
  if (dl.length) return html`<span class="ur-inst info" title="The tracker downloads it to the share first"><${Icon} name="download" />Downloads first</span>`;
  return html`<span class="ur-inst ok"><${Icon} name="check" />Ready</span>`;
}

function AppRow({ m, s }) {
  const { p } = m;
  const open = expanded.value === p.key;
  const sel = selectedApps.value.has(p.key);
  const chosen = chosenFor(m);
  const total = Math.max(1, m.installed.length);
  const toggleSel = (e) => { e.stopPropagation(); const n = new Set(selectedApps.value); if (n.has(p.key)) n.delete(p.key); else n.add(p.key); selectedApps.value = n; };
  const setPick = (ids) => { picks.value = { ...picks.value, [p.key]: new Set(ids) }; };
  const togglePick = (id) => { const cur = new Set(chosen.map((n) => n.id)); if (cur.has(id)) cur.delete(id); else cur.add(id); setPick([...cur]); };
  const blocked = m.installers.length && m.installers.every((i) => !i.ok);
  const menu = (e) => {
    e.stopPropagation();
    openMenu(e.currentTarget, [
      { label: `Update ${plural(m.behind.length, 'machine')}…`, icon: 'download', disabled: !m.behind.length, onSelect: () => openUpdate([{ product: p, nodes: m.behind }]) },
      { label: 'Choose machines', icon: 'server', disabled: !m.behind.length, onSelect: () => { expanded.value = p.key; } },
      m.majors.length ? { label: `Install ${String(m.targets[0] || '').split('.')[0]} side by side (${m.majors.length})…`, icon: 'up', onSelect: () => openUpdate([{ product: p, nodes: m.majors }], { title: `Install ${p.name} ${m.targets[0] || ''}`, subtitle: 'New major version — installs next to the current one' }) } : null,
      '-',
      { label: 'Install a specific version…', icon: 'package', onSelect: () => openRollout({ productKey: p.key, mode: 'choose' }) },
      { label: 'Show machines', icon: 'grid', onSelect: () => go('machines') },
    ]);
  };
  return html`<div class=${'ur' + (open ? ' open' : '') + (sel ? ' sel' : '')}>
    <div class="ur-main" onClick=${() => { expanded.value = open ? null : p.key; }}>
      <label class="ur-check" onClick=${(e) => e.stopPropagation()}><input type="checkbox" checked=${sel} onChange=${toggleSel} aria-label=${`Select ${p.name}`} /></label>
      <${ProductLogo} product=${p} size=${34} />
      <div class="ur-name">
        <b>${p.name}</b>
        <span class="ur-ver">${m.from.length ? html`<span class="mono dim">${m.from.length > 2 ? `${m.from[0]} … ${m.from[m.from.length - 1]}` : m.from.join(', ')}</span><${Icon} name="chevron" /><span class="mono">${m.targets.join(' / ')}</span>` : html`<span class="mono">${m.targets.join(' / ') || p.latest_version || ''}</span>`}</span>
      </div>
      <div class="ur-cov" title=${`${m.current.length} of ${m.installed.length} current${m.updating.length ? ` · ${m.updating.length} updating` : ''}`}>
        <${StackBar} height=${6} total=${total} parts=${[
          { value: m.current.length, color: 'var(--ok)', label: 'current' },
          { value: m.updating.length, color: 'var(--accent)', label: 'updating' },
          { value: m.behind.length, color: 'var(--info)', label: 'behind' },
        ]} />
        <span><b>${m.current.length}</b>/${m.installed.length} current${m.updating.length ? html` · <span style="color:var(--accent)">${m.updating.length} updating</span>` : ''}</span>
      </div>
      <${Installers} m=${m} />
      <div class="ur-actions" onClick=${(e) => e.stopPropagation()}>
        <button class="btn primary" disabled=${!chosen.length || blocked} title=${blocked ? 'Add the installer to the share first (Apps)' : !chosen.length && m.behind.length ? 'No machines picked' : ''}
          onClick=${() => openUpdate([{ product: p, nodes: chosen }])}>
          ${m.behind.length ? html`<${Icon} name="download" />Update ${chosen.length !== m.behind.length ? `${chosen.length} of ${m.behind.length}` : m.behind.length}` : html`<${Icon} name="spinner" cls="spin" />Updating`}</button>
        <button class="btn icon" aria-label=${`More for ${p.name}`} onClick=${menu}><${Icon} name="more" /></button>
      </div>
    </div>
    ${open && html`<div class="ur-machines">
      <div class="ur-mhead">
        ${m.behind.length ? html`<span class="muted">${plural(m.behind.length, 'machine')} behind — pick which ones update</span>
        <button class="linkish" onClick=${() => setPick(m.behind.map((n) => n.id))}>All</button>
        <button class="linkish" onClick=${() => setPick(m.behind.filter((n) => n.online && !(n.gpu_util >= RENDER_GPU)).map((n) => n.id))}>Online & idle only</button>
        <button class="linkish" onClick=${() => setPick([])}>None</button>` : html`<span class="muted">Updating now</span>`}
      </div>
      <div class="ur-grid">
        ${m.behind.map((n) => {
          const on = chosen.some((x) => x.id === n.id);
          const st = productStatus(n, p);
          return html`<label key=${n.id} class=${'mchip' + (on ? ' on' : '')}>
            <input type="checkbox" checked=${on} onChange=${() => togglePick(n.id)} />
            <${OsStatus} node=${n} />
            <span class="mchip-name">${n.hostname}</span>
            <span class="mono dim">${st.version}</span>
            <${MachineState} n=${n} />
          </label>`;
        })}
        ${m.updating.map((n) => html`<span key=${'u' + n.id} class="mchip busy"><${Icon} name="spinner" cls="spin" /><span class="mchip-name">${n.hostname}</span><span class="dim">updating</span></span>`)}
      </div>
    </div>`}
  </div>`;
}

function Attention({ s, models }) {
  const day = Date.now() - 24 * 3600 * 1000;
  const failed = s.jobs.filter((j) => j.status === 'failed' && j.updated_at > day);
  const failedLatest = [...new Map(failed.map((j) => [`${j.hostname}|${j.product_key}`, j])).values()];
  const behindIds = new Set(models.flatMap((m) => m.behind.map((n) => n.id)));
  const offline = s.nodes.filter((n) => !n.online && behindIds.has(n.id));
  const notReady = s.nodes.filter((n) => n.elevated === 0 && behindIds.has(n.id));
  const items = [
    failedLatest.length && { tone: 'bad', icon: 'alert', text: `${plural(failedLatest.length, 'install')} failed in the last 24 h`, detail: failedLatest.slice(0, 4).map((j) => j.hostname).join(', '),
      actions: [{ label: 'Retry all', run: async () => { for (const j of failedLatest) await act.retryJob(j); } }, { label: 'View', run: () => go('history') }] },
    offline.length && { tone: 'warn', icon: 'power', text: `${plural(offline.length, 'machine')} with updates ${offline.length === 1 ? 'is' : 'are'} offline`, detail: offline.slice(0, 5).map((n) => n.hostname).join(', '),
      actions: [{ label: 'Wake', run: () => act.wake(offline) }] },
    notReady.length && { tone: 'warn', icon: 'shieldOff', text: `${plural(notReady.length, 'machine')} can't install silently yet`, detail: 'Run the elevate command once on them (Settings → Enroll a machine)',
      actions: [{ label: 'How', run: () => go('settings') }] },
  ].filter(Boolean);
  if (!items.length) return null;
  return html`<div class="attn">${items.map((it) => html`<div key=${it.text} class=${'attn-item ' + it.tone}>
    <${Icon} name=${it.icon} /><div class="grow"><b>${it.text}</b><span class="dim">${it.detail}</span></div>
    ${it.actions.map((a) => html`<button key=${a.label} class="btn sm" onClick=${a.run}>${a.label}</button>`)}
  </div>`)}</div>`;
}

export function UpdatesView() {
  const s = farm.value;
  const models = useMemo(() => {
    if (!s) return [];
    return normalizeProducts(s).filter(isTracked).map((p) => appModel(s, p));
  }, [s]);
  if (!s) return null;

  const available = models.filter((m) => canUpdate(m.p) && (m.behind.length || m.updating.length))
    .sort((a, b) => b.behind.length - a.behind.length || b.updating.length - a.updating.length);
  const majors = models.filter((m) => canUpdate(m.p) && m.majors.length);
  const current = models.filter((m) => !available.includes(m) && m.installed.length && !SELF_UPDATING.has(m.p.key) && canUpdate(m.p));
  const selfManaged = models.filter((m) => m.installed.length && (SELF_UPDATING.has(m.p.key) || !canUpdate(m.p)));
  const behindMachines = new Set(available.flatMap((m) => m.behind.map((n) => n.id)));
  const updateCount = available.reduce((c, m) => c + m.behind.length, 0);
  const openRollouts = (s.rollouts || []).filter((r) => ['scheduled', 'running'].includes(r.status));

  const sel = available.filter((m) => selectedApps.value.has(m.p.key) && m.behind.length);
  const selItems = sel.map((m) => ({ product: m.p, nodes: chosenFor(m) })).filter((i) => i.nodes.length);
  const selMachines = new Set(selItems.flatMap((i) => i.nodes.map((n) => n.id)));
  const updateAll = () => openUpdate(available.filter((m) => m.behind.length && !m.installers.every((i) => !i.ok)).map((m) => ({ product: m.p, nodes: m.behind })),
    { title: 'Update everything', subtitle: `${plural(updateCount, 'update')} across ${plural(behindMachines.size, 'machine')}` });

  return html`<div class="page updates-page">
    <${PageHeader} title="Updates" subtitle=${updateCount ? `${plural(updateCount, 'update')} for ${plural(behindMachines.size, 'machine')} across ${plural(available.filter((m) => m.behind.length).length, 'app')}` : 'Every machine is up to date'}>
      <button class="btn" onClick=${act.checkVersions}><${Icon} name="refresh" />Check for updates</button>
      <button class="btn" onClick=${() => openRollout({})}><${Icon} name="package" />Install a specific version…</button>
      <button class="btn primary" disabled=${!updateCount} onClick=${updateAll}><${Icon} name="download" />Update all</button>
    </${PageHeader}>

    <div class="stack">
      <${Attention} s=${s} models=${models} />

      ${openRollouts.length ? html`<section class="card card-pad">
        <div class="row" style="margin-bottom:10px"><h2 class="card-title" style="margin:0"><${Icon} name="activity" />In progress</h2><span class="grow"></span><button class="linkish" onClick=${() => go('history')}>History</button></div>
        <${RolloutList} s=${s} limitDone=${0} />
      </section>` : null}

      <section class="card ulist">
        <div class="ulist-head">
          <label class="ur-check"><input type="checkbox" aria-label="Select all apps with updates"
            checked=${available.length && available.filter((m) => m.behind.length).every((m) => selectedApps.value.has(m.p.key))}
            onChange=${(e) => { selectedApps.value = e.currentTarget.checked ? new Set(available.filter((m) => m.behind.length).map((m) => m.p.key)) : new Set(); }} /></label>
          <h2>Available updates</h2>
          <span class="dim">${plural(available.length, 'app')}</span>
        </div>
        ${available.length ? available.map((m) => html`<${AppRow} key=${m.p.key} m=${m} s=${s} />`)
          : html`<div class="empty-inline"><${Icon} name="check" /><div><b>Everything is up to date</b><p class="muted">New versions are checked automatically every few hours — or check now.</p></div></div>`}
      </section>

      ${majors.length ? html`<section class="card ulist">
        <div class="ulist-head"><h2>New major versions</h2><span class="dim">install next to the current version — opt in per app</span></div>
        ${majors.map((m) => html`<div key=${m.p.key} class="ur"><div class="ur-main static">
          <span class="ur-check"></span><${ProductLogo} product=${m.p} size=${34} />
          <div class="ur-name"><b>${m.p.name}</b><span class="ur-ver"><span class="mono">${m.targets.join(' / ')}</span></span></div>
          <div class="ur-cov"><span>${plural(m.majors.length, 'machine')} on an older major</span></div>
          <${Installers} m=${{ ...m, installers: [...new Set(m.majors.map((n) => n.os))].map((os) => ({ os, ...installerState(m.p, os) })) }} />
          <div class="ur-actions"><button class="btn" onClick=${() => openUpdate([{ product: m.p, nodes: m.majors }], { title: `Install ${m.p.name} ${m.targets[0] || ''}`, subtitle: 'New major version — installs next to the current one' })}><${Icon} name="up" />Install on ${m.majors.length}</button></div>
        </div></div>`)}
      </section>` : null}

      ${current.length ? html`<section>
        <h2 class="section-h">Up to date</h2>
        <div class="current-list">${current.map((m) => html`<span key=${m.p.key} class="current-chip" title=${`${m.current.length}/${m.installed.length} machines`}><${ProductLogo} product=${m.p} size=${18} />${m.p.name}<span class="mono dim">${m.targets.join(' / ') || m.p.latest_version || ''}</span><${Icon} name="check" /></span>`)}</div>
      </section>` : null}

      ${selfManaged.length ? html`<p class="dim" style="margin:0;font-size:.82rem">${selfManaged.map((m) => m.p.name).join(', ')} ${selfManaged.length === 1 ? 'updates itself or is' : 'update themselves or are'} tracked only — shown on each machine, not updated from here.</p>` : null}
    </div>

    ${sel.length ? html`<div class="bulkbar" role="toolbar" aria-label="Update selected apps">
      <b>${plural(sel.length, 'app')} · ${plural(selMachines.size, 'machine')}</b>
      <button class="btn sm primary" onClick=${() => openUpdate(selItems)}><${Icon} name="download" />Update selected…</button>
      <button class="btn ghost sm icon" aria-label="Clear selection" onClick=${() => { selectedApps.value = new Set(); }}><${Icon} name="close" /></button>
    </div>` : null}
  </div>`;
}
