// Installer library (Settings): the installers on the share, grouped by app, with one-click
// "organize into app folders" and a cleanup of old installers nothing uses any more. The server
// decides what's old/in use; files it doesn't recognise are never listed, moved or deleted.
import { html } from '../lib/html.js';
import { useEffect, useState } from 'preact/hooks';
import { farm, refresh } from '../lib/store.js';
import { get, post } from '../lib/api.js';
import { toast, openSheet } from '../lib/ui.js';
import { plural } from '../lib/format.js';
import { Icon, Badge, ProductLogo } from '../components/common.js';
import { StackBar } from '../components/viz.js';

const gb = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1048576))} MB`);
const STATUS = {
  keep: (f) => (/queued|running/.test(f.reason) ? ['accent', 'In use'] : /Current/.test(f.reason) ? ['ok', 'Current'] : ['', 'Kept']),
  unused: () => ['warn', 'Old'],
};

function groupByApp(files) {
  const groups = new Map();
  for (const f of files) {
    if (!groups.has(f.product)) groups.set(f.product, { key: f.product, name: f.productName || f.product, files: [] });
    groups.get(f.product).files.push(f);
  }
  const list = [...groups.values()];
  for (const g of list) {
    g.files.sort((a, b) => String(b.version || '').localeCompare(String(a.version || ''), undefined, { numeric: true }) || String(a.os).localeCompare(String(b.os)));
    g.size = g.files.reduce((s, f) => s + f.size, 0);
    g.unused = g.files.filter((f) => f.status === 'unused');
  }
  return list.sort((a, b) => b.size - a.size);
}

// ---------------------------------------------------------------- cleanup sheet
function CleanupSheet({ data, close, products }) {
  const unused = data.files.filter((f) => f.status === 'unused');
  const [chosen, setChosen] = useState(new Set(unused.map((f) => f.path)));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const size = unused.filter((f) => chosen.has(f.path)).reduce((s, f) => s + f.size, 0);
  const toggle = (p) => { const n = new Set(chosen); if (n.has(p)) n.delete(p); else n.add(p); setChosen(n); setConfirming(false); };
  const run = async () => {
    setBusy(true);
    try {
      const r = await post('/api/installers/delete', { paths: [...chosen] });
      toast(`Deleted ${plural(r.removed.length, 'installer')} — ${gb(r.freed)} freed.${r.refused.length ? ` ${r.refused.length} kept (${r.refused[0].why}).` : ''}`, r.refused.length ? 'info' : 'success', 8000);
      close(true);
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  };
  if (!unused.length) return html`<div class="empty-inline"><${Icon} name="check" /><div><b>No old installers</b><p class="muted">Every installer on the share is current or used by an install.</p></div></div>`;
  return html`<div class="stack" style="gap:14px">
    <p class="muted" style="margin:0">These are older than the version each app installs now and no queued or running install uses them. Deleting removes them from the share for good.</p>
    ${groupByApp(unused).map((g) => html`<section key=${g.key} class="card" style="padding:4px 0">
      <div class="lib-head"><${ProductLogo} product=${products.get(g.key) || { key: g.key, name: g.name }} size=${18} /><b>${g.name}</b><span class="grow"></span><span class="dim">${gb(g.size)}</span></div>
      ${g.files.map((f) => html`<label key=${f.path} class="lib-row check">
        <input type="checkbox" checked=${chosen.has(f.path)} onChange=${() => toggle(f.path)} />
        <span class="lib-name" title=${f.path}>${f.name}</span>
        <span class="dim nowrap">${f.reason}</span>
        <span class="mono nowrap">${gb(f.size)}</span>
      </label>`)}
    </section>`)}
    <div class="deploy-go">
      <span class="muted">${plural(chosen.size, 'installer')} selected · ${gb(size)}</span>
      <span class="grow"></span>
      <button class="btn ghost" onClick=${() => close(null)}>Cancel</button>
      ${confirming
        ? html`<button class="btn danger" disabled=${busy || !chosen.size} onClick=${run}>${busy ? html`<${Icon} name="spinner" cls="spin" />Deleting…` : html`<${Icon} name="trash" />Yes, delete ${gb(size)}`}</button>`
        : html`<button class="btn danger" disabled=${!chosen.size} onClick=${() => setConfirming(true)}><${Icon} name="trash" />Delete ${plural(chosen.size, 'installer')}…</button>`}
    </div>
  </div>`;
}

// ---------------------------------------------------------------- organize sheet
function OrganizeSheet({ data, close }) {
  const [busy, setBusy] = useState(false);
  const loose = data.files.filter((f) => !f.organized);
  const groups = groupByApp(loose);
  const run = async () => {
    setBusy(true);
    try {
      const r = await post('/api/installers/organize');
      toast(`Moved ${plural(r.moved.length, 'installer')} into app folders.${r.skipped.length ? ` ${r.skipped.length} skipped.` : ''}`, 'success', 8000);
      close(true);
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  };
  if (!loose.length) return html`<div class="empty-inline"><${Icon} name="check" /><div><b>Already organized</b><p class="muted">Every installer the tracker manages is in its app's folder.</p></div></div>`;
  return html`<div class="stack" style="gap:14px">
    <p class="muted" style="margin:0">Each installer moves into a folder named after its app, on the same share — an instant move, nothing is copied or deleted. Installs keep working; files the tracker doesn't recognise (${data.otherCount}) stay where they are.</p>
    ${groups.map((g) => html`<div key=${g.key} class="card" style="padding:10px 14px">
      <div class="row" style="gap:8px"><${Icon} name="folder" /><b>${data.share.replace(/\/$/, '')}/${g.name}/</b><span class="grow"></span><span class="dim">${plural(g.files.length, 'file')}</span></div>
      <ul class="plain-list dim" style="margin:6px 0 0 24px;font-size:.82rem">${g.files.map((f) => html`<li key=${f.path}>${f.name}</li>`)}</ul>
    </div>`)}
    <div class="deploy-go">
      <span class="muted">${plural(loose.length, 'installer')} into ${plural(groups.length, 'folder')}</span>
      <span class="grow"></span>
      <button class="btn ghost" onClick=${() => close(null)}>Cancel</button>
      <button class="btn primary" disabled=${busy} onClick=${run}>${busy ? html`<${Icon} name="spinner" cls="spin" />Moving…` : html`<${Icon} name="folder" />Organize`}</button>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- section
export function InstallerLibrary() {
  const s = farm.value;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  const load = () => get('/api/installers').then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const products = new Map(((s && s.products) || []).map((p) => [p.key, p]));

  if (error) return html`<div class="banner bad"><${Icon} name="alert" />Couldn't read the installer share: ${error}</div>`;
  if (!data) return html`<span class="skeleton" style="height:120px;border-radius:10px"></span>`;
  const groups = groupByApp(data.files);
  const total = data.files.reduce((a, f) => a + f.size, 0);
  const unused = data.files.filter((f) => f.status === 'unused');
  const unusedSize = unused.reduce((a, f) => a + f.size, 0);
  const loose = data.files.filter((f) => !f.organized).length;
  const after = (changed) => { if (changed) { load(); refresh(); } };

  return html`<div class="stack" style="gap:12px">
    <div class="lib-summary">
      <div><span class="label">Tracker installers</span><b>${gb(total)}</b><span class="dim">${plural(data.files.length, 'file')} · ${plural(groups.length, 'app')}</span></div>
      <div><span class="label">Old, unused</span><b style=${unused.length ? 'color:var(--warn)' : ''}>${unused.length ? gb(unusedSize) : 'none'}</b><span class="dim">${plural(unused.length, 'installer')}</span></div>
      ${data.space && html`<div class="grow"><span class="label">Share space</span><b>${gb(data.space.free)} free</b>
        <${StackBar} height=${6} total=${data.space.total} parts=${[{ value: data.space.total - data.space.free, color: 'var(--accent)', label: 'used' }]} /></div>`}
    </div>
    <div class="row" style="gap:8px">
      ${loose ? html`<button class="btn" onClick=${() => openSheet((close) => html`<${OrganizeSheet} data=${data} close=${close} />`, { title: 'Organize installers', subtitle: 'One folder per app on the share', width: 620 }).then(after)}>
        <${Icon} name="folder" />Organize into app folders (${loose})</button>` : null}
      ${unused.length ? html`<button class="btn" onClick=${() => openSheet((close) => html`<${CleanupSheet} data=${data} close=${close} products=${products} />`, { title: 'Clean up old installers', subtitle: `${plural(unused.length, 'installer')} · ${gb(unusedSize)} can go`, width: 680 }).then(after)}>
        <${Icon} name="trash" />Clean up ${gb(unusedSize)}…</button>` : null}
      <button class="btn ghost sm icon" title="Refresh" aria-label="Refresh" onClick=${load}><${Icon} name="refresh" /></button>
    </div>
    <div class="card lib-list">
      ${groups.map((g) => html`<details key=${g.key} class="lib-group" open=${open === g.key} onToggle=${(e) => { if (e.currentTarget.open) setOpen(g.key); }}>
        <summary class="lib-head"><${ProductLogo} product=${products.get(g.key) || { key: g.key, name: g.name }} size=${18} /><b>${g.name}</b>
          <span class="dim">${plural(g.files.length, 'file')}</span>${g.unused.length ? html`<${Badge} tone="warn">${g.unused.length} old<//>` : null}
          <span class="grow"></span><span class="mono dim">${gb(g.size)}</span></summary>
        ${g.files.map((f) => { const [tone, label] = STATUS[f.status](f); return html`<div key=${f.path} class="lib-row">
          <span class="lib-name" title=${f.path}>${f.name}</span>
          <span class="dim nowrap">${f.os === 'windows' ? 'Windows' : f.os === 'macos' ? 'Mac' : ''}</span>
          <${Badge} tone=${tone} title=${f.reason}>${label}<//>
          <span class="mono nowrap">${gb(f.size)}</span>
        </div>`; })}
      </details>`)}
    </div>
  </div>`;
}
