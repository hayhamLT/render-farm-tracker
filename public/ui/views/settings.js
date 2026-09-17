// Settings: where installers are downloaded, Slack alerts, the auto-deploy maintenance window,
// vendor-download concurrency, backups, and how to enroll a machine.
import { html } from '../lib/html.js';
import { useEffect, useState } from 'preact/hooks';
import { farm, refresh } from '../lib/store.js';
import { get, post } from '../lib/api.js';
import { toast, openDialog } from '../lib/ui.js';
import { ago } from '../lib/format.js';
import * as act from '../lib/actions.js';
import { Icon, Empty } from '../components/common.js';
import { PageHeader } from '../components/page.js';

// ---------------------------------------------------------------- folder picker
function FolderPicker({ start, close }) {
  const [cur, setCur] = useState(start || '');
  const [data, setData] = useState(null);
  const [places, setPlaces] = useState(null);
  const [err, setErr] = useState('');
  const [newName, setNewName] = useState(null);
  const load = async (p) => {
    setErr('');
    try { const r = await get(`/api/list-dirs?path=${encodeURIComponent(p || '')}`); setData(r); setCur(r.path); } catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(start); get('/api/places').then(setPlaces).catch(() => {}); }, []);
  const mkdir = async () => {
    const name = (newName || '').trim();
    if (!name) { setNewName(null); return; }
    const sep = cur.includes('\\') ? '\\' : '/';
    try { await post('/api/mkdir', { path: cur.replace(/[\\/]$/, '') + sep + name }); toast(`Folder created: ${name}`, 'success'); setNewName(null); load(cur); } catch (e) { toast(e.message, 'error'); }
  };
  return html`<div class="body picker">
    <aside>${places && ['favorites', 'locations'].map((k) => (places[k] || []).length ? html`<div key=${k}><p class="section-title">${k === 'favorites' ? 'Favorites' : 'Locations'}</p>
      ${(places[k] || []).map((pl) => html`<button key=${pl.path} class=${'place' + (cur === pl.path ? ' on' : '')} onClick=${() => load(pl.path)}><${Icon} name="folder" />${pl.name}</button>`)}</div>` : null)}</aside>
    <div class="picker-main">
      <div class="row" style="flex-wrap:nowrap"><span class="mono grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title=${cur}>${cur || '/'}</span>
        <button class="btn sm" onClick=${() => setNewName('')}><${Icon} name="plus" />New folder</button></div>
      ${err && html`<div class="banner bad"><${Icon} name="alert" />${err}</div>`}
      <ul class="dir-list">
        ${data && data.parent && html`<li><button onClick=${() => load(data.parent)}><${Icon} name="folder" />..</button></li>`}
        ${newName != null && html`<li><input class="field" autofocus placeholder="New folder name" value=${newName} onInput=${(e) => setNewName(e.currentTarget.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter') mkdir(); if (e.key === 'Escape') { e.stopPropagation(); setNewName(null); } }} onBlur=${() => { if (!newName) setNewName(null); }} /></li>`}
        ${data && data.dirs.map((d) => html`<li key=${d.name}><button onClick=${() => load(cur.replace(/[\\/]$/, '') + (cur.includes('\\') ? '\\' : '/') + d.name)}><${Icon} name="folder" />${d.name}</button></li>`)}
        ${data && data.files.slice(0, 40).map((f) => html`<li key=${'f' + f.name} class="file"><span><${Icon} name="file" />${f.name}</span><span class="dim">${Math.round((f.size || 0) / 1048576)} MB</span></li>`)}
      </ul>
      ${data && html`<p class=${data.writable ? 'dim' : ''} style=${`margin:0;font-size:.8rem;${data.writable ? '' : 'color:var(--warn)'}`}>${data.writable ? 'Writable' : 'Read-only — pick another folder'}</p>`}
    </div>
    <footer style="grid-column:1/-1;margin:0 -18px -16px">
      <button class="btn ghost" onClick=${() => close(null)}>Cancel</button>
      <button class="btn primary" disabled=${!data || !data.writable} onClick=${() => close(cur)}>Use this folder</button>
    </footer>
  </div>`;
}

function FolderSetting({ field, label, hint, value, fallback }) {
  const [v, setV] = useState(value || '');
  useEffect(() => { setV(value || ''); }, [value]);
  const save = async (dir) => {
    if (field === 'downloadDir' && !dir.trim()) return toast('The apps folder can\'t be empty.', 'error');
    try { await post('/api/settings', { [field]: dir.trim() }); toast(dir.trim() ? `${label} set.` : `${label} cleared (uses the apps folder).`, 'success'); } catch (e) { toast(e.message, 'error'); }
    refresh();
  };
  const browse = async () => {
    const dir = await openDialog((close) => html`<${FolderPicker} start=${v || fallback} close=${close} />`, { title: `Choose ${label.toLowerCase()}`, wide: true });
    if (dir) { setV(dir); save(dir); }
  };
  return html`<div class="setting">
    <div><b>${label}</b><p class="dim">${hint}</p></div>
    <div class="row" style="flex-wrap:nowrap">
      <input class="field grow mono" value=${v} placeholder=${fallback ? `Uses ${fallback}` : ''} onInput=${(e) => setV(e.currentTarget.value)} onKeyDown=${(e) => { if (e.key === 'Enter') save(v); }} />
      <button class="btn" onClick=${browse}><${Icon} name="folder" />Browse</button>
      <button class="btn" disabled=${v === (value || '')} onClick=${() => save(v)}>Save</button>
    </div>
    ${/dropbox/i.test(v) && html`<p class="dim" style="color:var(--warn);margin:4px 0 0">This folder is inside Dropbox — multi-GB installers would sync to the cloud.</p>`}
  </div>`;
}

function Commands() {
  const [setup, setSetup] = useState(null);
  useEffect(() => { get('/api/agent-setup').then(setSetup).catch(() => setSetup({})); }, []);
  const u = setup && setup.lanUrl;
  const rows = u ? [
    ['Windows — enroll', `irm ${u}/enroll.ps1 | iex`],
    ['Windows — elevate (admin, once)', `irm ${u}/elevate.ps1 | iex`],
    ['macOS — enroll', `curl -fsSL ${u}/enroll.sh | bash`],
    ['macOS — elevate (once)', `curl -fsSL ${u}/setup.sh | sudo bash`],
  ] : [];
  const copy = async (t) => { try { await navigator.clipboard.writeText(t); toast('Copied.', 'success', 2000); } catch { toast('Copy failed — select the text instead.', 'error'); } };
  if (!setup) return html`<p class="dim">Loading…</p>`;
  if (!u) return html`<p class="dim">Couldn't load the enrollment commands.</p>`;
  return html`<div class="stack" style="gap:8px">${rows.map(([l, c]) => html`<div key=${l} class="cmd"><span class="dim">${l}</span><code>${c}</code><button class="btn sm ghost icon" aria-label=${`Copy ${l}`} onClick=${() => copy(c)}><${Icon} name="copy" /></button></div>`)}</div>`;
}

export function SettingsView() {
  const s = farm.value;
  const [slack, setSlack] = useState(null);
  const [mw, setMw] = useState(null);
  const [conc, setConc] = useState(null);
  const [backups, setBackups] = useState(null);
  useEffect(() => { get('/api/backups').then(setBackups).catch(() => setBackups({ backups: [] })); }, [s && s.lastBackup && s.lastBackup.at]);
  if (!s) return html`<div class="page"><${Empty}>Loading…<//></div>`;
  const slackVal = slack ?? s.slackWebhook ?? '';
  const mwVal = mw ?? s.maintenanceWindow ?? { enabled: false, start: '22:00', end: '06:00' };
  const concVal = conc ?? s.maxConcurrentInstalls ?? 4;
  const saveSettings = async (body, msg) => {
    try { await post('/api/settings', body); toast(msg, 'success'); } catch (e) { toast(e.message, 'error'); }
    refresh();
  };
  const NAV = [['downloads', 'Installer downloads', 'folder'], ['slack', 'Slack alerts', 'alert'], ['window', 'Auto-deploy window', 'clock'], ['vendor', 'Vendor downloads', 'download'], ['backups', 'Backups', 'server'], ['enroll', 'Enroll a machine', 'beacon']];
  return html`<div class="page settings-page">
    <${PageHeader} title="Settings" subtitle="How the tracker downloads, alerts, schedules and backs up." />
    <div class="settings-layout">
    <nav class="settings-nav">${NAV.map(([id, label, icon]) => html`<a key=${id} href="#/settings" onClick=${(e) => { e.preventDefault(); document.getElementById('set-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}><${Icon} name=${icon} />${label}</a>`)}</nav>
    <div class="stack settings">

    <section id="set-downloads" class="card card-pad stack">
      <h2 class="card-title"><${Icon} name="folder" />Installer downloads</h2>
      <${FolderSetting} field="downloadDir" label="Apps folder" hint="Where the tracker saves app installers it downloads." value=${s.downloadDir} />
      <${FolderSetting} field="downloadDirPlugins" label="Plug-ins folder" hint="Leave empty to use the apps folder." value=${s.downloadDirPlugins} fallback=${s.downloadDir} />
      <${FolderSetting} field="downloadDirScripts" label="Scripts folder" hint="Leave empty to use the apps folder." value=${s.downloadDirScripts} fallback=${s.downloadDir} />
    </section>

    <section id="set-slack" class="card card-pad stack">
      <h2 class="card-title"><${Icon} name="alert" />Slack alerts</h2>
      <p class="dim" style="margin:0">Failed installs and paused rollouts are posted to this incoming webhook. Leave empty to turn alerts off.</p>
      <div class="row" style="flex-wrap:nowrap">
        <input class="field grow mono" type="url" placeholder="https://hooks.slack.com/services/…" value=${slackVal} onInput=${(e) => setSlack(e.currentTarget.value)} />
        <button class="btn" disabled=${slackVal === (s.slackWebhook || '')} onClick=${() => saveSettings({ slackWebhook: slackVal.trim() }, 'Slack settings saved.')}>Save</button>
        <button class="btn" disabled=${!slackVal.trim()} onClick=${async () => {
          if (slackVal !== (s.slackWebhook || '')) await post('/api/settings', { slackWebhook: slackVal.trim() }).catch(() => {});
          try { await post('/api/slack-test'); toast('Test message sent to Slack.', 'success'); } catch (e) { toast(e.message, 'error'); }
          refresh();
        }}>Send test</button>
      </div>
    </section>

    <section id="set-window" class="card card-pad stack">
      <h2 class="card-title"><${Icon} name="clock" />Auto-deploy window</h2>
      <p class="dim" style="margin:0">Limits automatic rollouts (Catalog → Auto-deploy) to these hours. Updates you start yourself run right away, and installs never run under a render either way.</p>
      <div class="row">
        <label class="check"><input type="checkbox" checked=${mwVal.enabled} onChange=${(e) => setMw({ ...mwVal, enabled: e.currentTarget.checked })} />Only auto-deploy between</label>
        <input class="field" type="time" value=${mwVal.start} onInput=${(e) => setMw({ ...mwVal, start: e.currentTarget.value })} />
        <span class="dim">and</span>
        <input class="field" type="time" value=${mwVal.end} onInput=${(e) => setMw({ ...mwVal, end: e.currentTarget.value })} />
        <button class="btn" disabled=${mw == null} onClick=${() => { saveSettings({ maintenanceWindow: mwVal }, 'Auto-deploy window saved.'); setMw(null); }}>Save</button>
      </div>
    </section>

    <section id="set-vendor" class="card card-pad stack">
      <h2 class="card-title"><${Icon} name="download" />Vendor downloads</h2>
      <p class="dim" style="margin:0">Every idle machine installs from the tracker at once. Updates that download straight from Adobe or Maxon (RUM, Maxon App) are limited to this many machines at a time so the vendor doesn't throttle the farm.</p>
      <div class="row"><input class="field" type="number" min="1" max="50" style="width:90px" value=${concVal} onInput=${(e) => setConc(Number(e.currentTarget.value))} />
        <span class="dim">machines at once</span>
        <button class="btn" disabled=${conc == null || conc === s.maxConcurrentInstalls} onClick=${() => { saveSettings({ maxConcurrentInstalls: concVal }, 'Saved.'); setConc(null); }}>Save</button></div>
    </section>

    <section id="set-backups" class="card card-pad stack">
      <h2 class="card-title"><${Icon} name="server" />Backups</h2>
      <p class="dim" style="margin:0">The database and config are backed up at startup and nightly, outside the repo${s.lastBackup ? ` — last ${ago(s.lastBackup.at, s.now)}` : ''}. Restore with <code>./restore-db.sh</code>.</p>
      ${backups && backups.backups && backups.backups.length ? html`<ul class="plain-list dim" style="font-size:.82rem">${backups.backups.slice(0, 5).map((b) => html`<li key=${b.file || b.db || b.name}><span class="mono">${b.file || b.db || b.name}</span><span style="margin-left:auto">${b.at ? ago(b.at, s.now) : ''}</span></li>`)}</ul>` : null}
      <div><button class="btn" onClick=${act.backupNow}><${Icon} name="download" />Back up now</button></div>
    </section>

    <section id="set-enroll" class="card card-pad stack">
      <h2 class="card-title"><${Icon} name="beacon" />Enroll a machine</h2>
      <p class="dim" style="margin:0">Run the enroll command on the machine, then the elevate command once as an administrator so installs never stop at a permission prompt.</p>
      <${Commands} />
    </section>
    </div>
    </div>
  </div>`;
}
