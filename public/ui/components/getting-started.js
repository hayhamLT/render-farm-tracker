// Adding a machine to the farm — the one thing someone needs on their first day here.
// Everything else the tracker does is explained by its own help topic, so this stays a single
// task: run one file on the machine, and it shows up. The file installs the agent and sets up
// silent installs in the same step, so there is no second thing to do afterwards.
import { html } from '../lib/html.js';
import { useEffect, useState } from 'preact/hooks';
import { farm } from '../lib/store.js';
import { get, post } from '../lib/api.js';
import { go } from '../lib/router.js';
import { toast } from '../lib/ui.js';
import { Icon } from './common.js';

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

export function GettingStarted() {
  const s = farm.value;
  const [setup, setSetup] = useState(null);
  const [files, setFiles] = useState(null);
  const [busy, setBusy] = useState(false);
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

  return html`<div class="stack" style="gap:16px">
    <p style="margin:0">Run one file on the machine. It installs the agent, which reports what's
      installed and runs your updates — and it sets up silent installs at the same time, so
      nothing stops later to ask permission.</p>

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

    <p class="dim" style="margin:0">The machine appears under <button class="linkish" onClick=${() => go('machines')}>Machines</button> within a minute of running it.</p>
  </div>`;
}
