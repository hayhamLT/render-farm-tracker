// Updates — the home page. What's out of date, one click to update it: everything at once, several
// apps together, or one app on hand-picked machines. Machine state only shows where it changes what
// happens (offline, rendering, needs a restart). Rollouts in progress sit on top.
import { html } from '../lib/html.js';
import { useMemo } from 'preact/hooks';
import { signal } from '@preact/signals-core';
import { farm } from '../lib/store.js';
import { go } from '../lib/router.js';
import { openMenu, pref } from '../lib/ui.js';
import { ago, plural, cmpVersion } from '../lib/format.js';
import {
  normalizeProducts, isTracked, appliesToOS, productStatus, inProgressNodes, latestForOS, nodesByKind, nvidiaTarget,
  nudgeWaiting, selfUpdateBehind,
} from '../lib/domain.js';
import * as act from '../lib/actions.js';
import { canUpdate, installerState, updateTargets } from '../lib/updater.js';
import { Icon, OsStatus, ProductLogo, ViewToggle } from '../components/common.js';
import { PageHeader } from '../components/page.js';
import { StackBar, Donut, Num, Ring } from '../components/viz.js';
import { RolloutList } from '../components/rollouts.js';
import { openUpdate } from '../components/update-sheet.js';
import { openRollout } from './deploy.js';
import { showMachines, useMachineModel, fleetSegments } from './machines.js';

const selectedApps = signal(new Set());   // product keys ticked for a batch update
const expanded = signal(null);            // product key whose machines are shown
const picks = signal({});                 // product key -> Set(node ids) chosen by hand
const view = pref('updates.view', 'list');

const RENDER_GPU = 20;
const OSES = ['windows', 'macos'];

// Apps, plug-ins and scripts are listed apart only because they're managed differently;
// drivers are just apps.
const KIND = {
  app: { label: 'Apps', icon: 'package', hint: '' },
  plugin: { label: 'Plug-ins', icon: 'zap', hint: '' },
  script: { label: 'Scripts', icon: 'file', hint: '' },
};
const kindOf = (p) => (['plugin', 'script'].includes(p.category) ? p.category : 'app');

function appModel(s, p) {
  const applicable = s.nodes.filter((n) => appliesToOS(p, n.os) && productStatus(n, p).status !== 'na');
  const installed = applicable.filter((n) => (n.software || []).some((x) => x.product_key === p.key));
  // A self-updating app that's behind is NOT current, even though its status reads "selfupdate".
  const current = installed.filter((n) => {
    const st = productStatus(n, p).status;
    return st === 'uptodate' || (st === 'selfupdate' && !selfUpdateBehind(n, p));
  });
  const behind = updateTargets(s, p);
  // Asked to self-update, Adobe hasn't finished: shown, but not offered again.
  const waiting = installed.filter((n) => selfUpdateBehind(n, p) && nudgeWaiting(s, n, p));
  const majors = nodesByKind(s, p, OSES, ['major']);
  const updating = inProgressNodes(s, p, OSES);
  const from = [...new Set(behind.map((n) => productStatus(n, p).version).filter(Boolean))].sort((a, b) => cmpVersion(a, b));
  const targets = [...new Set(installed.map((n) => (p.key === 'nvidia' ? nvidiaTarget(n, p) : latestForOS(p, n.os))).filter(Boolean))];
  const oses = [...new Set(behind.map((n) => n.os))];
  const installers = oses.map((os) => ({ os, ...installerState(p, os) }));
  return { p, installed, current, behind, waiting, majors, updating, from, targets, installers };
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

// Only shown when the installer needs attention — "ready" is the normal case and says nothing.
function Installers({ m }) {
  const bad = m.installers.filter((i) => !i.ok);
  const dl = m.installers.filter((i) => i.ok && i.download);
  if (bad.length) return html`<span class="ur-inst bad" title=${bad.map((i) => `${i.os === 'macos' ? 'Mac' : 'Windows'}: ${i.label}`).join('\n')}><${Icon} name="alert" />${bad.length === m.installers.length ? 'No installer yet' : `No ${bad[0].os === 'macos' ? 'Mac' : 'Windows'} installer`}</span>`;
  if (dl.length) return html`<span class="ur-inst info" title="The tracker downloads it to the share first"><${Icon} name="download" />Downloads first</span>`;
  if (m.installers.some((i) => i.nudge)) return html`<span class="ur-inst info" title="Adobe publishes no installer for a given version — the tracker restarts Creative Cloud's own updater on each machine, and Adobe applies the update from there."><${Icon} name="refresh" />Adobe's updater</span>`;
  return null;
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
  const current = !m.behind.length && !m.updating.length && !m.waiting.length;
  return html`<div class=${'ur' + (open ? ' open' : '') + (sel ? ' sel' : '') + (current ? ' quiet-row' : '')}>
    <div class="ur-main" onClick=${() => { expanded.value = open ? null : p.key; }}>
      <label class="ur-check" onClick=${(e) => e.stopPropagation()}>${current ? null : html`<input type="checkbox" checked=${sel} onChange=${toggleSel} aria-label=${`Select ${p.name}`} />`}</label>
      <${ProductLogo} product=${p} size=${34} />
      <div class="ur-name">
        <b>${p.name}</b>
        <span class="ur-ver">${m.from.length ? html`<span class="mono dim">${m.from.length > 2 ? `${m.from[0]} … ${m.from[m.from.length - 1]}` : m.from.join(', ')}</span><${Icon} name="chevron" /><span class="mono">${m.targets.join(' / ')}</span>` : html`<span class="mono">${m.targets.join(' / ') || p.latest_version || ''}</span>`}<${Installers} m=${m} /></span>
      </div>
      <div class="ur-cov" title=${`${m.current.length} of ${m.installed.length} current${m.updating.length ? ` · ${m.updating.length} updating` : ''}`}>
        <${StackBar} height=${6} total=${total} parts=${[
          { value: m.current.length, color: 'var(--ok)', label: 'current' },
          { value: m.updating.length, color: 'var(--accent)', label: 'updating' },
          { value: m.waiting.length, color: 'var(--text-3)', label: 'waiting on Adobe' },
          { value: m.behind.length, color: 'var(--info)', label: 'behind' },
        ]} />
        <span><b>${m.current.length}</b>/${m.installed.length} current${m.updating.length ? html` · <span style="color:var(--accent)">${m.updating.length} updating</span>` : ''}${m.waiting.length ? html` · <span class="dim" title=${m.waiting.map((n) => n.hostname).join(', ')}>${m.waiting.length} waiting on Adobe</span>` : ''}${s.lastVersionCheck ? html` · <span class="dim">checked ${ago(s.lastVersionCheck, s.now)}</span>` : ''}</span>
      </div>
      <div class="ur-actions" onClick=${(e) => e.stopPropagation()}>
        ${current
          ? html`<span class="uptodate"><${Icon} name="check" />Current</span>`
          : !m.behind.length && !m.updating.length && m.waiting.length
          ? html`<span class="tag pending" title=${`Asked ${ago(Math.max(...m.waiting.map((n) => nudgeWaiting(s, n, m.p))), s.now)} — Adobe applies it in the background. The version changes on a later check-in; if it hasn't by tomorrow, the Update button comes back.`}><${Icon} name="clock" />Waiting on Adobe</span>`
          : html`<button class="btn primary" disabled=${!chosen.length || blocked} title=${blocked ? 'Add the installer to the share first (Apps)' : !chosen.length && m.behind.length ? 'No machines picked' : ''}
            onClick=${() => openUpdate([{ product: p, nodes: chosen }])}>
            ${m.behind.length ? html`<${Icon} name="download" />Update ${chosen.length !== m.behind.length ? `${chosen.length} of ${m.behind.length}` : m.behind.length}` : html`<${Icon} name="spinner" cls="spin" />Updating`}</button>`}
        <button class="btn icon" aria-label=${`More for ${p.name}`} onClick=${menu}><${Icon} name="more" /></button>
      </div>
    </div>
    ${open && current ? html`<div class="ur-machines">
      <div class="ur-mhead"><span class="muted">${plural(m.installed.length, 'machine')} have it — all on the newest version</span></div>
      <div class="ur-grid">${m.installed.map((n) => html`<span key=${n.id} class="mchip"><${OsStatus} node=${n} /><span class="mchip-name">${n.hostname}</span><span class="mono dim">${productStatus(n, p).version || '—'}</span></span>`)}</div>
    </div>` : null}
    ${open && !current && html`<div class="ur-machines">
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

// Grid view: the same app, as a card.
function AppCard({ m }) {
  const { p } = m;
  const chosen = chosenFor(m);
  const blocked = m.installers.length && m.installers.every((i) => !i.ok);
  const pct = m.installed.length ? Math.round((m.current.length / m.installed.length) * 100) : 100;
  return html`<article class="card ucard3">
    <header>
      <${ProductLogo} product=${p} size=${32} />
      <div class="uc3-name"><b>${p.name}</b><span class="ur-ver"><span class="mono dim">${m.from[0] || ''}</span>${m.from.length ? html`<${Icon} name="chevron" />` : null}<span class="mono">${m.targets.join(' / ')}</span></span></div>
      <${Ring} size=${46} stroke=${5} total=${Math.max(1, m.installed.length)} label=${`${m.current.length} of ${m.installed.length} current`}
        segments=${[{ value: m.current.length, color: 'var(--ok)' }, { value: m.updating.length, color: 'var(--accent)' }, { value: m.waiting.length, color: 'var(--text-3)' }, { value: m.behind.length, color: 'var(--info)' }]}>
        <span class="uc3-pct">${pct}<small>%</small></span>
      <//>
    </header>
    <div class="uc3-meta"><${Installers} m=${m} />${m.updating.length ? html`<span class="tag accent"><${Icon} name="spinner" cls="spin" />${m.updating.length} updating</span>` : null}${m.waiting.length ? html`<span class="tag pending" title=${m.waiting.map((n) => n.hostname).join(', ')}><${Icon} name="clock" />${m.waiting.length} waiting on Adobe</span>` : null}</div>
    <footer>
      <span class="dim">${m.behind.length ? `${plural(m.behind.length, 'machine')} behind` : m.updating.length ? `${m.updating.length} updating` : m.waiting.length ? `${plural(m.waiting.length, 'machine')} asked` : `on ${plural(m.installed.length, 'machine')}`}</span>
      <span class="grow"></span>
      ${m.behind.length ? html`<button class="btn sm" onClick=${() => { view.value = 'list'; expanded.value = p.key; }}>Choose…</button>
        <button class="btn sm primary" disabled=${!chosen.length || blocked} onClick=${() => openUpdate([{ product: p, nodes: chosen }])}><${Icon} name="download" />Update ${m.behind.length}</button>`
        : m.waiting.length ? html`<span class="tag pending"><${Icon} name="clock" />Waiting on Adobe</span>`
        : html`<span class="uptodate"><${Icon} name="check" />Current</span>`}
    </footer>
  </article>`;
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

// Farm coverage at a glance — the SAME slices as the Machines page (fleetSegments), because it's
// the same farm; each one opens Machines filtered to it.
function Hero({ s, models, updateCount, updateAll, appsBehind }) {
  const model = useMachineModel();
  const segments = model ? fleetSegments(model).map((seg) => ({ ...seg, onClick: () => showMachines(seg.key) })) : [];
  const upToDate = segments.length ? segments[0].value : 0;
  const behindCount = segments.length ? segments.find((x) => x.key === 'behind').value : 0;
  const offline = segments.length ? segments.find((x) => x.key === 'offline').value : 0;
  const total = Math.max(1, s.nodes.length);
  const pct = Math.round((upToDate / total) * 100);
  const checked = s.lastVersionCheck || 0;
  const buckets = { current: upToDate, behind: behindCount, offline };
  return html`<section class="card card-pad hero">
    <${Donut} segments=${segments} size=${138} stroke=${15} center=${`${pct}%`} sub="up to date" label=${`${buckets.current} of ${s.nodes.length} machines up to date`} />
    <div class="hero-side">
      <div class="hero-kpis">
        <div class=${'hero-kpi' + (updateCount ? ' hot' : '')}><span class="l">Updates waiting</span><b><${Num} value=${updateCount} /></b><span class="s">${appsBehind ? `across ${plural(appsBehind, 'app')}` : 'nothing to install'}</span></div>
        <div class="hero-kpi"><span class="l">Machines behind</span><b><${Num} value=${buckets.behind} /></b><span class="s">${buckets.offline ? `${buckets.offline} offline too` : `of ${s.nodes.length}`}</span></div>
        <div class="hero-kpi"><span class="l">Last version check</span><b class="small">${checked ? ago(checked, s.now) : '—'}</b><span class="s">${plural(s.products.filter((p) => isTracked(p)).length, 'app')} watched</span></div>
      </div>
      <div class="row" style="gap:8px">
        ${updateCount
          ? html`<button class="btn primary" onClick=${updateAll}><${Icon} name="download" />Update all (${updateCount})</button>
                 <button class="btn" onClick=${act.checkVersions}><${Icon} name="refresh" />Check for updates</button>`
          : html`<button class="btn primary" onClick=${act.checkVersions}><${Icon} name="refresh" />Check for new versions</button>
                 <button class="btn" onClick=${() => go('history')}><${Icon} name="activity" />See what was installed</button>`}
      </div>
    </div>
  </section>`;
}

// Nothing to install: show what the farm actually looks like instead of a row of zeros.
function AllClear({ s, models }) {
  const DAY = 24 * 3600 * 1000;
  const recent = s.jobs.filter((j) => j.status === 'success').sort((a, b) => b.updated_at - a.updated_at);
  const week = recent.filter((j) => j.updated_at > Date.now() - 7 * DAY).length;
  const names = new Map(s.products.map((p) => [p.key, p]));
  const scheduled = (s.rollouts || []).filter((r) => r.status === 'scheduled').sort((a, b) => a.run_at - b.run_at)[0];
  const installed = models.filter((m) => m.installed.length);
  return html`<section class="card card-pad allclear">
    <div class="ac-head"><span class="ac-mark"><${Icon} name="check" /></span>
      <div><b>Every machine is running the newest version of everything</b>
        <p class="muted" style="margin:2px 0 0">${plural(installed.length, 'app')} watched across ${plural(s.nodes.length, 'machine')}. New versions are picked up automatically every few hours; an update only starts when you say so${scheduled ? `, or at the time you scheduled` : ''}.</p></div>
    </div>
    ${scheduled ? html`<div class="banner info"><${Icon} name="clock" /><span class="grow">Next scheduled: <b>${scheduled.name}</b> on ${plural(scheduled.counts.machines, 'machine')}</span><button class="btn sm" onClick=${() => go('history')}>Details</button></div>` : null}
    ${recent.length ? html`<div>
      <p class="section-title" style="margin-bottom:6px">Installed recently${week ? ` · ${week} in the last 7 days` : ''}</p>
      <ul class="ac-recent">${recent.slice(0, 5).map((j) => html`<li key=${j.id}>
        <${ProductLogo} product=${names.get(j.product_key) || { key: j.product_key, name: j.product_key }} size=${18} />
        <b>${(names.get(j.product_key) || {}).name || j.product_key}</b><span class="mono dim">${j.package_version}</span>
        <span class="grow"></span><button class="linkish" onClick=${() => go('machines', j.hostname)}>${j.hostname}</button><span class="dim nowrap">${ago(j.updated_at, s.now)}</span>
      </li>`)}</ul>
      <button class="linkish" style="margin-top:8px" onClick=${() => go('history')}>Full history →</button>
    </div>` : null}
  </section>`;
}

export function UpdatesView() {
  const s = farm.value;
  const models = useMemo(() => {
    if (!s) return [];
    return normalizeProducts(s).filter(isTracked).map((p) => appModel(s, p));
  }, [s]);
  if (!s) return null;

  // Every app the tracker can update, the ones that need something first — so the page always
  // says what's installed and on which version, not just what's pending.
  const available = models.filter((m) => canUpdate(m.p) && (m.installed.length || m.behind.length || m.updating.length))
    .sort((a, b) => b.behind.length - a.behind.length || b.updating.length - a.updating.length || a.p.name.localeCompare(b.p.name));
  const pending = available.filter((m) => m.behind.length || m.updating.length);
  const majors = models.filter((m) => canUpdate(m.p) && m.majors.length);
  const current = available.filter((m) => !m.behind.length && !m.updating.length);
  const selfManaged = models.filter((m) => m.installed.length && !canUpdate(m.p));
  const behindMachines = new Set(available.flatMap((m) => m.behind.map((n) => n.id)));
  const updateCount = available.reduce((c, m) => c + m.behind.length, 0);
  const openRollouts = (s.rollouts || []).filter((r) => ['scheduled', 'running'].includes(r.status));

  const sel = available.filter((m) => selectedApps.value.has(m.p.key) && m.behind.length);
  const selItems = sel.map((m) => ({ product: m.p, nodes: chosenFor(m) })).filter((i) => i.nodes.length);
  const selMachines = new Set(selItems.flatMap((i) => i.nodes.map((n) => n.id)));
  const updateAll = () => openUpdate(available.filter((m) => m.behind.length && !m.installers.every((i) => !i.ok)).map((m) => ({ product: m.p, nodes: m.behind })),
    { title: 'Update everything', subtitle: `${plural(updateCount, 'update')} across ${plural(behindMachines.size, 'machine')}` });

  const groups = ['app', 'plugin', 'script']
    .map((kind) => ({ kind, ...KIND[kind], rows: available.filter((m) => kindOf(m.p) === kind) }))
    .filter((g) => g.rows.length);

  return html`<div class="page updates-page">
    <${PageHeader} title="Updates" subtitle=${updateCount ? `${plural(updateCount, 'update')} for ${plural(behindMachines.size, 'machine')}` : 'Every machine is up to date'}>
      <button class="btn" onClick=${() => openRollout({})}><${Icon} name="package" />Install a specific version…</button>
      ${available.length ? html`<${ViewToggle} value=${view.value} onChange=${(v) => { view.value = v; }} />` : null}
    </${PageHeader}>

    <div class="stack">
      <${Hero} s=${s} models=${models} updateCount=${updateCount} appsBehind=${available.filter((m) => m.behind.length).length} updateAll=${updateAll} />
      <${Attention} s=${s} models=${models} />

      ${openRollouts.length ? html`<section class="card card-pad">
        <div class="row" style="margin-bottom:10px"><h2 class="card-title" style="margin:0"><${Icon} name="activity" />In progress</h2><span class="grow"></span><button class="linkish" onClick=${() => go('history')}>History</button></div>
        <${RolloutList} s=${s} limitDone=${0} />
      </section>` : null}

      ${!pending.length ? html`<${AllClear} s=${s} models=${models} />` : null}
      ${available.length ? groups.map((g) => html`<section key=${g.kind} class="card ulist">
        <div class="ulist-head">
          <label class="ur-check">${g.rows.some((m) => m.behind.length) ? html`<input type="checkbox" aria-label=${`Select all ${g.label.toLowerCase()} with updates`}
            title="Select every app here that has updates"
            checked=${g.rows.filter((m) => m.behind.length).every((m) => selectedApps.value.has(m.p.key))}
            onChange=${(e) => {
              const keys = g.rows.filter((m) => m.behind.length).map((m) => m.p.key);
              const next = new Set(selectedApps.value);
              keys.forEach((k) => (e.currentTarget.checked ? next.add(k) : next.delete(k)));
              selectedApps.value = next;
            }} />` : null}</label>
          <span class=${'ulist-icon k-' + g.kind}><${Icon} name=${g.icon} /></span>
          <h2>${g.label}</h2>
          <span class="dim">${g.rows.some((m) => m.behind.length) ? `${plural(g.rows.reduce((c, m) => c + m.behind.length, 0), 'update')} · ` : ''}${plural(g.rows.length, 'app')}</span>
          ${g.hint ? html`<span class="grow"></span><span class="dim" style="font-size:.8rem">${g.hint}</span>` : null}
        </div>
        ${view.value === 'grid'
          ? html`<div class="ugrid3">${g.rows.map((m) => html`<${AppCard} key=${m.p.key} m=${m} />`)}</div>`
          : g.rows.map((m) => html`<${AppRow} key=${m.p.key} m=${m} s=${s} />`)}
      </section>`) : null}

      ${majors.length ? html`<section class="card ulist">
        <div class="ulist-head"><h2>New major versions</h2><span class="dim">install next to the current version — opt in per app</span></div>
        ${majors.map((m) => html`<div key=${m.p.key} class="ur"><div class="ur-main static">
          <span class="ur-check"></span><${ProductLogo} product=${m.p} size=${34} />
          <div class="ur-name"><b>${m.p.name}</b><span class="ur-ver"><span class="mono">${m.targets.join(' / ')}</span></span></div>
          <div class="ur-cov"><span>${plural(m.majors.length, 'machine')} on an older major</span></div>
          <div class="ur-actions"><button class="btn" onClick=${() => openUpdate([{ product: m.p, nodes: m.majors }], { title: `Install ${m.p.name} ${m.targets[0] || ''}`, subtitle: 'New major version — installs next to the current one' })}><${Icon} name="up" />Install on ${m.majors.length}</button></div>
        </div></div>`)}
      </section>` : null}

      ${selfManaged.length ? html`<details class="quiet">
        <summary><${Icon} name="refresh" />${plural(selfManaged.length, 'app')} the tracker doesn't update itself</summary>
        <div class="current-list">${selfManaged.map((m) => html`<span key=${m.p.key} class="current-chip"><${ProductLogo} product=${m.p} size=${18} />${m.p.name}<span class="mono dim">${m.targets.join(' / ') || m.p.latest_version || ''}</span></span>`)}</div>
        <p class="dim" style="margin:8px 0 0;font-size:.82rem">${selfManaged.map((m) => m.p.name).join(', ')} ${selfManaged.length === 1 ? 'updates itself or is' : 'update themselves or are'} tracked only — shown on each machine, not updated from here.</p>
      </details>` : null}
    </div>

    ${sel.length ? html`<div class="bulkbar" role="toolbar" aria-label="Update selected apps">
      <b>${plural(sel.length, 'app')} · ${plural(selMachines.size, 'machine')}</b>
      <button class="btn sm primary" onClick=${() => openUpdate(selItems)}><${Icon} name="download" />Update selected…</button>
      <button class="btn ghost sm icon" aria-label="Clear selection" onClick=${() => { selectedApps.value = new Set(); }}><${Icon} name="close" /></button>
    </div>` : null}
  </div>`;
}
