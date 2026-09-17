// Updates: pick apps, choose machines and an installer source, queue the rollout; then follow
// every job. Deploy logic is a faithful port of the classic wizard (runWizard / updateWizard).
import { html } from '../lib/html.js';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { signal } from '@preact/signals-core';
import { farm, refresh } from '../lib/store.js';
import { get, post, put } from '../lib/api.js';
import { pref, toast, openSheet } from '../lib/ui.js';
import { ago, elapsed, plural, cmpVersion } from '../lib/format.js';
import { go } from '../lib/router.js';
import {
  normalizeProducts, isTracked, appliesToOS, productStatus, latestForOS, latestInstallerReady, isDeployable,
  nodesByKind, inProgressNodes, stagedFor, savedSource, ACTIVE, deadlineStatus,
} from '../lib/domain.js';
import { presetCommand, ADOBE_RUM } from '../lib/presets.js';
import * as act from '../lib/actions.js';
import { Icon, OsStatus, ProductLogo, Badge, Bar, Empty } from '../components/common.js';
import { PageHeader } from '../components/page.js';
import { Ring, StackBar, Num } from '../components/viz.js';

// ---- wizard state (module-level so it survives tab switches) ----
const chosenProducts = signal(new Set());
const osSel = signal('both');
const targetMode = signal('outdated');
const chosenNodes = signal(new Set());
const includeMajor = signal(false);
const source = signal('auto');
const nodeSearch = signal('');
const busy = signal(false);
const progress = signal(null);   // { text, tone }
const jobStatus = pref('jobs.status', 'all');
const jobProduct = signal('');
const jobSearch = signal('');
const openLogs = signal(new Set());

export function preselectUpdate({ productKey, hostname, major = false }) {
  chosenProducts.value = new Set([productKey]);
  const n = farm.value && farm.value.nodes.find((x) => x.hostname === hostname);
  if (n) { osSel.value = n.os; targetMode.value = 'choose'; chosenNodes.value = new Set([n.id]); }
  includeMajor.value = major;
  go('updates');
}

const osList = () => (osSel.value === 'both' ? ['windows', 'macos'] : [osSel.value]);
const shortUrl = (u) => { try { const x = new URL(u); return x.hostname + (x.pathname.length > 1 ? '/…' : ''); } catch { return String(u).slice(0, 30); } };

// ---------------------------------------------------------------- downloads (server-side fetches)
function useDownloads(active) {
  const [downloads, setDownloads] = useState([]);
  useEffect(() => {
    if (!active) return undefined;
    let stop = false;
    let timer;
    const tick = async () => {
      try { const r = await get('/api/downloads'); if (!stop) setDownloads(r.downloads || r || []); } catch { /* keep last */ }
      const busyNow = (Array.isArray(downloads) ? downloads : []).some((d) => ['downloading', 'pending'].includes(d.status));
      if (!stop) timer = setTimeout(tick, busyNow ? 2000 : 10000);
    };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [active]);
  return Array.isArray(downloads) ? downloads : [];
}

function dlMatch(filename) {
  const f = String(filename || '').toLowerCase();
  const key = /cinema\s*4d|c4d/.test(f) ? 'cinema4d' : /red\s*giant|redgiant/.test(f) ? 'redgiant' : /redshift/.test(f) ? 'redshift'
    : /maxon[\s_-]*(app|one)/.test(f) ? 'maxonapp' : /creative[\s_-]*cloud|accc/.test(f) ? 'creativecloud' : /after\s*effects/.test(f) ? 'aftereffects' : null;
  const os = /\.exe$|win/.test(f) ? 'windows' : /\.dmg$|\.pkg$|mac/.test(f) ? 'macos' : null;
  return { key, os };
}

// ---------------------------------------------------------------- product cards
function ProductCard({ p, s, downloads }) {
  const oses = osList();
  const on = chosenProducts.value.has(p.key);
  const deployable = isDeployable(p);
  const patch = nodesByKind(s, p, oses, ['patch']);
  const major = nodesByKind(s, p, oses, ['major', 'missing']);
  const busyN = inProgressNodes(s, p, oses);
  const ready = oses.every((os) => latestInstallerReady(p, os));
  let badges;
  if (!deployable) {
    const installed = s.nodes.filter((n) => oses.includes(n.os) && (n.software || []).some((x) => x.product_key === p.key)).length;
    badges = html`<${Badge} title="Tracking-only — add an install command in Catalog to deploy it">track only · ${installed} installed<//>`;
  } else if (!patch.length && !major.length) {
    badges = busyN.length ? html`<${Badge} tone="accent" icon="spinner">${busyN.length} updating<//>` : html`<${Badge} tone="ok" icon="check">all current<//>`;
  } else if (!ready) {
    badges = html`<${Badge} tone="warn" icon="alert" title="A newer version was detected but its installer isn't on the server yet">installer needed<//>`;
  } else {
    badges = html`${patch.length ? html`<${Badge} tone="info" icon="up">${patch.length} to update<//>` : null}
      ${busyN.length ? html`<${Badge} tone="accent" icon="spinner">${busyN.length} updating<//>` : null}
      ${major.length ? html`<${Badge} tone="violet" title="Newer major / not installed — opt-in side-by-side">${major.length} new major<//>` : null}
      ${!patch.length && !busyN.length ? html`<${Badge} tone="ok" icon="check">current<//>` : null}`;
  }
  const dls = downloads.filter((d) => ['downloading', 'pending', 'error'].includes(d.status)).filter((d) => dlMatch(d.filename).key === p.key);
  return html`<button type="button" class=${'card pcard' + (on ? ' on' : '')} aria-pressed=${on}
    onClick=${() => { const next = new Set(chosenProducts.value); if (next.has(p.key)) next.delete(p.key); else next.add(p.key); chosenProducts.value = next; source.value = 'auto'; }}>
    <span class="pcard-top"><${ProductLogo} product=${p} size=${28} />
      <span class="pcard-text"><b>${p.name}</b><span class="mono dim">${p.latest_win && p.latest_mac && p.latest_win !== p.latest_mac ? `Win ${p.latest_win} · Mac ${p.latest_mac}` : p.latest_version || 'no version yet'}</span></span>
      <span class="pcard-check">${on ? html`<${Icon} name="check" />` : null}</span></span>
    <span class="row" style="gap:5px">${badges}</span>
    ${dls.map((d) => html`<span class="row" style="gap:8px;flex-wrap:nowrap" title=${d.error || d.filename}>
      ${d.status === 'error' ? html`<${Badge} tone="bad">download failed<//>` : html`<${Bar} pct=${d.total ? (d.received / d.total) * 100 : 0} indet=${!d.total} /><span class="dim mono" style="font-size:.74rem">${d.total ? Math.round((d.received / d.total) * 100) + '%' : ((d.received || 0) / 1e9).toFixed(1) + ' GB'}</span>`}
    </span>`)}
  </button>`;
}

// ---------------------------------------------------------------- deploy panel
function DeployPanel({ s, products, onDone }) {
  const [files, setFiles] = useState([]);
  const [fields, setFields] = useState({ url: '', urlMac: '', file: '', fileMac: '', version: '', remember: true });
  const set = (k) => (e) => setFields({ ...fields, [k]: e.currentTarget.type === 'checkbox' ? e.currentTarget.checked : e.currentTarget.value });
  const sel = products.filter((p) => chosenProducts.value.has(p.key));
  const oses = osList();
  const both = osSel.value === 'both';
  const mode = source.value;
  useEffect(() => { if (mode === 'file') get('/api/installer-files').then((r) => setFiles(r.files || [])).catch(() => setFiles([])); }, [mode]);

  if (!sel.length) {
    const behind = products.filter(isTracked).some((p) => nodesByKind(s, p, ['windows', 'macos'], ['patch', 'major']).length);
    return html`<div class="card card-pad deploy-empty">
      <${Icon} name=${behind ? 'up' : 'check'} />
      <div><b>${behind ? 'Pick one or more apps above' : 'Everything is up to date'}</b>
      <p class="muted" style="margin:2px 0 0">${behind ? 'Then choose the machines and start the rollout. New versions test on 3 machines before the rest.' : 'Every tracked app is on its latest version across the farm.'}</p></div>
    </div>`;
  }

  const patchIds = new Set();
  const majorIds = new Set();
  const busyIds = new Set();
  for (const p of sel) {
    nodesByKind(s, p, oses, ['patch']).forEach((n) => patchIds.add(n.id));
    nodesByKind(s, p, oses, ['major', 'missing']).forEach((n) => majorIds.add(n.id));
    inProgressNodes(s, p, oses).forEach((n) => busyIds.add(n.id));
  }
  const deployable = sel.some((p) => ADOBE_RUM[p.key] || oses.every((os) => latestInstallerReady(p, os)));
  const trackOnly = sel.filter((p) => !isDeployable(p));
  const needInstaller = sel.filter((p) => !ADOBE_RUM[p.key] && isDeployable(p) && (nodesByKind(s, p, oses, ['patch', 'major']).length) && !oses.every((os) => latestInstallerReady(p, os)));
  const outdatedTargets = new Set([...patchIds, ...(includeMajor.value ? majorIds : [])]);
  const targetIds = targetMode.value === 'choose' ? chosenNodes.value : outdatedTargets;
  const targets = s.nodes.filter((n) => targetIds.has(n.id));
  const unelevated = targets.filter((n) => n.elevated === 0);
  const canGo = !busy.value && deployable && targets.length > 0;

  const sourceNote = () => {
    if (mode === 'auto') {
      return html`<div class="src-grid">${sel.map((p) => html`<div key=${p.key} class="src-tile"><${ProductLogo} product=${p} size=${16} /><b>${p.name}</b>
        ${oses.filter((os) => appliesToOS(p, os)).map((os) => {
          const rum = ADOBE_RUM[p.key];
          if (rum) return html`<${Badge} tone=${rum[os] ? 'ok' : 'warn'}>${os}: ${rum[os] ? 'Adobe RUM' : 'no Mac package'}<//>`;
          const staged = stagedFor(p, os);
          if (staged && latestInstallerReady(p, os)) return html`<${Badge} tone="ok" title=${staged}>${os}: ready<//>`;
          if (staged) return html`<${Badge} tone="warn" title=${staged}>${os}: staged is older<//>`;
          if (savedSource(p, os)) return html`<${Badge} tone="info" title=${savedSource(p, os)}>${os}: downloads once<//>`;
          return html`<${Badge} tone="warn">${os}: no installer<//>`;
        })}</div>`)}</div>`;
    }
    if (sel.length > 1 && mode !== 'staged') return html`<div class="banner warn"><${Icon} name="alert" />Several apps are selected — use Automatic or Server installer, or pick a single app.</div>`;
    if (mode === 'staged') return html`<p class="dim" style="margin:0">Uses the installer already on the server: ${sel.map((p) => oses.filter((os) => appliesToOS(p, os)).map((os) => stagedFor(p, os) ? `${p.name} (${os}): ${stagedFor(p, os)}` : `${p.name} (${os}): not on server`).join(' · ')).join(' · ')}</p>`;
    if (mode === 'saved') return html`<p class="dim" style="margin:0">Saved links — ${oses.map((os) => `${os}: ${savedSource(sel[0], os) ? shortUrl(savedSource(sel[0], os)) : 'none saved'}`).join(' · ')}</p>`;
    if (mode === 'url') return html`<p class="dim" style="margin:0">Paste a direct download link (vendor pages usually need a signed-in or share link). The server downloads it once and every machine installs from the server.</p>`;
    return html`<p class="dim" style="margin:0">Pick an installer from the server's installer folders${both ? ' — one per OS' : ''}.</p>`;
  };

  async function run() {
    progress.value = null;
    if (targetMode.value === 'choose' && !chosenNodes.value.size) { progress.value = { text: 'Select at least one machine.', tone: 'bad' }; return; }
    busy.value = true;
    const skipped = [];
    const queued = [];
    const queue = async (pkgId, os, major) => {
      if (targetMode.value === 'outdated') {
        const r = await post('/api/update-outdated', { package_id: pkgId, includeMajor: major });
        queued.push(...(r.queued || []));
      } else {
        const ids = [...chosenNodes.value].filter((id) => { const n = s.nodes.find((x) => x.id === id); return n && n.os === os; });
        if (ids.length) { const r = await post('/api/deployments', { package_id: pkgId, node_ids: ids }); queued.push(...(r.queued || [])); }
      }
    };
    const fetchToServer = async (url) => {
      const { dlId, filename } = await post('/api/download-url', { url });
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const r = await get('/api/downloads');
        const d = (r.downloads || r || []).find((x) => x.id === dlId);
        if (!d) throw new Error('download vanished');
        if (d.status === 'done') return d.filename || filename;
        if (d.status === 'error') throw new Error(d.error || 'download failed');
        progress.value = { text: `Downloading ${d.filename || filename}${d.total ? `: ${Math.round((d.received / d.total) * 100)}%` : '…'} (keep this page open)`, tone: '' };
      }
    };
    try {
      for (const p of sel.filter((x) => ADOBE_RUM[x.key])) {
        if (nodesByKind(s, p, oses, ['major']).length) skipped.push(`${p.name}: machines on an older major need a full install from the Admin Console (RUM only patches within a major)`);
        for (const os of oses) {
          const cfg = ADOBE_RUM[p.key][os];
          if (!cfg) { skipped.push(`${p.name} (${os}): no Adobe package for this OS`); continue; }
          const { id } = await post('/api/packages', { product_key: p.key, version: p.latest_version || 'latest', os, kind: 'installer', filename: cfg.filename, install_command: cfg.command });
          await queue(id, os, false);
        }
      }
      const others = sel.filter((x) => !ADOBE_RUM[x.key]);
      if (others.length > 1 && !['auto', 'staged'].includes(mode)) throw new Error('Use Automatic for several apps at once — links and files apply to a single app.');
      if (mode === 'auto' || mode === 'staged') {
        progress.value = { text: 'Queuing updates…', tone: '' };
        await Promise.all(others.flatMap((p) => oses.filter((os) => appliesToOS(p, os)).map(async (os) => {
          let filename = stagedFor(p, os);
          if (!filename && mode === 'auto' && savedSource(p, os)) {
            try { filename = await fetchToServer(savedSource(p, os)); } catch (e) { skipped.push(`${p.name} (${os}): download failed: ${e.message}`); return; }
          }
          if (!filename) { skipped.push(`${p.name} (${os}): ${mode === 'staged' ? 'not on the server' : 'no installer on the server and no saved link'}`); return; }
          const { id } = await post('/api/packages', { product_key: p.key, version: latestForOS(p, os) || (mode === 'staged' ? 'staged' : 'latest'), os, kind: 'installer', filename, install_command: presetCommand(p.key, os) });
          await queue(id, os, includeMajor.value);
        })));
      } else if (others.length === 1) {
        const p = others[0];
        const version = fields.version.trim() || p.latest_version;
        if (!version) throw new Error('Enter the new version number for this installer.');
        for (const os of oses.filter((o) => appliesToOS(p, o))) {
          let filename;
          let link = null;
          if (mode === 'file') {
            filename = os === 'macos' && both ? fields.fileMac : fields.file;
            if (!filename) throw new Error(`Pick the ${os} installer file.`);
          } else {
            link = mode === 'saved' ? savedSource(p, os) : (os === 'macos' && both ? fields.urlMac : fields.url).trim();
            if (!link) throw new Error(mode === 'saved' ? `No saved ${os} link yet — choose "Paste a link".` : `Paste the ${os} download link.`);
            filename = await fetchToServer(link);
          }
          const { id } = await post('/api/packages', { product_key: p.key, version, os, kind: 'installer', filename, install_command: presetCommand(p.key, os) });
          if (link && mode === 'url' && fields.remember) await put(`/api/products/${p.key}`, { [os === 'windows' ? 'source_url_win' : 'source_url_mac']: link });
          await queue(id, os, includeMajor.value);
        }
        setFields({ ...fields, version: '' });
      }
      const uniq = [...new Set(queued)];
      progress.value = { text: uniq.length ? `Queued on ${plural(uniq.length, 'machine')} — each starts as soon as it's free (a new version tests on 3 machines first).` : 'Nothing queued — those machines are current, offline, or already queued.', tone: uniq.length ? 'ok' : '', skipped };
      if (uniq.length) { toast(`Update queued on ${plural(uniq.length, 'machine')}.`, 'success'); if (onDone && !skipped.length) setTimeout(() => onDone(true), 400); }
    } catch (e) {
      progress.value = { text: e.message, tone: 'bad', skipped };
    } finally {
      busy.value = false;
      refresh();
    }
  }

  const shownNodes = s.nodes.filter((n) => oses.includes(n.os) && n.hostname.toLowerCase().includes(nodeSearch.value.toLowerCase()))
    .sort((a, b) => a.hostname.localeCompare(b.hostname, undefined, { numeric: true }));
  const needCount = (n) => sel.reduce((c, p) => c + (nodesByKind(s, p, [n.os], ['patch', 'major', 'missing']).some((x) => x.id === n.id) ? 1 : 0), 0);

  return html`<div class="card deploy">
    <div class="deploy-grid">
      <div class="deploy-field"><span class="label">Platform</span>
        <div class="seg">${[['both', 'All'], ['windows', 'Windows'], ['macos', 'Mac']].map(([k, l]) => html`<button key=${k} class=${osSel.value === k ? 'on' : ''} onClick=${() => { osSel.value = k; }}>${l}</button>`)}</div></div>
      <div class="deploy-field"><span class="label">Machines</span>
        <div class="seg">${[['outdated', 'Outdated only'], ['choose', 'Pick machines']].map(([k, l]) => html`<button key=${k} class=${targetMode.value === k ? 'on' : ''} onClick=${() => { targetMode.value = k; }}>${l}</button>`)}</div></div>
      <div class="deploy-field"><span class="label">Installer</span>
        <select class="field" value=${mode} onChange=${(e) => { source.value = e.currentTarget.value; }}>
          <option value="auto">Automatic (recommended)</option><option value="staged">Server installer only</option>
          <option value="saved">Saved download link</option><option value="url">Paste a link</option><option value="file">Pick a server file</option>
        </select></div>
    </div>

    ${mode === 'url' && html`<div class="row"><input class="field grow" placeholder=${both ? 'Windows installer link' : 'https://…'} value=${fields.url} onInput=${set('url')} />
      ${both && html`<input class="field grow" placeholder="macOS installer link" value=${fields.urlMac} onInput=${set('urlMac')} />`}
      <label class="check"><input type="checkbox" checked=${fields.remember} onChange=${set('remember')} />remember</label></div>`}
    ${mode === 'file' && html`<div class="row">
      <select class="field grow" value=${fields.file} onChange=${set('file')}><option value="">${both ? 'Windows file…' : 'Installer file…'}</option>${files.map((f) => html`<option value=${f.name}>${f.name} · ${Math.round(f.size / 1048576)} MB</option>`)}</select>
      ${both && html`<select class="field grow" value=${fields.fileMac} onChange=${set('fileMac')}><option value="">macOS file…</option>${files.map((f) => html`<option value=${f.name}>${f.name} · ${Math.round(f.size / 1048576)} MB</option>`)}</select>`}
    </div>`}
    ${['saved', 'url', 'file'].includes(mode) && sel.length === 1 && html`<input class="field" style="width:220px" placeholder=${sel[0].latest_version ? `Version (default ${sel[0].latest_version})` : 'Version, e.g. 2026.3.0'} value=${fields.version} onInput=${set('version')} />`}
    ${sourceNote()}

    ${targetMode.value === 'choose' && html`<div class="stack" style="gap:8px">
      <div class="row"><label class="search"><${Icon} name="search" /><input class="field" placeholder="Filter machines" value=${nodeSearch.value} onInput=${(e) => { nodeSearch.value = e.currentTarget.value; }} /></label>
        <button class="btn sm" onClick=${() => { const ids = shownNodes.map((n) => n.id); const all = ids.every((id) => chosenNodes.value.has(id)); chosenNodes.value = all ? new Set([...chosenNodes.value].filter((id) => !ids.includes(id))) : new Set([...chosenNodes.value, ...ids]); }}>Select all shown</button></div>
      <div class="node-chips">${shownNodes.map((n) => {
        const on = chosenNodes.value.has(n.id);
        const need = needCount(n);
        return html`<button key=${n.id} class=${'node-chip' + (on ? ' on' : '') + (n.online ? '' : ' off')} onClick=${() => { const next = new Set(chosenNodes.value); if (on) next.delete(n.id); else next.add(n.id); chosenNodes.value = next; }}>
          <${OsStatus} node=${n} /><span>${n.hostname}</span>${n.elevated === 0 ? html`<${Icon} name="shieldOff" title="needs elevation" />` : null}
          <span class="dim" style="font-size:.74rem">${need ? `${need} to update` : 'current'}</span></button>`;
      })}</div>
    </div>`}

    ${targetMode.value === 'outdated' && majorIds.size > 0 && html`<label class="check"><input type="checkbox" checked=${includeMajor.value} onChange=${(e) => { includeMajor.value = e.currentTarget.checked; }} />
      Also install ${plural(majorIds.size, 'new-major / fresh install')} — side-by-side, the current version stays in place</label>`}
    ${targetMode.value === 'outdated' && targets.length > 0 && html`<div class="row" style="gap:5px"><span class="dim" style="font-size:.8rem">Will update:</span>
      ${targets.slice(0, 16).map((n) => html`<${Badge} key=${n.id}>${n.hostname}<//>`)}${targets.length > 16 ? html`<span class="dim">+${targets.length - 16} more</span>` : ''}</div>`}
    ${unelevated.length > 0 && html`<div class="banner warn"><${Icon} name="shieldOff" />${plural(unelevated.length, 'machine')} not ready (${unelevated.map((n) => n.hostname).join(', ')}) — installs there wait at a permission prompt.</div>`}
    ${needInstaller.length > 0 && html`<div class="banner warn"><${Icon} name="alert" />Installer not on the server for ${needInstaller.map((p) => `${p.name} ${p.latest_version || ''}`).join(', ')} — add it (Automatic downloads from a saved link), or paste a link.</div>`}
    ${trackOnly.length > 0 && html`<div class="banner info"><${Icon} name="package" />${trackOnly.map((p) => p.name).join(', ')} ${trackOnly.length === 1 ? 'is' : 'are'} tracking-only — add an install command in Catalog to deploy.</div>`}

    <div class="deploy-go">
      <span class="muted">${targetMode.value === 'choose' ? `${chosenNodes.value.size} selected` : `${plural(targets.length, 'machine')} will update${busyIds.size ? ` · ${busyIds.size} already updating` : ''}`}</span>
      <span class="grow"></span>
      ${progress.value && html`<span class=${'deploy-progress ' + (progress.value.tone || '')}>${progress.value.text}${progress.value.skipped && progress.value.skipped.length ? html`<br /><span style="color:var(--warn)">Skipped: ${progress.value.skipped.join(' · ')}</span>` : ''}</span>`}
      <button class="btn primary" disabled=${!canGo} onClick=${run}
        title=${!deployable ? 'Stage the installer first — see the warning above' : !targets.length ? 'Those machines are already up to date or updating' : ''}>
        ${busy.value ? html`<${Icon} name="spinner" cls="spin" />Working…` : html`<${Icon} name="download" />Update now`}
      </button>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- jobs
function JobStatus({ j, s }) {
  if (ACTIVE.includes(j.status) && j.cancel_requested_at) return html`<${Badge} tone="warn" icon="spinner" title=${`Stop sent — waiting for ${j.hostname} to confirm`}>stopping…<//>`;
  if (j.status === 'downloading') return html`<span class="row" style="flex-wrap:nowrap;gap:8px"><${Bar} pct=${j.dl_pct} indet=${j.dl_pct == null} /><span class="mono dim">${j.dl_pct != null ? j.dl_pct + '%' : 'downloading'}</span></span>`;
  if (j.status === 'installing' && j.stalled) return html`<${Badge} tone="warn" icon="alert" title="No progress for much longer than usual — Stop, then Retry">stalled<//>`;
  if (j.status === 'installing' && j.inst_overrun) return html`<span class="row" style="flex-wrap:nowrap;gap:8px" title="Taking longer than usual — still running"><${Bar} indet /><span class="dim">finishing…</span></span>`;
  if (j.status === 'installing') return html`<span class="row" style="flex-wrap:nowrap;gap:8px" title="Estimated from typical install time"><${Bar} pct=${j.inst_pct} indet=${j.inst_pct == null} /><span class="mono dim">${j.inst_pct != null ? j.inst_pct + '%' : 'installing'}</span></span>`;
  if (j.status === 'pending') {
    const node = s.nodes.find((n) => n.hostname === j.hostname);
    if (node && !node.online) return html`<${Badge} tone="warn" icon="power" title="Runs when the machine is back online">machine offline<//>`;
    if (node && node.elevated === 0) return html`<${Badge} tone="warn" icon="shieldOff">needs elevation<//>`;
    if (/deferr|rendering/i.test(j.log || '')) return html`<${Badge} tone="violet" icon="film" title=${j.log}>waiting — rendering<//>`;
    const busyHere = s.jobs.some((o) => o.id !== j.id && o.hostname === j.hostname && ['downloading', 'installing'].includes(o.status));
    if (busyHere) return html`<${Badge} tone="info" icon="clock" title="One update at a time per machine">after current job<//>`;
    const same = s.jobs.filter((o) => o.product_key === j.product_key && o.package_version === j.package_version);
    if (!same.some((o) => o.status === 'success') && same.filter((o) => ['downloading', 'installing'].includes(o.status)).length >= 3) {
      return html`<${Badge} tone="info" icon="clock" title="A new version runs on 3 machines first; once one succeeds, everyone starts">testing on 3 first<//>`;
    }
    return html`<${Badge} tone="info" icon="clock" title="Starts on the machine's next check-in">queued<//>`;
  }
  if (j.status === 'success') return html`<${Badge} tone="ok" icon="check" title=${/^Verified on check-in:/.test(j.log || '') ? 'The installer returned an error code, but the machine reports the new version' : ''}>success<//>`;
  if (j.status === 'failed') return html`<${Badge} tone="bad" icon="alert">${/REBOOT NEEDED/.test(j.log || '') ? 'failed · reboot needed' : 'failed'}<//>`;
  return html`<${Badge}>stopped<//>`;
}

function JobTime({ j, now }) {
  if (['downloading', 'installing'].includes(j.status)) return html`<span class="mono">${elapsed(now - (j.started_at || j.updated_at))}</span>`;
  if (['success', 'failed', 'cancelled'].includes(j.status)) {
    const d = j.started_at ? j.updated_at - j.started_at : j.install_ms;
    return d > 0 ? html`<span class="mono dim">${elapsed(d)}</span>` : html`<span class="dim">—</span>`;
  }
  return html`<span class="dim">—</span>`;
}

function useTick(ms) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

function Jobs({ s, products }) {
  const now = useTick(1000);
  const names = new Map(products.map((p) => [p.key, p]));
  const bucket = (st) => (ACTIVE.includes(st) ? 'active' : st === 'success' ? 'done' : 'failed');
  const counts = { active: 0, queued: 0, done: 0, failed: 0 };
  for (const j of s.jobs) {
    if (j.status === 'pending') counts.queued++;
    counts[bucket(j.status)]++;
  }
  const q = jobSearch.value.toLowerCase();
  const rows = s.jobs
    .filter((j) => jobStatus.value === 'all' || bucket(j.status) === jobStatus.value)
    .filter((j) => !jobProduct.value || j.product_key === jobProduct.value)
    .filter((j) => !q || j.hostname.toLowerCase().includes(q))
    .sort((a, b) => b.updated_at - a.updated_at);
  const toggleLog = (id) => { const next = new Set(openLogs.value); if (next.has(id)) next.delete(id); else next.add(id); openLogs.value = next; };
  return html`<section class="card">
    <div class="card-head">
      <h2>Jobs</h2>
      <span class="dim" style="font-size:.84rem">${counts.active - counts.queued} running · ${counts.queued} queued · ${counts.done} done · ${counts.failed} failed/stopped</span>
      <span class="grow"></span>
      ${counts.done + counts.failed > 0 && html`<button class="btn sm ghost" onClick=${() => act.clearFinished(counts.done + counts.failed)}><${Icon} name="trash" />Clear finished</button>`}
      ${counts.active > 0 && html`<button class="btn sm danger" onClick=${() => act.stopAll(counts.active)}><${Icon} name="stop" />Stop all</button>`}
    </div>
    <div class="toolbar" style="padding:10px 16px 0">
      <div class="seg">${[['all', 'All'], ['active', 'Active'], ['done', 'Done'], ['failed', 'Failed']].map(([k, l]) => html`<button key=${k} class=${jobStatus.value === k ? 'on' : ''} onClick=${() => { jobStatus.value = k; }}>${l}${k !== 'all' ? html` <span class="dim">${counts[k]}</span>` : ''}</button>`)}</div>
      <select class="field" value=${jobProduct.value} onChange=${(e) => { jobProduct.value = e.currentTarget.value; }}><option value="">All apps</option>${products.map((p) => html`<option value=${p.key}>${p.name}</option>`)}</select>
      <label class="search"><${Icon} name="search" /><input class="field" placeholder="Filter machines" value=${jobSearch.value} onInput=${(e) => { jobSearch.value = e.currentTarget.value; }} /></label>
    </div>
    ${!rows.length ? html`<${Empty}>${s.jobs.length ? 'No jobs match these filters.' : 'No update jobs yet.'}<//>` : html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Machine</th><th>App</th><th>Status</th><th>Time</th><th class="right">Updated</th><th></th></tr></thead>
      <tbody>${rows.slice(0, 150).map((j) => {
        const p = names.get(j.product_key) || { key: j.product_key, name: j.product_key };
        const node = s.nodes.find((n) => n.hostname === j.hostname);
        const active = ACTIVE.includes(j.status);
        return html`<tr key=${j.id}>
          <td class="nowrap"><span class="row" style="flex-wrap:nowrap;gap:9px">${node ? html`<${OsStatus} node=${node} />` : null}<button class="linkish" style="color:var(--text)" onClick=${() => go('machines', j.hostname)}>${j.hostname}</button></span></td>
          <td class="nowrap"><span class="row" style="flex-wrap:nowrap"><${ProductLogo} product=${p} size=${18} />${p.name} <span class="mono dim">${j.package_version}</span></span></td>
          <td><${JobStatus} j=${j} s=${s} /></td>
          <td><${JobTime} j=${j} now=${now} /></td>
          <td class="right dim nowrap">${ago(j.updated_at, now)}</td>
          <td class="right nowrap">
            ${active && !j.cancel_requested_at ? html`<button class="btn sm ghost" onClick=${() => act.stopJob(j)}><${Icon} name="stop" />Stop</button>` : null}
            ${['failed', 'cancelled'].includes(j.status) ? html`<button class="btn sm ghost" onClick=${() => act.retryJob(j)}><${Icon} name="refresh" />Retry</button>` : null}
            ${j.log ? html`<button class="btn sm ghost" aria-expanded=${openLogs.value.has(j.id)} onClick=${() => toggleLog(j.id)}>Log</button>` : null}
          </td>
        </tr>
        ${openLogs.value.has(j.id) && html`<tr key=${'log' + j.id}><td colspan="6"><pre class="log">${j.log}</pre></td></tr>`}`;
      })}</tbody>
    </table>${rows.length > 150 ? html`<p class="dim" style="padding:0 16px 12px">+${rows.length - 150} older — narrow with the filters.</p>` : ''}</div>`}
  </section>`;
}

// ---------------------------------------------------------------- rollout sheet
function DeploySheet({ close }) {
  const s = farm.value;
  const products = normalizeProducts(s);
  const tracked = products.filter(isTracked).filter(isDeployable);
  return html`<div class="stack" style="gap:14px">
    <div>
      <p class="section-title">Apps</p>
      <div class="row" style="gap:6px">${tracked.map((p) => {
        const on = chosenProducts.value.has(p.key);
        return html`<button key=${p.key} class=${'pill' + (on ? ' on' : '')} onClick=${() => { const next = new Set(chosenProducts.value); if (on) next.delete(p.key); else next.add(p.key); chosenProducts.value = next; source.value = 'auto'; }}>
          <${ProductLogo} product=${p} size=${16} />${p.name}</button>`;
      })}</div>
    </div>
    <${DeployPanel} s=${s} products=${products} onDone=${close} />
  </div>`;
}

export function openRollout({ productKey, mode = 'outdated', major = false } = {}) {
  if (productKey) chosenProducts.value = new Set([productKey]);
  targetMode.value = mode;
  includeMajor.value = major;
  source.value = 'auto';
  progress.value = null;
  const p = productKey && farm.value.products.find((x) => x.key === productKey);
  openSheet((close) => html`<${DeploySheet} close=${close} />`, {
    title: p ? `Update ${p.name}` : 'Roll out updates',
    subtitle: 'Every idle machine starts right away · a new version tests on 3 machines first · never under a render',
    width: 640,
  });
}

function UpdateCard({ p, s }) {
  const oses = ['windows', 'macos'];
  const applicable = s.nodes.filter((n) => appliesToOS(p, n.os) && (productStatus(n, p).status !== 'na'));
  const installed = applicable.filter((n) => (n.software || []).some((x) => x.product_key === p.key));
  const current = installed.filter((n) => ['uptodate', 'selfupdate'].includes(productStatus(n, p).status));
  const patch = nodesByKind(s, p, oses, ['patch']);
  const major = nodesByKind(s, p, oses, ['major', 'missing']);
  const busyN = inProgressNodes(s, p, oses);
  const ready = oses.every((os) => latestInstallerReady(p, os));
  const pct = installed.length ? Math.round((current.length / installed.length) * 100) : 100;
  const deployable = isDeployable(p);
  return html`<article class="card ucard hover-lift">
    <header class="row" style="flex-wrap:nowrap;gap:12px">
      <${ProductLogo} product=${p} size=${36} />
      <div class="grow" style="min-width:0"><b class="uc-name">${p.name}</b><span class="mono dim uc-ver">${p.latest_win && p.latest_mac && p.latest_win !== p.latest_mac ? `Win ${p.latest_win} · Mac ${p.latest_mac}` : `Latest ${p.latest_version || '—'}`}</span></div>
      <${Ring} size=${58} stroke=${6} total=${Math.max(1, installed.length)} label=${`${current.length} of ${installed.length} current`}
        segments=${[{ value: current.length, color: 'var(--ok)' }, { value: busyN.length, color: 'var(--accent)' }]}>
        <span class="uc-pct">${pct}<small>%</small></span>
      <//>
    </header>
    <div class="uc-stats">
      <span><b><${Num} value=${current.length} /></b> current</span>
      <span style="color:var(--info)"><b><${Num} value=${patch.length} /></b> behind</span>
      ${busyN.length ? html`<span style="color:var(--accent)"><b>${busyN.length}</b> updating</span>` : null}
      ${major.length ? html`<span style="color:var(--violet)"><b>${major.length}</b> new major</span>` : null}
    </div>
    ${!deployable ? html`<${Badge} title="Add an install command in Catalog to deploy">Tracking only<//>`
      : !ready && (patch.length || major.length) ? html`<div class="uc-warn"><${Icon} name="alert" />Installer not on the server yet${p.source_url_win || p.source_url_mac ? ' — Automatic will download it once' : ''}</div>`
      : html`<div class="uc-ok"><${Icon} name="check" />Installer ready${ADOBE_RUM[p.key] ? ' (Adobe RUM)' : ''}</div>`}
    <footer class="row" style="gap:8px">
      <button class="btn primary grow" disabled=${!deployable || !patch.length} onClick=${() => openRollout({ productKey: p.key })}>
        <${Icon} name="download" />${patch.length ? `Update ${plural(patch.length, 'machine')}` : busyN.length ? 'Updating…' : 'All current'}</button>
      <button class="btn icon" title="Choose machines & options" aria-label=${`Choose machines for ${p.name}`} disabled=${!deployable} onClick=${() => openRollout({ productKey: p.key, mode: 'choose' })}><${Icon} name="sliders" /></button>
    </footer>
  </article>`;
}

function RolloutsPanel({ s, products }) {
  const names = new Map(products.map((p) => [p.key, p]));
  const groups = new Map();
  for (const j of s.jobs) {
    const k = `${j.product_key}|${j.package_version}`;
    if (!groups.has(k)) groups.set(k, { key: j.product_key, version: j.package_version, jobs: [] });
    groups.get(k).jobs.push(j);
  }
  const live = [...groups.values()].filter((g) => g.jobs.some((j) => ACTIVE.includes(j.status)));
  if (!live.length) return null;
  return html`<section class="card card-pad">
    <h2 class="card-title"><${Icon} name="activity" />Rolling out now</h2>
    <div class="rollout-grid">${live.map((g) => {
      const c = (st) => g.jobs.filter((j) => st.includes(j.status)).length;
      const done = c(['success']); const running = c(['downloading', 'installing']); const queued = c(['pending']); const failed = c(['failed', 'cancelled']);
      const p = names.get(g.key) || { key: g.key, name: g.key };
      return html`<div key=${g.key + g.version} class="rollout">
        <div class="row" style="flex-wrap:nowrap"><${ProductLogo} product=${p} size=${22} /><b class="grow">${p.name} <span class="mono dim">${g.version}</span></b><span class="mono">${done}/${g.jobs.length}</span></div>
        <${StackBar} height=${8} total=${g.jobs.length} parts=${[{ value: done, color: 'var(--ok)', label: 'done' }, { value: running, color: 'var(--accent)', label: 'installing' }, { value: queued, color: 'var(--info)', label: 'queued' }, { value: failed, color: 'var(--bad)', label: 'failed/stopped' }]} />
        <div class="legend" style="font-size:.76rem">${running ? html`<span><i style="background:var(--accent)"></i>${running} installing</span>` : null}${queued ? html`<span><i style="background:var(--info)"></i>${queued} queued</span>` : null}${failed ? html`<span><i style="background:var(--bad)"></i>${failed} failed</span>` : null}${done ? html`<span><i style="background:var(--ok)"></i>${done} done</span>` : null}</div>
      </div>`;
    })}</div>
  </section>`;
}

// ---------------------------------------------------------------- page
export function UpdatesView() {
  const s = farm.value;
  const products = useMemo(() => (s ? normalizeProducts(s) : []), [s]);
  useDownloads(!!s);
  if (!s) return null;
  const tracked = products.filter(isTracked);
  const need = (p) => nodesByKind(s, p, ['windows', 'macos'], ['patch']).length + nodesByKind(s, p, ['windows', 'macos'], ['major', 'missing']).length + inProgressNodes(s, p, ['windows', 'macos']).length;
  const available = tracked.filter((p) => need(p) > 0).sort((a, b) => need(b) - need(a));
  const current = tracked.filter((p) => need(p) === 0);
  const behindTotal = tracked.reduce((c, p) => c + nodesByKind(s, p, ['windows', 'macos'], ['patch']).length, 0);
  const running = s.jobs.filter((j) => ACTIVE.includes(j.status)).length;
  return html`<div class="page stack">
    <${PageHeader} title="Updates" subtitle=${`${behindTotal ? `${plural(behindTotal, 'update')} ready to roll out` : 'Every machine is current'}${running ? ` · ${running} running or queued` : ''}`}>
      <button class="btn" onClick=${act.checkVersions}><${Icon} name="refresh" />Check versions</button>
      <button class="btn primary" onClick=${() => openRollout({})}><${Icon} name="download" />Roll out…</button>
    </${PageHeader}>

    <${RolloutsPanel} s=${s} products=${products} />

    ${available.length ? html`<section>
      <h2 class="section-h">Available</h2>
      <div class="ugrid">${available.map((p) => html`<${UpdateCard} key=${p.key} p=${p} s=${s} />`)}</div>
    </section>` : html`<section class="card"><div class="empty-inline"><${Icon} name="check" /><div><b>Everything is up to date</b><p class="muted">New versions are checked automatically — or check now.</p></div></div></section>`}

    ${current.length ? html`<section>
      <h2 class="section-h">Up to date</h2>
      <div class="row" style="gap:8px">${current.map((p) => html`<span key=${p.key} class="current-chip" title=${p.latest_version || ''}><${ProductLogo} product=${p} size=${18} />${p.name}<span class="mono dim">${p.latest_version || ''}</span><${Icon} name="check" /></span>`)}</div>
    </section>` : null}

    <${Jobs} s=${s} products=${products} />
  </div>`;
}
