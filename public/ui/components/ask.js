// "Ask the farm": a panel docked on the right where you ask questions in plain English. Answers
// stream from the local AI model on the tracker server (Ollama), grounded in the tracker's data.
// Open with the sidebar button or ⌘J; "Ask about this machine" in a machine's details pre-fills it.
import { html } from '../lib/html.js';
import { useEffect, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals-core';
import { farm } from '../lib/store.js';
import { url, get } from '../lib/api.js';
import { go } from '../lib/router.js';
import { Icon } from './common.js';

export const askOpen = signal(false);
const messages = signal([]);         // [{role, content, ms?, error?, pending?}]
const draft = signal('');
const status = signal(null);         // {ok, model, reason}
let controller = null;

export function askAbout(question, send = true) {
  askOpen.value = true;
  if (send) setTimeout(() => ask(question), 0);
  else draft.value = question;
}

async function ask(question) {
  const q = String(question || '').trim();
  if (!q || (controller && !controller.signal.aborted)) return;
  const history = messages.value.filter((m) => !m.error && !m.pending).map((m) => ({ role: m.role, content: m.content }));
  messages.value = [...messages.value, { role: 'user', content: q }, { role: 'assistant', content: '', pending: true, started: Date.now() }];
  draft.value = '';
  const update = (patch) => {
    const list = [...messages.value];
    list[list.length - 1] = { ...list[list.length - 1], ...patch };
    messages.value = list;
  };
  controller = new AbortController();
  try {
    const res = await fetch(url('/api/ask'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q, history }), signal: controller.signal,
    });
    if (res.status === 401) { (window.top || window).location.href = '/login'; return; }
    if (!res.ok || !res.body) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `HTTP ${res.status}`); }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        if (m.t) { text += m.t; update({ content: text }); }
        if (m.error) update({ error: m.error });
        if (m.done) update({ pending: false, ms: m.ms, model: m.model });
      }
    }
    update({ pending: false });
  } catch (e) {
    update({ pending: false, error: controller.signal.aborted ? 'Stopped.' : e.message });
  } finally {
    controller = null;
  }
}

const stop = () => { if (controller) controller.abort(); };

// ---- tiny markdown: paragraphs, "- " / "1. " lists, **bold**, `code`; machine names become links
function inline(text, hosts, keyBase) {
  const parts = [];
  const re = hosts.length
    ? new RegExp(`(\\*\\*[^*]+\\*\\*|\`[^\`]+\`|\\b(?:${hosts.map((h) => h.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|')})\\b)`, 'g')
    : /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0; let k = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) parts.push(html`<b key=${keyBase + k++}>${inline(tok.slice(2, -2), hosts, `${keyBase}b${k}`)}</b>`);
    else if (tok.startsWith('`')) {
      const inner = tok.slice(1, -1);
      parts.push(hosts.includes(inner) ? html`<button key=${keyBase + k++} class="linkish host" onClick=${() => go('machines', inner)}>${inner}</button>` : html`<code key=${keyBase + k++}>${inner}</code>`);
    } else parts.push(html`<button key=${keyBase + k++} class="linkish host" onClick=${() => go('machines', tok)}>${tok}</button>`);
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function Markdown({ text, hosts }) {
  const blocks = [];
  let list = null;
  const lines = String(text || '').replace(/‑/g, '-').split('\n');
  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      const num = line.match(/^\s*(\d+)[.)]/);
      const ordered = !!num;
      if (!list || list.ordered !== ordered) { list = { ordered, start: num ? Number(num[1]) : 1, items: [] }; blocks.push(list); }
      list.items.push(html`<li key=${i}>${inline(bullet[1], hosts, `l${i}`)}</li>`);
      return;
    }
    list = null;
    if (!line.trim()) return;
    if (/^#{1,4}\s/.test(line)) { blocks.push(html`<p key=${i}><b>${inline(line.replace(/^#+\s*/, ''), hosts, `h${i}`)}</b></p>`); return; }
    blocks.push(html`<p key=${i}>${inline(line, hosts, `p${i}`)}</p>`);
  });
  return blocks.map((b, i) => (b.items ? (b.ordered ? html`<ol key=${'o' + i} start=${b.start}>${b.items}</ol>` : html`<ul key=${'u' + i}>${b.items}</ul>`) : b));
}

function Thinking({ started }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  const secs = Math.round((Date.now() - started) / 1000);
  return html`<div class="ask-thinking"><span class="ask-dots"><i></i><i></i><i></i></span>
    ${secs < 4 ? 'Reading the farm data…' : `Thinking on the local model… ${secs}s`}${secs > 20 ? html`<span class="dim"> (a full answer usually takes 20–50 s)</span>` : null}</div>`;
}

function suggestions(s) {
  const out = ['What needs attention right now?'];
  if (!s) return out;
  const dlDown = s.nodes.find((n) => { try { const d = JSON.parse(n.deadline_info || 'null'); return n.online && d && d.installed && !d.worker; } catch { return false; } });
  if (dlDown) out.push(`Why is ${dlDown.hostname} out of Deadline, and how do I fix it?`);
  const failed = s.jobs.find((j) => j.status === 'failed');
  if (failed) out.push(`Why did the install on ${failed.hostname} fail?`);
  out.push('Which machines rendered the least in the last week?');
  if ((s.rollouts || []).length) out.push('How did the last rollout go?');
  out.push('Which machines are behind on updates?');
  return out.slice(0, 5);
}

export function AskPanel() {
  const s = farm.value;
  const scroller = useRef(null);
  const input = useRef(null);
  const open = askOpen.value;
  const list = messages.value;
  const busy = list.some((m) => m.pending);
  const hosts = s ? s.nodes.map((n) => n.hostname).sort((a, b) => b.length - a.length) : [];

  // ⌘J / Ctrl+J toggles; Esc closes when focus is inside the panel.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); askOpen.value = !askOpen.value; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!open) return;
    setTimeout(() => input.current && input.current.focus(), 60);
    get('/api/ask/status').then((r) => { status.value = r; }).catch(() => { status.value = { ok: false, reason: "Can't reach the tracker" }; });
  }, [open]);
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [list]);

  if (!open) return null;
  const st = status.value;
  const submit = () => ask(draft.value);
  return html`<aside class="ask" role="complementary" aria-label="Ask the farm" onKeyDown=${(e) => { if (e.key === 'Escape' && !busy) askOpen.value = false; }}>
    <header class="ask-head">
      <span class="ask-mark"><${Icon} name="sparkle" /></span>
      <div class="grow"><b>Ask the farm</b>
        <span class=${'ask-status ' + (st ? (st.ok ? 'ok' : 'bad') : '')} title=${st && st.models ? `Available: ${st.models.join(', ')}` : ''}>
          ${!st ? 'Checking the local model…' : st.ok ? html`<i></i>Local AI · ${st.model} · nothing leaves the farm` : html`<i></i>${st.reason}`}</span></div>
      ${list.length ? html`<button class="btn ghost sm" disabled=${busy} onClick=${() => { messages.value = []; }} title="Start a new conversation">New</button>` : null}
      <button class="btn ghost icon" aria-label="Close" title="Close (⌘J)" onClick=${() => { askOpen.value = false; }}><${Icon} name="close" /></button>
    </header>
    <div class="ask-body" ref=${scroller}>
      ${!list.length ? html`<div class="ask-empty">
        <p class="muted">Ask anything about the farm — machines, Deadline, installs, rollouts, the last week. Answers come from the tracker's own data.</p>
        <div class="ask-sugs">${suggestions(s).map((q) => html`<button key=${q} class="ask-sug" onClick=${() => ask(q)}><${Icon} name="sparkle" />${q}</button>`)}</div>
      </div>` : list.map((m, i) => (m.role === 'user'
        ? html`<div key=${i} class="ask-msg user">${m.content}</div>`
        : html`<div key=${i} class="ask-msg bot">
            ${m.content ? html`<div class="ask-md"><${Markdown} text=${m.content} hosts=${hosts} />${m.pending ? html`<span class="ask-caret"></span>` : null}</div>` : m.pending ? html`<${Thinking} started=${m.started} />` : null}
            ${m.error ? html`<div class="banner bad" style="margin-top:6px"><${Icon} name="alert" />${m.error}</div>` : null}
            ${!m.pending && m.ms ? html`<div class="ask-meta">${Math.round(m.ms / 1000)}s · ${m.model} · check anything important on the machine itself</div>` : null}
          </div>`))}
    </div>
    <footer class="ask-foot">
      <textarea ref=${input} class="field" rows="2" placeholder="Ask about a machine, Deadline, installs…" value=${draft.value}
        onInput=${(e) => { draft.value = e.currentTarget.value; }}
        onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}></textarea>
      ${busy ? html`<button class="btn" onClick=${stop} title="Stop"><${Icon} name="stop" />Stop</button>`
        : html`<button class="btn primary" disabled=${!draft.value.trim()} onClick=${submit} title="Send (Enter)"><${Icon} name="send" />Ask</button>`}
    </footer>
  </aside>`;
}

// Keyboard hint for the sidebar button
export const askShortcut = () => (navigator.platform && /Mac/.test(navigator.platform) ? '⌘J' : 'Ctrl J');
