// Help: how the tracker works, written for the people running the farm.
import { html } from '../lib/html.js';
import { pref } from '../lib/ui.js';
import { go } from '../lib/router.js';
import { AGENT_NAME } from '../lib/domain.js';
import { Icon, Badge } from '../components/common.js';
import { PageHeader } from '../components/page.js';

const topic = pref('help.topic', 'start');

const TOPICS = [
  ['start', 'Getting started', 'beacon'],
  ['updates', 'How updates work', 'download'],
  ['deadline', 'Deadline health', 'film'],
  ['power', 'Restart, shut down, wake', 'power'],
  ['custom', 'Your own apps & scripts', 'package'],
  ['keys', 'Keyboard shortcuts', 'command'],
  ['trouble', 'Troubleshooting', 'alert'],
];

const QA = ({ q, children }) => html`<details class="qa"><summary>${q}</summary><div>${children}</div></details>`;

const CONTENT = {
  start: () => html`
    <p>Every render machine runs the <b>${AGENT_NAME}</b> agent. It reports installed software, GPU, disk and Deadline status, installs updates you queue, and updates itself.</p>
    <ol>
      <li><b>Enroll</b> the machine with the command from <button class="linkish" onClick=${() => go('settings')}>Settings → Enroll a machine</button>. It appears under Machines within a minute.</li>
      <li><b>Elevate</b> it once (the admin command). Without this, installs stop at a Windows UAC or macOS password prompt — the machine shows <${Badge} tone="warn" icon="shieldOff">not ready<//>.</li>
      <li>Check its <b>Deadline</b> badge. If it says the Worker won't start after a restart, click it to fix.</li>
    </ol>`,
  updates: () => html`
    <p>New versions are detected automatically (Maxon, Adobe, Blender, FFmpeg, NotchLC, NVIDIA, and any app you add with a version check). Machines behind show a blue version chip.</p>
    <ul>
      <li><b>Every idle machine installs at once.</b> Installers stream from the tracker over the LAN, one job per machine.</li>
      <li><b>New versions test first:</b> until one machine installs a version successfully, at most 3 try it. If those fail, the rollout pauses — a broken update never reaches the whole farm.</li>
      <li><b>Never under a render.</b> An install waits while Cinema 4D, Redshift, After Effects or Blender is rendering, or while the GPU is busy, and starts by itself afterwards.</li>
      <li><b>Status is verified.</b> A job succeeds when the machine reports the new version — not just because the installer exited cleanly. A failed job says why, e.g. <${Badge} tone="bad">failed · reboot needed<//>.</li>
      <li><b>Stop really stops.</b> Stopping a running job kills the installer and everything it started on the machine.</li>
    </ul>
    <${QA} q="Patch vs. new major">A patch (e.g. 2026.3.0 → 2026.3.4) replaces the installed version. A new major (2026 → 2027) installs side-by-side and is opt-in, so existing scenes keep working.<//>
    <${QA} q="“Installer needed”">A newer version exists but its installer isn't on the tracker yet. With a saved download link, Automatic fetches it once; otherwise paste a link or drop the installer in the installer folder.<//>
    <${QA} q="NVIDIA drivers">Driver updates are always in-place. GTX 9xx/10xx cards stay on NVIDIA's legacy driver track, so they're never flagged behind the current driver. A pending Windows restart blocks the driver installer — restart first.<//>
    <${QA} q="After Effects">After Effects updates through Adobe Remote Update Manager (together with Media Encoder). RUM only patches within a major; a new major needs a full install from the Adobe Admin Console.<//>`,
  deadline: () => html`
    <p>A machine can be online in the tracker but out of the Deadline farm. The agent checks every 5 minutes:</p>
    <ul>
      <li><${Badge} tone="bad">Deadline down<//> — the Worker isn't running, so the machine takes no renders.</li>
      <li><${Badge} tone="warn">No auto-start<//> — Deadline runs now, but nothing starts it after a restart (it was started by hand). The next reboot drops the machine out of the farm.</li>
    </ul>
    <p><b>Fix Deadline startup</b> (Windows) registers the Deadline Launcher to start whenever the machine's desktop user logs in — in that user's own session, like starting it by hand, so shares and licences work normally, with no password — turns on "start the Worker with the Launcher", and starts it now. The machine needs automatic login (or someone logged in) for Deadline to come back after a restart.</p>
    <p>Macs are kept running by their Deadline Watchdog; the fix button is Windows-only.</p>`,
  power: () => html`
    <ul>
      <li><b>Restart</b> goes through the agent (or Deadline if the agent is unreachable). It interrupts any render.</li>
      <li><b>Shut down</b> powers a Windows machine fully off. Macs are put to sleep instead — a shut-down Mac can't be woken over the network.</li>
      <li><b>Wake</b> sends Wake-on-LAN from the tracker and from up to 3 online machines on the same network, repeats it, and tells you when the machine is back — or after 5 minutes, why not.</li>
    </ul>
    <${QA} q="Wake doesn't turn a machine on">The agent sets up each wired network card (wake on magic packet, wake from shutdown, Energy-Efficient Ethernet off). What it can't change is the BIOS: enable <b>Wake on LAN</b> / <b>Power On by PCIe</b> and disable <b>ErP/EuP</b> deep power-saving. Add-in 10G cards often can't wake a PC from full shutdown — cable the onboard port. Hover a machine's Wake action to see whether its card is ready.<//>`,
  custom: () => html`
    <p>Catalog → <b>Add</b> tracks any app, After Effects plug-in or script. A name and a link are usually enough: Auto-fill finds the icon, version and installer.</p>
    <ul>
      <li>Apps are detected by installed name or by a file path (globs allowed).</li>
      <li>Plug-ins and scripts are found in After Effects' folders automatically from their name.</li>
      <li>Add a silent install command (<code>{file}</code> = the installer) to deploy it; add an uninstall command to remove it from machines.</li>
      <li>Turn on <b>Auto-deploy</b> to install new versions everywhere automatically, testing on 3 machines first.</li>
    </ul>`,
  keys: () => html`
    <table class="table" style="max-width:520px"><tbody>
      ${[['⌘K / Ctrl K', 'Search machines, apps and actions'], ['/', 'Search machines'], ['g then m', 'Machines'], ['g then o', 'Overview'], ['g then u', 'Updates'], ['g then a', 'Activity'], ['g then c', 'Catalog'], ['g then s', 'Settings'], ['Esc', 'Close panel · clear selection']]
        .map(([k, d]) => html`<tr key=${k}><td class="nowrap"><span class="kbd">${k}</span></td><td>${d}</td></tr>`)}
    </tbody></table>`,
  trouble: () => html`
    <${QA} q="A machine shows offline">It's offline after ~3 minutes without a check-in. If it's actually on, its agent restarts itself within minutes (the scheduled task relaunches it). If it's powered off, use Wake.<//>
    <${QA} q="A job failed with “reboot needed”">Windows has updates waiting on a restart and the installer refuses to run. Restart the machine (check the Deadline badge first), then Retry.<//>
    <${QA} q="A job says the machine stopped running it">The download or install ended without its result reaching the tracker (e.g. the agent restarted). Retry — if the software did install, the job corrects itself to success on the next check-in. Each agent keeps a log at C:\\ProgramData\\TrackerAgent\\agent.log.<//>
    <${QA} q="An update never runs on a machine">Check the job's status: waiting for a render to finish, machine offline, not elevated, or waiting for its current job. Queued jobs say which.<//>
    <${QA} q="Restoring the database">Backups are in ~/tracker-backups (startup and nightly). Stop the tracker and run <code>./restore-db.sh</code> (newest) or <code>./restore-db.sh path/to/backup.db</code>.<//>`,
};

export function HelpView() {
  return html`<div class="page"><${PageHeader} title="Help" subtitle="How the tracker works, and what to do when something looks wrong." /><div class="help">
    <aside class="help-nav">${TOPICS.map(([k, l, i]) => html`<button key=${k} class=${topic.value === k ? 'on' : ''} onClick=${() => { topic.value = k; }}><${Icon} name=${i} />${l}</button>`)}</aside>
    <article class="card card-pad help-body"><h1>${(TOPICS.find((t) => t[0] === topic.value) || TOPICS[0])[1]}</h1>${(CONTENT[topic.value] || CONTENT.start)()}</article>
  </div></div>`;
}
