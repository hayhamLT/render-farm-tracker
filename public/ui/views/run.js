// Run command: pick machines, send one shell command, watch each machine's result come back.
// Guarded by the admin key (config.adminKey on the server) — this runs code as SYSTEM.
import { html } from '../lib/html.js';
import { useEffect, useRef, useState } from 'preact/hooks';
import { farm } from '../lib/store.js';
import { url } from '../lib/api.js';
import { openDialog, toast } from '../lib/ui.js';
import { Icon, Empty } from '../components/common.js';
import { PageHeader } from '../components/page.js';

const KEY = 'tracker.adminKey';
const getKey = () => { try { return sessionStorage.getItem(KEY) || ''; } catch { return ''; } };
const setKey = (v) => { try { v ? sessionStorage.setItem(KEY, v) : sessionStorage.removeItem(KEY); } catch { /* private mode */ } };

async function call(method, path, body) {
  const res = await fetch(url(path), {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': getKey() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return data;
}

const GROUPS = [['AVA', /^AVA-/i], ['GREENBEAST', /^GREENBEAST-/i], ['MARS', /^MARS-/i]];

// Machines that said the same thing are one result, not twelve. Two outputs count as the same
// when they differ only in the details every machine writes differently — its own name, paths,
// ids, dates, times and plain numbers (seat 4 vs seat 5). The exact text is never thrown away:
// if it varies inside a group, each wording is shown underneath.
function shape(r) {
  const out = String(r.output || '')
    .replace(new RegExp(r.hostname, 'gi'), '<machine>')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\d{4}-\d{2}-\d{2}/g, '<date>')
    .replace(/\d{1,2}:\d{2}(:\d{2})?/g, '<time>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return `${r.exit_code}|${out}`;
}

function groupRuns(runs) {
  const waiting = runs.filter((r) => r.status !== 'done');
  const by = new Map();
  for (const r of runs.filter((r) => r.status === 'done')) {
    const k = shape(r);
    if (!by.has(k)) by.set(k, { key: k, exit: r.exit_code, members: [] });
    by.get(k).members.push(r);
  }
  const groups = [...by.values()].map((g) => {
    // Exact wordings inside this group, most common first.
    const variants = new Map();
    for (const m of g.members) {
      const text = (m.output || '').trim();
      if (!variants.has(text)) variants.set(text, []);
      variants.get(text).push(m.hostname);
    }
    const list = [...variants.entries()].map(([text, hosts]) => ({ text, hosts }))
      .sort((a, b) => b.hosts.length - a.hosts.length);
    return { ...g, variants: list };
  });
  // Failures first, then the biggest groups.
  groups.sort((a, b) => (a.exit === 0) - (b.exit === 0) || b.members.length - a.members.length);
  return { groups, waiting };
}

export function RunView() {
  const s = farm.value;
  const nodes = (s ? s.nodes : []).filter((n) => n.os === 'windows' || n.os === 'macos').sort((a, b) => a.hostname.localeCompare(b.hostname, undefined, { numeric: true }));
  const [unlocked, setUnlocked] = useState(false);
  const [keyIn, setKeyIn] = useState('');
  const [picked, setPicked] = useState(new Set());
  const [cmd, setCmd] = useState('');
  const [osF, setOsF] = useState('windows');
  const [asUser, setAsUser] = useState(true);
  const [runs, setRuns] = useState([]);       // [{id, hostname, status, exit_code, output}]
  const [skipped, setSkipped] = useState([]);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);

  useEffect(() => { if (getKey()) call('GET', '/api/run/check').then(() => setUnlocked(true)).catch(() => setKey('')); }, []);
  useEffect(() => () => clearInterval(timer.current), []);

  const unlock = async () => {
    setKey(keyIn.trim());
    try { await call('GET', '/api/run/check'); setUnlocked(true); setKeyIn(''); } catch (e) { setKey(''); toast(e.message, 'error'); }
  };

  const shown = nodes.filter((n) => !osF || n.os === osF);
  const toggle = (h) => { const c = new Set(picked); c.has(h) ? c.delete(h) : c.add(h); setPicked(c); };
  const setMany = (list, on) => { const c = new Set(picked); list.forEach((h) => (on ? c.add(h) : c.delete(h))); setPicked(c); };

  const poll = (ids) => {
    clearInterval(timer.current);
    const tick = async () => {
      try {
        const r = await call('GET', `/api/run?ids=${ids.join(',')}`);
        setRuns(r.runs);
        if (r.runs.every((x) => x.status === 'done')) clearInterval(timer.current);
      } catch { /* keep trying */ }
    };
    tick(); timer.current = setInterval(tick, 3000);
  };

  const send = async () => {
    const hosts = [...picked];
    const command = cmd.trim();
    // This runs as SYSTEM on real render nodes: show the exact command and every machine
    // it lands on, verbatim, before anything is sent.
    const ok = await openDialog((close) => html`
      <div class="body stack" style="gap:12px">
        <p style="margin:0">This runs on <b>${hosts.length}</b> machine${hosts.length === 1 ? '' : 's'}, ${asUser ? html`in the <b>logged-in user's session</b>` : html`as the <b>system account</b>`}.</p>
        <div><div class="dim" style="font-size:.8rem;margin-bottom:5px">Command</div>
          <pre class="run-out" style="margin:0;max-height:120px">${command}</pre></div>
        <div><div class="dim" style="font-size:.8rem;margin-bottom:5px">Machines</div>
          <div class="run-hosts" style="margin:0;max-height:120px;overflow:auto">${hosts.map((h) => html`<span key=${h} class="host-chip">${h}</span>`)}</div></div>
      </div>
      <footer>
        <button class="btn ghost" onClick=${() => close(false)}>Cancel</button>
        <button class="btn danger" autofocus onClick=${() => close(true)}><${Icon} name="zap" />Run it</button>
      </footer>`, { title: 'Run this command?' });
    if (!ok) return;
    setBusy(true); setRuns([]); setSkipped([]);
    try {
      const r = await call('POST', '/api/run', { hostnames: hosts, command, asUser });
      setSkipped(r.skipped || []);
      setRuns(r.runs.map((x) => ({ ...x, status: 'pending' })));
      if (r.runs.length) poll(r.runs.map((x) => x.id));
      else toast('No machine could take the command.', 'error');
    } catch (e) {
      if (e.status === 401 || e.status === 403) { setUnlocked(false); setKey(''); }
      toast(e.message, 'error');
    }
    setBusy(false);
  };

  if (!unlocked) {
    return html`<div class="stack">
      <${PageHeader} title="Run command" subtitle="Send a command to chosen machines and see what each one says back." />
      <section class="card card-pad stack" style="max-width:520px">
        <p class="dim" style="margin:0">This runs code on the machines as the system account, so it needs the admin key (<code>adminKey</code> in the tracker's config.json). It's kept only for this browser tab.</p>
        <div class="row"><input class="field" type="password" placeholder="Admin key" value=${keyIn} onInput=${(e) => setKeyIn(e.currentTarget.value)} onKeyDown=${(e) => e.key === 'Enter' && unlock()} />
          <button class="btn primary" disabled=${!keyIn.trim()} onClick=${unlock}>Unlock</button></div>
      </section></div>`;
  }

  const finished = runs.length && runs.every((x) => x.status === 'done');
  return html`<div class="stack">
    <${PageHeader} title="Run command" subtitle="Pick machines, type a command, send it. Each machine runs it and reports the exit code and output.">
      <button class="btn ghost" onClick=${() => { setKey(''); setUnlocked(false); }}><${Icon} name="key" />Lock</button>
    </${PageHeader}>
    <section class="card card-pad stack">
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <b>Machines</b><span class="dim">${picked.size} selected</span><span class="grow"></span>
        <select class="field" value=${osF} onChange=${(e) => setOsF(e.currentTarget.value)}><option value="windows">Windows</option><option value="macos">macOS</option><option value="">All</option></select>
        ${GROUPS.map(([label, re]) => html`<button key=${label} class="btn sm" onClick=${() => setMany(shown.filter((n) => re.test(n.hostname)).map((n) => n.hostname), true)}>+ ${label}</button>`)}
        <button class="btn sm" onClick=${() => setMany(shown.filter((n) => n.online).map((n) => n.hostname), true)}>All online</button>
        <button class="btn sm ghost" onClick=${() => setPicked(new Set())}>Clear</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:4px 14px">
        ${shown.map((n) => html`<label key=${n.hostname} class="check" style=${n.online ? '' : 'opacity:.55'}>
          <input type="checkbox" checked=${picked.has(n.hostname)} onChange=${() => toggle(n.hostname)} />
          <span><b>${n.hostname}</b><span class="dim">${n.online ? (n.gpu || '') : 'offline'}</span></span></label>`)}
      </div>
    </section>
    <section class="card card-pad stack">
      <b>Command</b>
      <textarea class="field" rows="3" spellcheck="false" style="font-family:var(--mono)" placeholder='"C:\\Program Files\\Maxon\\Tools\\mx1.exe" license assign net.maxon.license.app.redshift~commercial' value=${cmd} onInput=${(e) => setCmd(e.currentTarget.value)}></textarea>
      <label class="check run-asuser"><input type="checkbox" checked=${asUser} onChange=${(e) => setAsUser(e.currentTarget.checked)} />
        <span><b>Run as the logged-in user</b><span class="dim">Needed by anything tied to a signed-in session — Maxon's mx1 licensing above all. Off means the system account, which is right for installers and machine-wide settings.</span></span></label>
      <div class="row"><span class="dim">Runs through cmd.exe, no window, 5-minute limit.</span><span class="grow"></span>
        <button class="btn primary" disabled=${busy || !picked.size || !cmd.trim()} onClick=${send}><${Icon} name="zap" />Run on ${picked.size || 0}</button></div>
    </section>
    ${(runs.length || skipped.length) ? (() => {
      const { groups, waiting } = groupRuns(runs);
      const okCount = groups.filter((g) => g.exit === 0).reduce((n, g) => n + g.members.length, 0);
      return html`<section class="card card-pad stack">
        <div class="row">
          <b>Results</b>
          <span class="dim">${runs.length - waiting.length} of ${runs.length} reported back${waiting.length ? ' — the rest report on their next check-in' : ''}</span>
          <span class="grow"></span>
          ${runs.length && !waiting.length ? html`<span class="badge run-summary">${okCount} succeeded${runs.length - okCount ? ` · ${runs.length - okCount} failed` : ''}</span>` : null}
        </div>

        ${skipped.map((k) => html`<div key=${k.hostname} class="banner warn"><${Icon} name="alert" /><b>${k.hostname}</b> — not sent: ${k.reason}</div>`)}

        ${groups.map((g) => html`<div key=${g.key} class="run-group">
          <div class="run-group-head">
            <span class=${'run-dot ' + (g.exit === 0 ? 'ok' : 'bad')}></span>
            <b>${g.exit === 0 ? 'Succeeded' : `Failed — exit ${g.exit}`}</b>
            <span class="dim">${g.members.length} machine${g.members.length === 1 ? '' : 's'}</span>
            <span class="grow"></span>
            <button class="btn sm ghost" title="Copy these machine names"
              onClick=${() => { navigator.clipboard.writeText(g.members.map((m) => m.hostname).join(' ')); toast('Machine names copied.', 'success'); }}>
              <${Icon} name="copy" />Copy
            </button>
          </div>
          <div class="run-hosts">${g.members.map((m) => html`<span key=${m.hostname} class="host-chip">${m.hostname}</span>`)}</div>
          ${g.variants.length === 1
            ? html`<pre class="run-out">${g.variants[0].text || '(no output)'}</pre>`
            : html`<div class="stack" style="gap:8px;margin-top:11px">
                <p class="dim run-note" style="margin:0">Same outcome, ${g.variants.length} different wordings.</p>
                ${g.variants.map((v) => html`<div key=${v.hosts.join()}>
                  <div class="run-hosts" style="margin:0 0 5px">${v.hosts.map((h) => html`<span key=${h} class="host-chip">${h}</span>`)}</div>
                  <pre class="run-out" style="margin:0">${v.text || '(no output)'}</pre>
                </div>`)}
              </div>`}
        </div>`)}

        ${waiting.length ? html`<div class="run-group waiting">
          <div class="run-group-head"><span class="run-dot wait"></span><b>Still running</b><span class="dim">${waiting.length} machine${waiting.length === 1 ? '' : 's'}</span></div>
          <div class="run-hosts">${waiting.map((m) => html`<span key=${m.hostname} class="host-chip">${m.hostname}</span>`)}</div>
        </div>` : null}
      </section>`;
    })() : null}
  </div>`;
}
