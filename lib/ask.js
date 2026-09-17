'use strict';
// "Ask the farm": answer a plain-English question from the tracker's own data, using the local
// Ollama model on this server (the same one the DeadlineWatcher analysts use) — no cloud, no key.
//
// The model only sees a compact text snapshot we build here: every machine's current state, a
// 7-day summary per machine from the timeline, open and recent rollouts, recent activity, and —
// for machines or apps the question mentions — their detailed timeline, jobs and install logs.
// It is told to answer only from that data.
const http = require('node:http');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const tail = (s, n) => { s = String(s || '').trim(); return s.length > n ? `…${s.slice(-n)}` : s; };
const hm = (ms) => { const m = Math.round(ms / MIN); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`; };
const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };
const when = (ts) => new Date(ts).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function versionCmp(a, b) {
  const pa = String(a || '').split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b || '').split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const x = pa[i] || 0; const y = pb[i] || 0; if (x !== y) return x < y ? -1 : 1; }
  return 0;
}

// Which machines / apps does the conversation talk about?
function focusOf(text, state) {
  const t = ` ${String(text || '').toLowerCase()} `;
  const hosts = state.nodes.map((n) => n.hostname).filter((h) => {
    const k = h.toLowerCase();
    // "mars-05", "mars 05", "mars05"
    return t.includes(k) || t.includes(k.replace(/-/g, ' ')) || t.includes(k.replace(/-/g, ''));
  });
  const apps = state.products.filter((p) => {
    const words = [p.key, p.name, ...String(p.name).split(/[()]/)].map((w) => String(w).toLowerCase().trim()).filter((w) => w.length > 3);
    return words.some((w) => t.includes(w));
  }).map((p) => p.key);
  if (/\bnvidia|driver\b/.test(t)) apps.push('nvidia');
  if (/\bc4d\b|cinema/.test(t)) apps.push('cinema4d');
  if (/\bae\b|after effects/.test(t)) apps.push('aftereffects');
  return { hosts: [...new Set(hosts)], apps: [...new Set(apps)] };
}

function timelineLine(row, names) {
  const [kind, ts, end, st, d] = row;
  const dur = end == null ? `${hm(Date.now() - ts)} so far` : hm(end - ts);
  switch (kind) {
    case 'offline': return `${when(ts)} offline ${dur}`;
    case 'render': return `${when(ts)} rendering ${dur}${d && d.n ? ` (GPU avg ${Math.round(d.sum / d.n)}%)` : ''}`;
    case 'deadline': return `${when(ts)} Deadline Worker NOT running for ${dur}`;
    case 'reboot': return `${when(ts)} Windows restart pending ${dur}`;
    case 'install': return `${when(end || ts)} install ${st} ${names.get(d && d.product) || (d && d.product)} ${(d && d.version) || ''}${d && d.approx ? '' : ` (took ${dur})`}`;
    case 'power': return `${when(ts)} power: ${st}${d && d.reason ? ` — ${clip(d.reason, 160)}` : ''}${d && d.secs ? ` after ${d.secs}s` : ''}`;
    case 'agent': return `${when(ts)} agent updated ${d.from} → ${d.to}`;
    case 'driver': return `${when(ts)} GPU driver changed ${d.from} → ${d.to}`;
    case 'fix': return `${when(ts)} Deadline startup fix ${st}: ${clip(d && d.message, 200)}`;
    default: return `${when(ts)} ${kind}`;
  }
}

function buildContext({ state, timeline, question, history }) {
  const now = Date.now();
  const names = new Map(state.products.map((p) => [p.key, p.name]));
  const convo = [...(history || []).map((m) => m.content), question].join(' ');
  const focus = focusOf(convo, state);
  const tracked = state.products.filter((p) => !p.dashboard_hidden && p.latest_version);
  const out = [];

  const online = state.nodes.filter((n) => n.online);
  const dlDown = online.filter((n) => { const d = parse(n.deadline_info); return d && d.installed && !d.worker; });
  out.push(`NOW: ${when(now)}. ${state.nodes.length} machines, ${online.length} online, ${state.nodes.length - online.length} offline, ${dlDown.length} online but out of Deadline.`);

  // ---- what needs attention, computed exactly (small models count and filter badly)
  const att = [];
  const offline = state.nodes.filter((n) => !n.online);
  if (offline.length) att.push(`Offline: ${offline.map((n) => n.hostname).join(', ')}`);
  if (dlDown.length) att.push(`Online but Deadline Worker not running (takes no renders): ${dlDown.map((n) => n.hostname).join(', ')}`);
  const noAuto = online.filter((n) => { const d = parse(n.deadline_info); return d && d.installed && d.worker && !d.autostart; });
  if (noAuto.length) att.push(`Deadline running but won't start again after a restart (no auto-start): ${noAuto.map((n) => n.hostname).join(', ')}`);
  const reboot = online.filter((n) => n.pending_reboot);
  if (reboot.length) att.push(`Windows restart pending: ${reboot.map((n) => n.hostname).join(', ')}`);
  const lowDisk = online.filter((n) => n.disk_free_gb != null && n.disk_free_gb < 25);
  if (lowDisk.length) att.push(`Low disk (<25 GB free): ${lowDisk.map((n) => `${n.hostname} ${Math.round(n.disk_free_gb)} GB`).join(', ')}`);
  const oldAgent = state.nodes.filter((n) => n.agent_version && state.latestAgentVersion && versionCmp(n.agent_version, state.latestAgentVersion) < 0);
  if (oldAgent.length) att.push(`Old agent (latest ${state.latestAgentVersion}): ${oldAgent.map((n) => `${n.hostname} ${n.agent_version}`).join(', ')}`);
  const failed24 = state.jobs.filter((j) => j.status === 'failed' && now - j.updated_at < 24 * HOUR);
  if (failed24.length) att.push(`Installs failed in the last 24 h: ${failed24.map((j) => `${j.hostname} (${names.get(j.product_key)} ${j.package_version})`).join(', ')}`);
  out.push(`\nNEEDS ATTENTION (exact lists):\n${att.length ? att.map((a) => `- ${a}`).join('\n') : '- nothing'}`);

  // ---- every machine, one line
  out.push('\nMACHINES (host | os | status | GPU load | Deadline | agent | behind on | current job):');
  for (const n of state.nodes) {
    const d = parse(n.deadline_info);
    const dl = !d ? 'n/a' : !d.installed ? 'not installed' : `${d.worker ? 'worker running' : 'WORKER DOWN'}${d.autostart ? '' : ', no auto-start'}`;
    const behind = tracked.filter((p) => {
      const sw = (n.software || []).find((x) => x.product_key === p.key);
      const target = (n.os === 'windows' ? p.latest_win : p.latest_mac) || p.latest_version;
      return sw && sw.version && target && versionCmp(sw.version, target) < 0;
    }).map((p) => names.get(p.key));
    const job = state.jobs.find((j) => j.hostname === n.hostname && ['pending', 'downloading', 'installing'].includes(j.status));
    out.push(`${n.hostname} | ${n.os} | ${n.online ? 'online' : `OFFLINE (last seen ${when(n.last_seen)})`}${n.pending_reboot ? ', restart pending' : ''} | ${n.online && n.gpu_util != null ? `${n.gpu_util}%` : '-'} | ${dl} | ${n.agent_version || '-'} | ${behind.join(', ') || 'up to date'} | ${job ? `${job.status} ${names.get(job.product_key)} ${job.package_version}` : '-'}`);
  }

  // ---- 7-day summary per machine from the timeline
  if (timeline) {
    const from = timeline.from;
    out.push(`\nLAST ${Math.round((now - from) / (24 * HOUR))} DAYS PER MACHINE (rendering time | offline time | Deadline drop-outs | installs ok/failed). Timeline recording started ${when(timeline.since || from)}:`);
    for (const n of state.nodes) {
      const rows = timeline.nodes[n.id] || [];
      const sum = { render: 0, offline: 0, drops: 0, ok: 0, failed: 0 };
      for (const [kind, ts, end, st] of rows) {
        const span = Math.max(0, Math.min(end == null ? now : end, now) - Math.max(ts, from));
        if (kind === 'render') sum.render += span;
        if (kind === 'offline') sum.offline += span;
        if (kind === 'deadline') sum.drops++;
        if (kind === 'install' && st === 'success') sum.ok++;
        if (kind === 'install' && st === 'failed') sum.failed++;
      }
      out.push(`${n.hostname} | ${hm(sum.render)} | ${hm(sum.offline)} | ${sum.drops} | ${sum.ok}/${sum.failed}`);
    }
  }

  // ---- rollouts
  const rollouts = state.rollouts || [];
  if (rollouts.length) {
    out.push('\nROLLOUTS:');
    for (const r of rollouts.slice(0, 10)) {
      const c = r.counts;
      out.push(`"${r.name}" ${r.status}${r.status === 'scheduled' ? ` starts ${when(r.run_at)}` : r.finished_at ? ` ${when(r.finished_at)}` : ''} — ${c.machines} machines: ${c.success} installed, ${c.failed} failed, ${c.pending} waiting, ${c.running} installing${r.summary && r.summary.failed.length ? `; failed on ${r.summary.failed.map((f) => f.host).join(', ')}` : ''}`);
    }
  }

  // ---- focus machines: detailed history + jobs with log tails
  for (const host of focus.hosts.slice(0, 4)) {
    const n = state.nodes.find((x) => x.hostname === host);
    out.push(`\nDETAIL ${host}: OS ${n.os_version || n.os}, GPU ${n.gpu || '-'} driver ${n.gpu_driver || '-'}, disk ${n.disk_free_gb != null ? `${Math.round(n.disk_free_gb)} GB free` : '-'}, installs ${n.elevated === 0 ? 'need elevation' : 'ready'}.`);
    const d = parse(n.deadline_info);
    if (d) out.push(`Deadline: installed=${d.installed} launcher=${d.launcher} worker=${d.worker} autostart=${d.autostart} starts-via=${(d.how || []).join(',') || 'nothing'} autologon=${d.autologon} user=${d.user || '-'}`);
    const fix = parse(n.deadline_fix);
    if (fix) out.push(`Last Deadline startup fix ${when(fix.at)}: ${fix.ok ? 'ok' : 'failed'} — ${clip(fix.message, 300)}`);
    if (n.wake && n.wake.state) out.push(`Wake-on-LAN: ${n.wake.state}${n.wake.reason ? ` — ${clip(n.wake.reason, 200)}` : ''}`);
    const rows = timeline && timeline.nodes[n.id] ? timeline.nodes[n.id] : [];
    if (rows.length) {
      out.push(`${host} timeline (oldest first):`);
      for (const r of rows.slice(-40)) out.push(`  ${timelineLine(r, names)}`);
    }
    const jobs = state.jobs.filter((j) => j.hostname === host).slice(0, 8);
    if (jobs.length) {
      out.push(`${host} install jobs (newest first):`);
      for (const j of jobs) out.push(`  #${j.id} ${names.get(j.product_key)} ${j.package_version}: ${j.status}, ${when(j.updated_at)}${j.log && j.status !== 'success' ? ` — log: ${tail(j.log, 450)}` : ''}`);
    }
  }

  // ---- focus apps: failures across the farm
  for (const key of focus.apps.slice(0, 3)) {
    const p = state.products.find((x) => x.key === key);
    if (!p) continue;
    const jobs = state.jobs.filter((j) => j.product_key === key).slice(0, 25);
    const failed = jobs.filter((j) => j.status === 'failed');
    out.push(`\nAPP ${p.name}: latest ${p.latest_win && p.latest_mac && p.latest_win !== p.latest_mac ? `Windows ${p.latest_win}, Mac ${p.latest_mac}` : p.latest_version}. Recent jobs: ${jobs.length}, failed: ${failed.length}.`);
    for (const j of failed.slice(0, 6)) out.push(`  failed #${j.id} on ${j.hostname} ${j.package_version} ${when(j.updated_at)} — log: ${tail(j.log, 350)}`);
  }

  // ---- recent activity
  const events = state.events.slice(0, focus.hosts.length ? 25 : 40);
  if (events.length) {
    out.push('\nRECENT ACTIVITY (newest first):');
    for (const e of events) out.push(`${when(e.ts)} ${clip(e.message, 220)}`);
  }

  return { text: out.join('\n'), focus };
}

const SYSTEM = `You are the assistant inside the Render Farm Tracker, the dashboard for a render farm of Windows and Mac machines running Deadline (render manager), Cinema 4D, Redshift, After Effects and friends.
Answer the user's question using ONLY the DATA below. If the data doesn't show the answer, say what's missing instead of guessing.
Rules:
- Be brief and concrete: a short paragraph or a few bullets. Lead with the answer.
- For "what needs attention / what's wrong" questions, use the NEEDS ATTENTION lists as they are — don't add or drop machines.
- Use exact machine hostnames (e.g. MARS-05) and exact versions and times from the data.
- When something needs fixing, name the real dashboard control — these are the only ones that exist:
  • a machine's Actions menu (Machines page, or its details panel): "Restart", "Shut down", "Wake", "Fix Deadline startup" (Windows only: sets up auto-start and starts Deadline now)
  • the Updates page: "Update N machines" (now or scheduled), and "Retry" / "Stop" on an install job
  Anything else (Deadline Monitor, logs on the machine, remote desktop) is done outside the tracker — say so. You cannot run anything yourself.
- "WORKER DOWN" means the machine takes no renders. "no auto-start" means Deadline won't come back after a restart; if it is not written, auto-start IS set up.
- Never invent file paths, services, log locations or versions that are not in the DATA.
- Plain text with simple markdown (**bold**, "- " bullets). No tables, no headings.`;

function createAsk({ url = 'http://127.0.0.1:11434', model = 'granite4.1:8b', numCtx = 16384 } = {}) {
  let busy = 0;

  // Streams tokens to onToken; resolves {ms, model} or rejects.
  function chat(messages, onToken, signal) {
    return new Promise((resolve, reject) => {
      const u = new URL('/api/chat', url);
      const started = Date.now();
      const req = http.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 240000 }, (res) => {
        if (res.statusCode !== 200) {
          let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => reject(new Error(`local model error ${res.statusCode}: ${clip(t, 200)}`)));
          return;
        }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line) continue;
            try {
              const m = JSON.parse(line);
              if (m.error) return reject(new Error(m.error));
              if (m.message && m.message.content) onToken(m.message.content);
              if (m.done) resolve({ ms: Date.now() - started, model });
            } catch { /* partial line */ }
          }
        });
        res.on('end', () => resolve({ ms: Date.now() - started, model }));
      });
      req.on('timeout', () => req.destroy(new Error('the local model took too long')));
      req.on('error', (e) => reject(e.code === 'ECONNREFUSED' ? new Error("the local AI (Ollama) isn't running on the tracker server") : e));
      if (signal) signal.addEventListener('abort', () => req.destroy(new Error('cancelled')));
      req.end(JSON.stringify({ model, stream: true, think: false, keep_alive: '30m', options: { temperature: 0.2, num_ctx: numCtx }, messages }));
    });
  }

  // Handle POST /api/ask: body {question, history:[{role, content}]}. Streams NDJSON lines:
  //   {"focus": {...}}  then  {"t": "text"}…  then  {"done": true, "ms", "model"}  or  {"error"}
  async function handle(req, res, body, { state, timeline }) {
    const question = clip(body.question, 1000);
    if (!question) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Ask a question.' })); }
    const history = (Array.isArray(body.history) ? body.history : []).slice(-6)
      .filter((m) => m && ['user', 'assistant'].includes(m.role)).map((m) => ({ role: m.role, content: clip(m.content, 2000) }));
    const ctx = buildContext({ state, timeline, question, history });
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    const send = (o) => res.write(`${JSON.stringify(o)}\n`);
    send({ focus: ctx.focus, queued: busy > 0 });
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    busy++;
    try {
      const messages = [
        { role: 'system', content: `${SYSTEM}\n\nDATA:\n${ctx.text}` },
        ...history,
        { role: 'user', content: question },
      ];
      const r = await chat(messages, (t) => send({ t }), ac.signal);
      send({ done: true, ...r });
    } catch (e) {
      if (!ac.signal.aborted) send({ error: e.message });
    } finally {
      busy--;
      res.end();
    }
  }

  function status() {
    return new Promise((resolve) => {
      const req = http.get(new URL('/api/tags', url), { timeout: 2500 }, (res) => {
        let t = ''; res.on('data', (c) => { t += c; });
        res.on('end', () => {
          try {
            const models = (JSON.parse(t).models || []).map((m) => m.name);
            resolve({ ok: models.includes(model), model, models, reason: models.includes(model) ? null : `model ${model} isn't pulled` });
          } catch { resolve({ ok: false, model, reason: 'unexpected reply from Ollama' }); }
        });
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve({ ok: false, model, reason: "Ollama isn't running on the tracker server" }));
    });
  }

  return { handle, status, buildContext };
}

module.exports = { createAsk, buildContext, focusOf };
