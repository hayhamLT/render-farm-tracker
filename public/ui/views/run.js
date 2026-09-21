// Run command: pick machines, send one shell command, watch each machine's answer come back.
// Open like the rest of the dashboard — see the note on POST /api/run in server.js. Every
// command and the machines it went to are written to the activity log.
import { html } from '../lib/html.js';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { farm } from '../lib/store.js';
import { get, post } from '../lib/api.js';
import { openDialog, toast } from '../lib/ui.js';
import { cmpVersion, plural } from '../lib/format.js';
import { Icon, Bar } from '../components/common.js';
import { PageHeader } from '../components/page.js';

// The agent versions each mode needs — the same gates the server enforces, so a machine that
// would be refused is shown as not-ready here instead of failing after you press Run.
const MIN_RUN = '2.41.0';
const MIN_AS_USER = '2.42.0';

const MAXON = 'C:\\Program Files\\Maxon\\Tools\\mx1.exe';
const PRESETS = [
  { label: 'Assign Cinema 4D licence', user: true, cmd: `"${MAXON}" license assign net.maxon.license.app.cinema4d-release~commandline-floating` },
  { label: 'Assign Redshift licence', user: true, cmd: `"${MAXON}" license assign net.maxon.license.app.redshift~commercial` },
  { label: 'Which licences are assigned', user: true, cmd: `"${MAXON}" license list` },
  { label: 'Who is logged in', user: false, cmd: 'query user' },
];

// Machines group by their name without the trailing number: AVA-01 and AVA-02 are "AVA".
const familyOf = (h) => (h.match(/^(.*?)[-_]?\d+$/) || [null, h])[1] || h;

function readiness(node, asUser) {
  if (!node.online) return { ok: false, tone: 'bad', label: 'offline', why: `${node.hostname} isn't checking in.` };
  const need = asUser ? MIN_AS_USER : MIN_RUN;
  if (!node.agent_version || cmpVersion(node.agent_version, need) < 0) {
    return { ok: false, tone: 'warn', label: 'updating', why: `Agent ${node.agent_version || 'unknown'} is older than ${need}. Machines update themselves within a few minutes.` };
  }
  return { ok: true, tone: 'ok', label: 'ready', why: `Agent ${node.agent_version}` };
}

// Two answers count as the same when they differ only in what every machine writes
// differently — its own name, paths, ids, dates, times and plain numbers. The exact text is
// never thrown away: if it varies inside a group, each wording is shown underneath.
function shape(r) {
  const out = String(r.output || '')
    .replace(new RegExp(r.hostname, 'gi'), '<machine>')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\d{4}-\d{2}-\d{2}/g, '<date>')
    .replace(/\d{1,2}:\d{2}(:\d{2})?/g, '<time>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ').trim().toLowerCase();
  return `${r.exit_code}|${out}`;
}

function groupRuns(runs) {
  const waiting = runs.filter((r) => r.status !== 'done');
  const by = new Map();
  for (const r of runs.filter((x) => x.status === 'done')) {
    const k = shape(r);
    if (!by.has(k)) by.set(k, { key: k, exit: r.exit_code, members: [] });
    by.get(k).members.push(r);
  }
  const groups = [...by.values()].map((g) => {
    // A machine naming itself in its own output isn't a different wording, so key the
    // variants on the text with that name folded out — but show the real text.
    const variants = new Map();
    for (const m of g.members) {
      const text = (m.output || '').trim();
      const k = text.replace(new RegExp(m.hostname, 'gi'), '\u0000');
      if (!variants.has(k)) variants.set(k, { text, hosts: [] });
      variants.get(k).hosts.push(m.hostname);
    }
    return { ...g, variants: [...variants.values()].sort((a, b) => b.hosts.length - a.hosts.length) };
  });
  groups.sort((a, b) => (a.exit === 0) - (b.exit === 0) || b.members.length - a.members.length);
  return { groups, waiting };
}

// ------------------------------------------------------------------- picker --
function Picker({ nodes, picked, setPicked, asUser }) {
  const [q, setQ] = useState('');
  // Most of the farm is usually offline or mid-update. Showing all 28 buries the handful you
  // can actually act on, so the rest stay behind one click.
  const [showRest, setShowRest] = useState(false);
  const families = useMemo(() => {
    const m = new Map();
    for (const n of nodes) {
      const f = familyOf(n.hostname);
      if (!m.has(f)) m.set(f, []);
      m.get(f).push(n);
    }
    return [...m.entries()]
      .map(([name, list]) => ({ name, list: list.sort((a, b) => a.hostname.localeCompare(b.hostname, undefined, { numeric: true })) }))
      .sort((a, b) => b.list.length - a.list.length || a.name.localeCompare(b.name));
  }, [nodes]);

  const needle = q.trim().toLowerCase();
  const visible = (n) => (!needle || n.hostname.toLowerCase().includes(needle))
    && (showRest || needle || readiness(n, asUser).ok);
  const shown = families
    .map((f) => ({ ...f, list: f.list.filter(visible) }))
    .filter((f) => f.list.length);
  const hidden = nodes.filter((n) => !visible(n)).length;

  const set = (hosts, on) => {
    const c = new Set(picked);
    hosts.forEach((h) => (on ? c.add(h) : c.delete(h)));
    setPicked(c);
  };
  const readyIn = (list) => list.filter((n) => readiness(n, asUser).ok).map((n) => n.hostname);
  const allReady = readyIn(nodes);

  return html`<section class="card">
    <div class="card-head">
      <h2><${Icon} name="server" />Machines</h2>
      <span class="dim">${picked.size ? `${picked.size} selected` : `${plural(allReady.length, 'machine')} ready`}</span>
      <span class="grow"></span>
      <label class="search"><${Icon} name="search" />
        <input class="field" placeholder="Filter" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} style="width:150px;height:28px" /></label>
      <button class="btn sm" onClick=${() => set(allReady, true)}>Select all ready</button>
      <button class="btn sm ghost" disabled=${!picked.size} onClick=${() => setPicked(new Set())}>Clear</button>
    </div>
    <div class="card-pad stack" style="gap:14px">
      ${!shown.length && html`<p class="dim" style="margin:0">${needle ? html`No machine matches “${q}”.` : 'No machine is ready right now.'}</p>`}
      ${shown.map((f) => {
        const ready = readyIn(f.list);
        const all = ready.length && ready.every((h) => picked.has(h));
        return html`<div key=${f.name}>
          <div class="fam-head">
            <button class="btn sm ghost" disabled=${!ready.length}
              title=${ready.length ? (all ? `Deselect all ${f.name}` : `Select all ${f.name}`) : 'No machine here is ready'}
              onClick=${() => set(ready, !all)}>
              <${Icon} name=${all ? 'check' : 'plus'} />${f.name}
            </button>
            <span class="dim">${f.list.length === ready.length ? plural(f.list.length, 'machine') : `${ready.length} of ${f.list.length} ready`}</span>
          </div>
          <div class="mtiles">
            ${f.list.map((n) => {
              const r = readiness(n, asUser);
              const on = picked.has(n.hostname);
              return html`<button key=${n.hostname} type="button" title=${r.why}
                class=${'mtile' + (on ? ' on' : '') + (r.ok ? '' : ' off')}
                disabled=${!r.ok} aria-pressed=${on}
                onClick=${() => set([n.hostname], !on)}>
                <span class=${'run-dot ' + r.tone}></span>
                <b>${n.hostname}</b>
                ${!r.ok && html`<span class="dim">${r.label}</span>`}
              </button>`;
            })}
          </div>
        </div>`;
      })}
      ${hidden ? html`<button class="btn sm ghost" style="align-self:flex-start" onClick=${() => setShowRest(!showRest)}>
        <${Icon} name="chevron" />${showRest ? 'Hide' : 'Show'} ${plural(hidden, 'machine')} that can't take a command
      </button>` : null}
      ${showRest && !hidden ? html`<button class="btn sm ghost" style="align-self:flex-start" onClick=${() => setShowRest(false)}>
        <${Icon} name="chevron" />Hide the ones that can't take a command
      </button>` : null}
    </div>
  </section>`;
}

// ------------------------------------------------------------------ results --
function Results({ runs, skipped, onRerun }) {
  const { groups, waiting } = groupRuns(runs);
  const done = runs.length - waiting.length;
  const failed = groups.filter((g) => g.exit !== 0).flatMap((g) => g.members.map((m) => m.hostname));
  return html`<section class="card">
    <div class="card-head">
      <h2><${Icon} name="activity" />Results</h2>
      <span class="dim">${done} of ${runs.length} reported back</span>
      <span class="grow"></span>
      ${failed.length && !waiting.length ? html`<button class="btn sm" onClick=${() => onRerun(failed)}>
        <${Icon} name="refresh" />Try the ${plural(failed.length, 'failure')} again</button>` : null}
    </div>
    ${waiting.length ? html`<div style="padding:0 16px"><${Bar} pct=${runs.length ? (done / runs.length) * 100 : 0} /></div>` : null}
    <div class="card-pad stack" style="gap:12px">
      ${skipped.map((k) => html`<div key=${k.hostname} class="banner warn"><${Icon} name="alert" /><b>${k.hostname}</b> — not sent: ${k.reason}</div>`)}

      ${groups.map((g) => html`<div key=${g.key} class="run-group">
        <div class="run-group-head">
          <span class=${'run-dot ' + (g.exit === 0 ? 'ok' : 'bad')}></span>
          <b>${g.exit === 0 ? 'Worked' : `Failed — exit ${g.exit}`}</b>
          <span class="dim">${plural(g.members.length, 'machine')}</span>
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
        <div class="run-group-head"><span class="run-dot wait"></span><b>Running</b>
          <span class="dim">${plural(waiting.length, 'machine')} — each answers on its next check-in</span></div>
        <div class="run-hosts">${waiting.map((m) => html`<span key=${m.hostname} class="host-chip">${m.hostname}</span>`)}</div>
      </div>` : null}
    </div>
  </section>`;
}

// --------------------------------------------------------------------- view --
export function RunView() {
  const s = farm.value;
  const [picked, setPicked] = useState(new Set());
  const [cmd, setCmd] = useState('');
  const [asUser, setAsUser] = useState(true);
  const [runs, setRuns] = useState([]);
  const [skipped, setSkipped] = useState([]);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);
  const resultsRef = useRef(null);

  useEffect(() => () => clearInterval(timer.current), []);

  const nodes = (s ? s.nodes : []).filter((n) => n.os === 'windows');
  // Dropping the mode can strand a selection on machines that can no longer take it.
  useEffect(() => {
    const bad = [...picked].filter((h) => { const n = nodes.find((x) => x.hostname === h); return !n || !readiness(n, asUser).ok; });
    if (bad.length) setPicked(new Set([...picked].filter((h) => !bad.includes(h))));
  }, [asUser, s]);

  const poll = (ids) => {
    clearInterval(timer.current);
    const tick = async () => {
      try {
        const r = await get(`/api/run?ids=${ids.join(',')}`);
        setRuns(r.runs);
        if (r.runs.every((x) => x.status === 'done')) clearInterval(timer.current);
      } catch { /* keep trying */ }
    };
    tick();
    timer.current = setInterval(tick, 3000);
  };

  const send = async (hostsIn) => {
    const hosts = hostsIn || [...picked];
    const command = cmd.trim();
    if (!hosts.length || !command) return;
    const ok = await openDialog((close) => html`
      <div class="body stack" style="gap:12px">
        <p style="margin:0">Run on <b>${plural(hosts.length, 'machine')}</b>, ${asUser
          ? html`in the <b>logged-in user's session</b>`
          : html`as the <b>system account</b>`}.</p>
        <div><div class="dim" style="font-size:.8rem;margin-bottom:5px">Command</div>
          <pre class="run-out" style="margin:0;max-height:120px">${command}</pre></div>
        <div><div class="dim" style="font-size:.8rem;margin-bottom:5px">Machines</div>
          <div class="run-hosts" style="margin:0;max-height:110px;overflow:auto">${hosts.map((h) => html`<span key=${h} class="host-chip">${h}</span>`)}</div></div>
      </div>
      <footer>
        <button class="btn ghost" onClick=${() => close(false)}>Cancel</button>
        <button class="btn danger" autofocus onClick=${() => close(true)}><${Icon} name="zap" />Run it</button>
      </footer>`, { title: 'Run this command?' });
    if (!ok) return;
    setBusy(true); setRuns([]); setSkipped([]);
    try {
      const r = await post('/api/run', { hostnames: hosts, command, asUser });
      setSkipped(r.skipped || []);
      setRuns(r.runs.map((x) => ({ ...x, status: 'pending' })));
      if (r.runs.length) {
        poll(r.runs.map((x) => x.id));
        setTimeout(() => resultsRef.current && resultsRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
      } else toast('No machine could take the command.', 'error');
    } catch (e) {
      toast(e.message, 'error');
    }
    setBusy(false);
  };

  const canRun = !busy && picked.size > 0 && cmd.trim().length > 0;
  return html`<div class="stack">
    <${PageHeader} title="Run command" subtitle="Pick machines, type a command, send it. Each machine runs it and reports back what happened." />

    <${Picker} nodes=${nodes} picked=${picked} setPicked=${setPicked} asUser=${asUser} />

    <section class="card">
      <div class="card-head">
        <h2><${Icon} name="command" />Command</h2>
      </div>
      <div class="card-pad stack">
        <div class="preset-row">
          <span class="dim">Start from</span>
          ${PRESETS.map((p) => html`<button key=${p.label} class="btn sm" title=${p.cmd}
            onClick=${() => { setCmd(p.cmd); setAsUser(p.user); }}>${p.label}</button>`)}
        </div>
        <textarea class="field" rows="3" spellcheck="false" placeholder=${PRESETS[0].cmd}
          style="font-family:var(--mono);font-size:.84rem"
          value=${cmd} onInput=${(e) => setCmd(e.currentTarget.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canRun) { e.preventDefault(); send(); } }}></textarea>
        <label class="check run-asuser">
          <input type="checkbox" checked=${asUser} onChange=${(e) => setAsUser(e.currentTarget.checked)} />
          <span><b>Run as the logged-in user</b>
            <span class="dim">Needed by anything tied to a signed-in session — Maxon's mx1 licensing above all, which can't see its licence service from the system account. Turn it off for installers and machine-wide settings.</span></span>
        </label>
      </div>
      <div class="run-bar">
        <span class="dim">${picked.size ? `${plural(picked.size, 'machine')} selected` : 'No machine selected'}</span>
        <span class="grow"></span>
        <span class="dim kbd-hint">⌘↵</span>
        <button class="btn primary" disabled=${!canRun} onClick=${() => send()}>
          <${Icon} name="zap" />Run${picked.size ? ` on ${picked.size}` : ''}</button>
      </div>
    </section>

    <div ref=${resultsRef}>
      ${(runs.length || skipped.length) ? html`<${Results} runs=${runs} skipped=${skipped}
        onRerun=${(hosts) => { setPicked(new Set(hosts)); send(hosts); }} />` : null}
    </div>
  </div>`;
}
