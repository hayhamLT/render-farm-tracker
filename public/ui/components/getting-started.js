// Getting started: a live checklist, not a leaflet. Every step reads the farm's real state
// (machines enrolled, machines that can install silently, apps watched, updates waiting) and
// carries the button that does the thing — save the installer files, copy a command, check for
// versions, open Updates.
import { html } from '../lib/html.js';
import { useEffect, useState } from 'preact/hooks';
import { farm } from '../lib/store.js';
import { get, post } from '../lib/api.js';
import { go } from '../lib/router.js';
import { toast } from '../lib/ui.js';
import { plural } from '../lib/format.js';
import { normalizeProducts, isTracked } from '../lib/domain.js';
import { canUpdate, updateTargets } from '../lib/updater.js';
import { Icon, OsStatus } from './common.js';
import { askOpen } from './ask.js';

function Copy({ label, text }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1800); } catch { toast('Copy failed — select the text instead.', 'error'); }
  };
  return html`<div class="gs-cmd">
    <span class="dim">${label}</span>
    <code>${text}</code>
    <button class="btn sm" onClick=${copy}><${Icon} name=${done ? 'check' : 'copy'} />${done ? 'Copied' : 'Copy'}</button>
  </div>`;
}

function Step({ n, title, state, summary, children, open, onToggle }) {
  const tone = state === 'done' ? 'done' : state === 'partial' ? 'partial' : 'todo';
  return html`<section class=${'gs-step ' + tone + (open ? ' open' : '')}>
    <button class="gs-head" onClick=${onToggle} aria-expanded=${open}>
      <span class="gs-num">${state === 'done' ? html`<${Icon} name="check" />` : n}</span>
      <span class="gs-title"><b>${title}</b><span class="dim">${summary}</span></span>
      <span class=${'tag ' + (tone === 'done' ? 'ok' : tone === 'partial' ? 'warn' : 'info')}>${state === 'done' ? 'Done' : state === 'partial' ? 'Partly done' : 'To do'}</span>
      <${Icon} name="chevronDown" cls=${open ? 'flip-v' : ''} />
    </button>
    ${open ? html`<div class="gs-body">${children}</div>` : null}
  </section>`;
}

export function GettingStarted() {
  const s = farm.value;
  const [setup, setSetup] = useState(null);
  const [files, setFiles] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  useEffect(() => {
    get('/api/agent-setup').then(setSetup).catch(() => setSetup({}));
    get('/api/enroll-files').then(setFiles).catch(() => {});
  }, []);
  if (!s) return null;

  const url = (setup && setup.lanUrl) || '';
  const saveFiles = async () => {
    setBusy(true);
    try { const r = await post('/api/enroll-files'); setFiles(r); toast('Installer files saved to the share.', 'success'); } catch (e) { toast(e.message, 'error', 8000); }
    setBusy(false);
  };
  const machines = s.nodes.length;
  const notReady = s.nodes.filter((n) => n.elevated === 0);
  const products = normalizeProducts(s).filter(isTracked);
  const updatable = products.filter(canUpdate);
  const updates = updatable.reduce((c, p) => c + updateTargets(s, p).length, 0);
  const installedEver = s.jobs.some((j) => j.status === 'success');

  const steps = [
    {
      key: 'enroll',
      title: 'Add your machines',
      state: machines ? 'done' : 'todo',
      summary: machines ? `${plural(machines, 'machine')} reporting in` : 'No machines yet',
      body: () => html`<div class="stack" style="gap:12px">
        <p style="margin:0">Run one file on each machine. It installs the agent that reports what's installed and runs your updates — and sets up silent installs at the same time.</p>
        <div class="gs-files">
          <div><b>Windows</b><span class="dim">double-click, then click <b>Yes</b> on the admin prompt</span><code>Install Tracker Agent - Windows.cmd</code></div>
          <div><b>Mac</b><span class="dim">double-click, then type the Mac's admin password</span><code>Install Tracker Agent - Mac.command</code></div>
        </div>
        <div class="row" style="gap:8px">
          ${files && files.exists
            ? html`<span class="gs-saved"><${Icon} name="check" />On the share: <span class="mono">${files.dir}</span></span>
                   ${files.smb ? html`<a class="btn sm" href=${files.smb}><${Icon} name="folder" />Open folder</a>` : null}
                   <button class="btn ghost sm" disabled=${busy} onClick=${saveFiles}><${Icon} name=${busy ? 'spinner' : 'refresh'} cls=${busy ? 'spin' : ''} />Save again</button>`
            : html`<button class="btn primary" disabled=${busy} onClick=${saveFiles}><${Icon} name=${busy ? 'spinner' : 'folder'} cls=${busy ? 'spin' : ''} />Save both files to the share</button>
                   <span class="dim">They go in the installer share, in a “Tracker Agent” folder.</span>`}
        </div>
        <details class="gs-more"><summary>No share on that machine? Paste a command instead</summary>
          <div class="stack" style="gap:8px;margin-top:8px">
            <${Copy} label="Windows (admin PowerShell)" text=${`irm ${url}/elevate.ps1 | iex`} />
            <${Copy} label="macOS (Terminal)" text=${`curl -fsSL ${url}/setup.sh | sudo bash`} />
          </div>
        </details>
        ${machines ? html`<p class="dim" style="margin:0">A machine appears under <button class="linkish" onClick=${() => go('machines')}>Machines</button> within a minute of running it.</p>` : null}
      </div>`,
    },
    {
      key: 'ready',
      title: 'Let installs run without prompts',
      state: !machines ? 'todo' : notReady.length ? 'partial' : 'done',
      summary: !machines ? 'After the first machine' : notReady.length ? `${notReady.length} of ${machines} still ask for permission` : `All ${machines} machines install silently`,
      body: () => html`<div class="stack" style="gap:12px">
        <p style="margin:0">Installers must run without a Windows admin prompt or a macOS password box, otherwise an update sits and waits for someone at the keyboard. The one-click file above already does this. A machine that was added another way may still need it.</p>
        ${notReady.length ? html`<div class="banner warn"><${Icon} name="shieldOff" /><div class="grow"><b>${plural(notReady.length, 'machine')} not set up yet</b>
          <div class="gs-hosts">${notReady.slice(0, 12).map((n) => html`<button key=${n.id} class="gs-host" onClick=${() => go('machines', n.hostname)}><${OsStatus} node=${n} />${n.hostname}</button>`)}${notReady.length > 12 ? html`<span class="dim">+${notReady.length - 12} more</span>` : null}</div></div></div>`
          : machines ? html`<div class="banner info"><${Icon} name="check" />Every machine can install silently.</div>` : null}
        <${Copy} label="Windows (admin PowerShell)" text=${`irm ${url}/elevate.ps1 | iex`} />
        <${Copy} label="macOS (Terminal)" text=${`curl -fsSL ${url}/setup.sh | sudo bash`} />
      </div>`,
    },
    {
      key: 'apps',
      title: 'Check the apps being watched',
      state: products.length ? 'done' : 'todo',
      summary: `${plural(products.length, 'app')} watched${updatable.length < products.length ? ` · ${products.length - updatable.length} tracked only` : ''}`,
      body: () => html`<div class="stack" style="gap:12px">
        <p style="margin:0">The tracker already watches Cinema 4D, Redshift, Red Giant, After Effects, Maxon App, Blender, FFmpeg, NotchLC and the NVIDIA driver. Add your own apps, After Effects plug-ins or scripts, and it will track and install them too.</p>
        <div class="gs-chips">${products.slice(0, 12).map((p) => html`<span key=${p.key} class="current-chip"><span class="mono dim">${p.latest_version || '—'}</span>${p.name}</span>`)}</div>
        <div class="row" style="gap:8px">
          <button class="btn" onClick=${() => go('catalog')}><${Icon} name="package" />Open Apps</button>
          <span class="dim">Add an app, turn one off, or switch on auto-deploy.</span>
        </div>
      </div>`,
    },
    {
      key: 'update',
      title: 'Run your first update',
      state: installedEver ? 'done' : updates ? 'todo' : 'done',
      summary: updates ? `${plural(updates, 'update')} waiting` : installedEver ? 'Updates have run from here' : 'Nothing is behind right now',
      body: () => html`<div class="stack" style="gap:12px">
        <p style="margin:0">Open <b>Farm</b>, press <b>Update all</b> — or tick a few apps, or open one app and choose machines. You always get a review step first: what installs where, what will make it wait, and whether it runs now or tonight.</p>
        <ul style="margin:0;padding-left:18px">
          <li>Installs never start under a render, and each machine does one at a time.</li>
          <li>A new version tries 3 machines first; if those fail, the rest is paused.</li>
          <li>Offline machines pick their update up when they're back.</li>
        </ul>
        <div class="row" style="gap:8px">
          <button class="btn primary" onClick=${() => go('updates')}><${Icon} name="download" />${updates ? `Open Updates (${updates} waiting)` : 'Open Updates'}</button>
          <button class="btn" onClick=${() => go('history')}><${Icon} name="activity" />See past installs</button>
        </div>
      </div>`,
    },
    {
      key: 'notify',
      title: 'Get told when something needs you',
      state: s.slackWebhook ? 'done' : 'todo',
      summary: s.slackWebhook ? 'Slack connected' : 'Optional — desktop alerts and Slack',
      body: () => html`<div class="stack" style="gap:12px">
        <p style="margin:0">Alerts are optional. Desktop alerts pop up on this computer when a rollout finishes, an install fails, a machine goes offline or drops out of Deadline. Slack gets the same, plus a report at the end of each rollout.</p>
        <div class="row" style="gap:8px">
          <button class="btn" onClick=${() => go('settings')}><${Icon} name="bell" />Set up alerts</button>
          <button class="btn" onClick=${() => { askOpen.value = true; }}><${Icon} name="sparkle" />Try “Ask the farm”</button>
        </div>
      </div>`,
    },
  ];

  const done = steps.filter((x) => x.state === 'done').length;
  const pct = Math.round((done / steps.length) * 100);
  return html`<div class="stack" style="gap:14px">
    <div class="gs-progress">
      <div class="gs-bar"><i style=${`width:${pct}%`}></i></div>
      <span><b>${done}</b> of ${steps.length} done</span>
    </div>
    ${steps.map((x, i) => html`<${Step} key=${x.key} n=${i + 1} title=${x.title} state=${x.state} summary=${x.summary}
      open=${(open ?? steps.findIndex((y) => y.state !== 'done')) === i} onToggle=${() => setOpen(open === i ? -1 : i)}>
      ${x.body()}
    </${Step}>`)}
  </div>`;
}
