// Catalog: every tracked app, plug-in and script — tracking and auto-deploy switches, version
// checks, and adding your own (with auto-fill from a link).
import { html } from '../lib/html.js';
import { useState } from 'preact/hooks';
import { signal } from '@preact/signals-core';
import { farm, refresh } from '../lib/store.js';
import { post, put, del } from '../lib/api.js';
import { pref, toast, confirm, openSheet, openMenu } from '../lib/ui.js';
import { ago, plural } from '../lib/format.js';
import { normalizeProducts, SELF_MANAGED, productStatus, appliesToOS, nodesByKind, sourceProblem } from '../lib/domain.js';
import { canUpdate, updateTargets } from '../lib/updater.js';
import * as act from '../lib/actions.js';
import { go } from '../lib/router.js';
import { Icon, ProductLogo, Badge, Empty, ViewToggle } from '../components/common.js';
import { PageHeader } from '../components/page.js';
import { StackBar } from '../components/viz.js';
import { openUpdate } from '../components/update-sheet.js';
import { openRollout } from './deploy.js';
import { InstallerLibrary } from './installers.js';

const tab = pref('catalog.tab', 'catalog');
const search = signal('');
const SECTIONS = [['app', 'Apps'], ['plugin', 'Plug-ins'], ['script', 'Scripts']];
const view = pref('apps.view', 'grid');
// Anything that isn't the installer library is the catalog (older builds stored 'app'/'plugin').
const onCatalog = () => tab.value !== 'installers';
const catOf = (p) => (p.category === 'plugin' || p.category === 'script' ? p.category : 'app');
const LABEL = { app: 'app', plugin: 'plug-in', script: 'script' };

function Switch({ on, onChange, label }) {
  return html`<button type="button" role="switch" aria-checked=${on} aria-label=${label} class=${'switch' + (on ? ' on' : '')} onClick=${() => onChange(!on)}><i></i></button>`;
}

// ---------------------------------------------------------------- add / edit form (port of customProductForm)
function ProductForm({ prod, cat, close }) {
  const v = (k) => (prod && prod[k] != null ? String(prod[k]) : '');
  const hasWin = prod && (prod.detect_path_win || prod.source_url_win || prod.install_cmd_win || prod.uninstall_cmd_win);
  const hasMac = prod && (prod.detect_path_mac || prod.source_url_mac || prod.install_cmd_mac || prod.uninstall_cmd_mac);
  const [f, setF] = useState({
    name: v('name'), url: '', os: hasWin && hasMac ? 'both' : hasMac ? 'mac' : 'win',
    method: prod ? (prod.detect_path_win || prod.detect_path_mac ? 'path' : 'name') : cat === 'app' ? 'name' : 'path',
    pat: v('detect_pattern'), pwin: v('detect_path_win'), pmac: v('detect_path_mac'), ver: v('latest_version'),
    autocheck: !!(prod && prod.check_url), curl: v('check_url'), cre: v('check_regex'),
    update: !!(prod && (prod.install_cmd_win || prod.install_cmd_mac || prod.source_url_win || prod.source_url_mac)),
    swin: v('source_url_win'), cwin: v('install_cmd_win'), smac: v('source_url_mac'), cmac: v('install_cmd_mac'),
    uninstall: !!(prod && (prod.uninstall_cmd_win || prod.uninstall_cmd_mac)), uwin: v('uninstall_cmd_win'), umac: v('uninstall_cmd_mac'),
    icon: v('icon_url'),
  });
  const [note, setNote] = useState(cat === 'script' ? 'A name and the script link are enough.' : 'A name and a link are enough — Auto-fill finds the icon, version and installer.');
  const [filling, setFilling] = useState(false);
  const [advanced, setAdvanced] = useState(!!prod);
  const set = (k) => (e) => setF({ ...f, [k]: e.currentTarget.type === 'checkbox' ? e.currentTarget.checked : e.currentTarget.value });
  const scriptish = cat === 'plugin' || cat === 'script';
  const os = scriptish ? 'both' : f.os;
  const win = os !== 'mac';
  const mac = os !== 'win';

  async function autofill() {
    if (!f.url.trim()) return;
    setFilling(true);
    try {
      const r = await post('/api/products/inspect', { url: f.url.trim() });
      const next = { ...f };
      const got = [];
      if (r.icon_url) { next.icon = r.icon_url; got.push('icon'); }
      if (r.name && !next.name.trim()) next.name = r.name;
      if (r.version) { next.ver = r.version; got.push(`version ${r.version}`); }
      if (r.check_url) { next.curl = r.check_url; next.autocheck = true; }
      if (r.source_url_win) { next.swin = r.source_url_win; next.update = true; if (next.os === 'mac') next.os = 'both'; got.push('Windows installer'); }
      if (r.source_url_mac) { next.smac = r.source_url_mac; next.update = true; if (next.os === 'win') next.os = 'both'; got.push('macOS installer'); }
      setF(next);
      setNote(`Got the ${got.join(' + ') || 'icon'} — ready to ${prod ? 'save' : 'add'}.${r.version_guess && !next.ver ? ` (The page mentions ${r.version_guess} — set it as the version if that's right.)` : ''}`);
      if (got.some((g) => /installer/.test(g))) setAdvanced(true);
    } catch { setNote('Couldn\'t auto-fill from that link — fill the options below.'); }
    setFilling(false);
  }

  function submit() {
    const name = f.name.trim();
    if (!name) return;
    const g = (k) => (f[k] || '').trim() || null;
    const upd = cat === 'script' ? true : f.update;
    const tok = name.split(/[^A-Za-z0-9]+/).filter(Boolean)[0] || name;
    const aePath = (o) => {
      if (cat === 'plugin') return o === 'win' ? `C:\\Program Files\\Adobe\\**\\${tok}*.aex` : `/Library/Application Support/Adobe/**/${tok}*.plugin`;
      if (cat === 'script') return o === 'win' ? `C:\\Program Files\\Adobe\\**\\Scripts\\**\\${tok}*.jsx*` : `/Applications/Adobe After Effects */Scripts/**/${tok}*.jsx*`;
      return null;
    };
    const scriptCmd = (o) => (o === 'win'
      ? 'for /d %i in ("C:\\Program Files\\Adobe\\Adobe After Effects *") do copy /Y "{file}" "%i\\Support Files\\Scripts\\ScriptUI Panels\\"'
      : 'for d in /Applications/Adobe\\ After\\ Effects\\ */Scripts/ScriptUI\\ Panels; do cp "{file}" "$d/"; done');
    close({
      name,
      category: cat,
      detect_pattern: f.method === 'name' && cat === 'app' ? g('pat') || name.toLowerCase() : null,
      detect_path_win: win ? g('pwin') || aePath('win') : null,
      detect_path_mac: mac ? g('pmac') || aePath('mac') : null,
      latest_version: g('ver'),
      check_url: f.autocheck ? g('curl') : null,
      check_regex: f.autocheck ? g('cre') : null,
      source_url_win: upd && win ? g('swin') || (cat === 'script' ? f.url.trim() || null : null) : null,
      install_cmd_win: upd && win ? g('cwin') || (cat === 'script' ? scriptCmd('win') : null) : null,
      source_url_mac: upd && mac ? g('smac') || (cat === 'script' ? f.url.trim() || null : null) : null,
      install_cmd_mac: upd && mac ? g('cmac') || (cat === 'script' ? scriptCmd('mac') : null) : null,
      uninstall_cmd_win: f.uninstall && win ? g('uwin') : null,
      uninstall_cmd_mac: f.uninstall && mac ? g('umac') : null,
      icon_url: g('icon'),
    });
  }

  return html`<div class="form">
    <div class="row" style="flex-wrap:nowrap">
      ${f.icon ? html`<img src=${f.icon} alt="" style="width:36px;height:36px;border-radius:8px" onError=${(e) => e.currentTarget.remove()} />` : html`<span class="form-icon"><${Icon} name="package" /></span>`}
      <label class="grow">Name<input class="field" autofocus value=${f.name} onInput=${set('name')} placeholder=${cat === 'plugin' ? 'Element 3D' : cat === 'script' ? 'Motion Tools' : '7-Zip'} /></label>
    </div>
    <label>${cat === 'script' ? 'Script link' : 'Link'}
      <span class="row" style="flex-wrap:nowrap"><input class="field grow" value=${f.url} onInput=${set('url')} placeholder=${cat === 'script' ? 'https://…/MyScript.jsxbin' : 'https://www.7-zip.org/  or a direct …/app.exe'} onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); autofill(); } }} />
      <button class="btn" disabled=${filling || !f.url.trim()} onClick=${autofill}>${filling ? html`<${Icon} name="spinner" cls="spin" />` : html`<${Icon} name="zap" />`}Auto-fill</button></span></label>
    <p class="dim" style="margin:0;font-size:.84rem">${note}</p>

    <button class="linkish" style="align-self:flex-start" onClick=${() => setAdvanced(!advanced)}><${Icon} name=${advanced ? 'chevronDown' : 'chevron'} />Options</button>
    ${advanced && html`<div class="form-adv">
      ${!scriptish && html`<div class="row">
        <label>Platforms<select class="field" value=${f.os} onChange=${set('os')}><option value="win">Windows</option><option value="mac">macOS</option><option value="both">Both</option></select></label>
        <label>Detect by<select class="field" value=${f.method} onChange=${set('method')}><option value="name">Installed app name</option><option value="path">File path (glob)</option></select></label>
      </div>`}
      ${f.method === 'name' && cat === 'app'
        ? html`<label>Name pattern<input class="field" value=${f.pat} onInput=${set('pat')} placeholder="defaults to the name, lower-case" /></label>`
        : html`<div class="row">${win && html`<label class="grow">Windows path<input class="field" value=${f.pwin} onInput=${set('pwin')} placeholder=${cat === 'app' ? 'C:\\Program Files\\App\\app.exe' : 'auto from the name'} /></label>`}
            ${mac && html`<label class="grow">macOS path<input class="field" value=${f.pmac} onInput=${set('pmac')} placeholder=${cat === 'app' ? '/Applications/App.app' : 'auto from the name'} /></label>`}</div>`}
      <label>Latest version<input class="field" value=${f.ver} onInput=${set('ver')} placeholder="e.g. 24.08" style="width:200px" /></label>
      <label class="check"><input type="checkbox" checked=${f.autocheck} onChange=${set('autocheck')} />Check the latest version from a web page</label>
      ${f.autocheck && html`<div class="row"><input class="field grow" value=${f.curl} onInput=${set('curl')} placeholder="Page URL" /><input class="field grow" value=${f.cre} onInput=${set('cre')} placeholder="Regex with a version group (blank = highest number)" /></div>`}
      ${cat !== 'script' && html`<label class="check"><input type="checkbox" checked=${f.update} onChange=${set('update')} />Install and update across the farm</label>`}
      ${(f.update || cat === 'script') && html`<div class="stack" style="gap:6px">
        ${win && html`<div class="row"><input class="field grow" value=${f.swin} onInput=${set('swin')} placeholder=${cat === 'script' ? 'Windows installer link (defaults to the script link)' : 'Windows installer link'} /><input class="field grow mono" value=${f.cwin} onInput=${set('cwin')} placeholder=${cat === 'script' ? 'auto: copies into AE ScriptUI Panels' : 'Silent install command, {file} = installer'} /></div>`}
        ${mac && html`<div class="row"><input class="field grow" value=${f.smac} onInput=${set('smac')} placeholder=${cat === 'script' ? 'macOS installer link (defaults to the script link)' : 'macOS installer link'} /><input class="field grow mono" value=${f.cmac} onInput=${set('cmac')} placeholder=${cat === 'script' ? 'auto: copies into AE ScriptUI Panels' : 'Silent install command, {file} = installer'} /></div>`}
      </div>`}
      <label class="check"><input type="checkbox" checked=${f.uninstall} onChange=${set('uninstall')} />Allow uninstalling from machines</label>
      ${f.uninstall && html`<div class="row">${win && html`<input class="field grow mono" value=${f.uwin} onInput=${set('uwin')} placeholder='"%ProgramFiles%\\7-Zip\\Uninstall.exe" /S' />`}${mac && html`<input class="field grow mono" value=${f.umac} onInput=${set('umac')} placeholder='rm -rf "/Applications/App.app"' />`}</div>`}
      <label>Icon URL<input class="field" value=${f.icon} onInput=${set('icon')} placeholder="https://…/favicon.png" /></label>
    </div>`}
    <footer class="sheet-foot">
      <button class="btn ghost" onClick=${() => close(null)}>Cancel</button>
      <button class="btn primary" disabled=${!f.name.trim()} onClick=${submit}>${prod ? 'Save' : `Add ${LABEL[cat]}`}</button>
    </footer>
  </div>`;
}

async function addProduct(cat) {
  const fields = await openSheet((close) => html`<${ProductForm} cat=${cat} close=${close} />`, { title: `Add ${LABEL[cat]}`, subtitle: 'A name and a link are usually enough — Auto-fill does the rest.', width: 620 });
  if (!fields) return;
  try {
    await post('/api/products', fields);
    toast(`Tracking “${fields.name}” — running a version check now…`, 'success', 6000);
    post('/api/check-maxon').catch(() => {});
  } catch (e) { toast(e.message, 'error'); }
  refresh();
}

async function editProduct(p) {
  const fields = await openSheet((close) => html`<${ProductForm} prod=${p} cat=${catOf(p)} close=${close} />`, { title: `Edit ${p.name}`, width: 620 });
  if (!fields) return;
  try { await put(`/api/products/${p.key}`, fields); toast('Saved.', 'success'); } catch (e) { toast(e.message, 'error'); }
  refresh();
}

async function deleteProduct(p) {
  if (!await confirm(`Stop tracking “${p.name}” and remove it from the tracker? The app stays installed on every machine.`, { title: `Delete ${LABEL[catOf(p)]}`, confirmLabel: 'Delete', danger: true })) return;
  try { await del(`/api/products/${p.key}`); toast(`${p.name} removed.`, 'success'); } catch (e) { toast(e.message, 'error', 8000); }
  refresh();
}

async function uninstallProduct(p, s) {
  const have = s.nodes.filter((n) => (n.software || []).some((x) => x.product_key === p.key));
  if (!have.length) return toast(`No machine currently has ${p.name}.`, 'info');
  const able = have.filter((n) => (n.os === 'windows' ? p.uninstall_cmd_win : p.uninstall_cmd_mac));
  if (!able.length) return toast(`Set an uninstall command first — Edit ${p.name} → Options.`, 'error', 6000);
  if (!await confirm(`Uninstall “${p.name}” from ${plural(able.length, 'machine')}: ${able.slice(0, 8).map((n) => n.hostname).join(', ')}${able.length > 8 ? '…' : ''}?`, { title: 'Uninstall', confirmLabel: 'Uninstall', danger: true })) return;
  try {
    const r = await post('/api/uninstall', { product_key: p.key, node_ids: able.map((n) => n.id) });
    toast(`Uninstall queued on ${plural((r.queued || []).length, 'machine')}.`, 'success');
  } catch (e) { toast(e.message, 'error'); }
  refresh();
}

const behindCount = (s, p) => (canUpdate(p) ? updateTargets(s, p).length : 0);

// The newest version the tracker knows about — per OS when Windows and Mac are numbered
// differently. "Not detected" used to be a dead end; now it says what to do about it, and
// for your own apps it opens the place where you say where to look.
function Latest({ p }) {
  const s = farm.value;
  const bad = s && sourceProblem(s, p.key);
  const warn = bad ? html`<span class="tag warn" style="margin-left:6px" title=${`${bad.label}: ${bad.error}${bad.ok_at ? ` — last worked ${ago(bad.ok_at, s.now)}` : ''}. New versions won't be noticed until this works again.`}><${Icon} name="alert" />source not answering</span>` : null;
  return html`<${LatestValue} p=${p} />${warn}`;
}
function LatestValue({ p }) {
  const split = p.latest_win && p.latest_mac && p.latest_win !== p.latest_mac;
  if (split) return html`Win ${p.latest_win} · Mac ${p.latest_mac}`;
  if (p.latest_version) return html`${p.latest_version}`;
  return p.custom
    ? html`<button class="linkish" title="Set where the tracker should look for this app's version" onClick=${() => editProduct(p)}>set a version source…</button>`
    : html`<button class="linkish" title="The tracker hasn't read a version for this app yet" onClick=${act.checkVersions}>check now…</button>`;
}

// Everything you can do TO an app, from the page where you're looking at it. This used to be a
// settings screen: you could see that Redshift was current on 5 of 29 machines and had to go
// somewhere else to act on it. Update / install where missing / a specific version / uninstall.
function appActions(p, s, e) {
  const behind = canUpdate(p) ? updateTargets(s, p) : [];
  const missing = canUpdate(p) ? nodesByKind(s, p, ['windows', 'macos'], ['missing']) : [];
  const custom = !!p.custom;
  openMenu(e.currentTarget, [
    { label: behind.length ? `Update ${plural(behind.length, 'machine')}…` : 'Nothing to update', icon: 'download', disabled: !behind.length,
      onSelect: () => openUpdate([{ product: p, nodes: behind }], { title: `Update ${p.name}` }) },
    { label: missing.length ? `Install where it's missing (${missing.length})…` : 'Installed everywhere it applies', icon: 'plus', disabled: !missing.length,
      onSelect: () => openUpdate([{ product: p, nodes: missing }], { title: `Install ${p.name}`, subtitle: `${plural(missing.length, 'machine')} without it` }) },
    { label: 'Install a specific version…', icon: 'package', onSelect: () => openRollout({ productKey: p.key, mode: 'choose' }) },
    '-',
    { label: 'Show machines with it', icon: 'server', onSelect: () => go('machines') },
    { label: 'Uninstall from machines…', icon: 'x', danger: true, onSelect: () => uninstallProduct(p, s) },
    ...(custom ? ['-',
      { label: `Edit ${p.name}`, icon: 'edit', onSelect: () => editProduct(p) },
      { label: 'Delete from the tracker', icon: 'trash', danger: true, onSelect: () => deleteProduct(p) },
    ] : []),
  ]);
}

export function CatalogView() {
  const s = farm.value;
  if (!s) return html`<div class="page"><${Empty}>Loading…<//></div>`;
  const all = normalizeProducts(s);
  const q = search.value.trim().toLowerCase();
  const products = q ? all.filter((p) => `${p.name} ${p.key}`.toLowerCase().includes(q)) : all;
  const count = (c) => products.filter((p) => catOf(p) === c).length;
  const sections = SECTIONS.map(([k, label]) => ({ k, label, rows: products.filter((p) => catOf(p) === k) }));
  const setTrack = async (p, shown) => {
    try { await put(`/api/products/${p.key}`, { dashboard_hidden: shown ? 0 : 1 }); toast(`${p.name} ${shown ? 'is tracked on the dashboard' : 'is no longer tracked'}.`, shown ? 'success' : 'info'); } catch (e) { toast(e.message, 'error'); }
    refresh();
  };
  const setAuto = async (p, on) => {
    try { await put(`/api/products/${p.key}`, { autodeploy: on ? 1 : 0 }); toast(on ? `Auto-deploy on for ${p.name} — installs where missing and updates where behind, testing on 3 machines first.` : `Auto-deploy off for ${p.name}.`, 'success', 6000); } catch (e) { toast(e.message, 'error'); }
    refresh();
  };
  const coverage = (p) => {
    const nodes = s.nodes.filter((n) => appliesToOS(p, n.os));
    const have = nodes.filter((n) => (n.software || []).some((x) => x.product_key === p.key));
    const current = have.filter((n) => ['uptodate', 'selfupdate'].includes(productStatus(n, p).status));
    return { have: have.length, current: current.length, total: nodes.length };
  };
  return html`<div class="page stack">
    <${PageHeader} title="Apps" subtitle="What the tracker keeps updated, where new versions come from, and the installers on the share.">
      ${onCatalog() ? html`<label class="search"><${Icon} name="search" />
        <input id="app-search" class="field" placeholder="Search apps   /" value=${search.value}
          onInput=${(e) => { search.value = e.currentTarget.value; }} style="width:200px" /></label>` : null}
      <button class="btn" onClick=${act.checkVersions}><${Icon} name="refresh" />Check for updates</button>
      ${onCatalog() ? html`<button class="btn primary" onClick=${(e) => openMenu(e.currentTarget, SECTIONS.map(([k, l]) => ({ label: `Add ${LABEL[k]}`, icon: 'plus', onSelect: () => addProduct(k) })))}><${Icon} name="plus" />Add…</button>` : null}
    </${PageHeader}>
    <div class="row">
      <div class="pills">${[['catalog', 'Tracked apps'], ['installers', 'Installers on the share']].map(([k, l]) => html`<button key=${k} class=${'pill' + ((k === 'installers' ? !onCatalog() : onCatalog()) ? ' on' : '')} onClick=${() => { tab.value = k; }}>${l}${k === 'catalog' ? html`<span class="n">${products.length}</span>` : null}</button>`)}</div>
      <span class="grow"></span>
      ${onCatalog() ? html`<${ViewToggle} value=${view.value} onChange=${(v) => { view.value = v; }} />` : null}
    </div>
    ${!onCatalog() ? html`<section class="card card-pad"><${InstallerLibrary} /></section>`
      : sections.filter((sec) => sec.rows.length).map((sec) => html`<section key=${sec.k} class="stack" style="gap:10px">
        <div class="row"><h2 class="section-h" style="margin:0">${sec.label}</h2><span class="dim">${sec.rows.length}</span><span class="grow"></span>
          <button class="btn ghost sm" onClick=${() => addProduct(sec.k)}><${Icon} name="plus" />Add ${LABEL[sec.k]}</button></div>
        ${view.value === 'list' ? html`<div class="card table-wrap"><table class="table">
          <thead><tr><th>${sec.label.replace(/s$/, '')}</th><th>Latest</th><th style="width:190px">On the farm</th><th>Track</th><th>Auto</th><th></th></tr></thead>
          <tbody>${sec.rows.map((p) => {
            const cv = coverage(p);
            const tracked = p.dashboard_hidden !== 1;
            return html`<tr key=${p.key} style=${tracked ? '' : 'opacity:.6'}>
              <td class="nowrap"><span class="row" style="flex-wrap:nowrap;gap:10px"><${ProductLogo} product=${p} size=${22} /><b>${p.name}</b></span></td>
              <td class="mono nowrap"><${Latest} p=${p} /></td>
              <td>${cv.have ? html`<div class="row" style="flex-wrap:nowrap;gap:9px"><${StackBar} height=${6} total=${cv.have} parts=${[{ value: cv.current, color: 'var(--ok)', label: 'current' }, { value: cv.have - cv.current, color: 'var(--info)', label: 'behind' }]} /><span class="mono nowrap" style="font-size:.78rem">${cv.current}/${cv.have}</span></div>` : html`<span class="dim">not installed</span>`}</td>
              <td><${Switch} on=${tracked} label=${`Track ${p.name}`} onChange=${(on) => setTrack(p, on)} /></td>
              <td>${SELF_MANAGED.has(p.key) ? html`<span class="dim" title="Updates itself">self</span>` : html`<${Switch} on=${!!p.autodeploy} label=${`Auto-deploy ${p.name}`} onChange=${(on) => setAuto(p, on)} />`}</td>
              <td class="right nowrap">
                ${behindCount(s, p) ? html`<button class="btn sm" onClick=${() => openUpdate([{ product: p, nodes: updateTargets(s, p) }], { title: `Update ${p.name}` })}><${Icon} name="download" />Update ${behindCount(s, p)}</button>` : null}
                <button class="btn sm ghost icon" title=${`More for ${p.name}`} aria-label=${`More for ${p.name}`} onClick=${(e) => appActions(p, s, e)}><${Icon} name="more" /></button>
              </td>
            </tr>`;
          })}</tbody></table></div>`
        : html`<div class="appgrid">${sec.rows.map((p) => {
          const cv = coverage(p);
          const tracked = p.dashboard_hidden !== 1;
          return html`<article key=${p.key} class=${'card acard' + (tracked ? '' : ' off')}>
            <header>
              <${ProductLogo} product=${p} size=${34} />
              <div class="ac-name"><b>${p.name}</b><span class="dim">${p.custom ? 'Custom' : 'Built in'}${p.check_url ? ' · checks a web page' : ''}</span></div>
              <button class="btn sm ghost icon" title=${`More for ${p.name}`} aria-label=${`More for ${p.name}`} onClick=${(e) => appActions(p, s, e)}><${Icon} name="more" /></button>
            </header>
            <div class="ac-ver">
              <span class="l">Latest</span>
              <span class="mono"><${Latest} p=${p} /></span>
              ${s.lastVersionCheck ? html`<span class="dim">checked ${ago(s.lastVersionCheck, s.now)}</span>` : null}
            </div>
            <div class="ac-cov">
              ${cv.have ? html`<${StackBar} height=${6} total=${cv.have} parts=${[{ value: cv.current, color: 'var(--ok)', label: 'current' }, { value: cv.have - cv.current, color: 'var(--info)', label: 'behind' }]} />
                <span class="dim">${cv.current} of ${cv.have} current · installed on ${cv.have}/${cv.total} machines</span>` : html`<span class="dim">Not installed on any machine yet</span>`}
            </div>
            <footer>
              <label class="ac-toggle"><${Switch} on=${tracked} label=${`Track ${p.name}`} onChange=${(on) => setTrack(p, on)} /><span>Track</span></label>
              ${SELF_MANAGED.has(p.key)
                ? html`<span class="dim" title="Updates itself or rides along with other installs">self-managed</span>`
                : html`<label class="ac-toggle"><${Switch} on=${!!p.autodeploy} label=${`Auto-deploy ${p.name}`} onChange=${(on) => setAuto(p, on)} /><span title="Install new versions everywhere automatically, testing on 3 machines first">Auto</span></label>`}
              <span class="grow"></span>
              ${behindCount(s, p) ? html`<button class="btn sm" onClick=${() => openUpdate([{ product: p, nodes: updateTargets(s, p) }], { title: `Update ${p.name}` })}><${Icon} name="download" />Update ${behindCount(s, p)}</button>` : null}
            </footer>
          </article>`;
        })}</div>`}
      </section>`)}
  </div>`;
}
