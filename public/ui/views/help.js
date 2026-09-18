// Help: how the tracker works, written for the people running the farm.
import { html } from '../lib/html.js';
import { pref } from '../lib/ui.js';
import { go } from '../lib/router.js';
import { AGENT_NAME } from '../lib/domain.js';
import { Icon, Badge } from '../components/common.js';
import { PageHeader } from '../components/page.js';
import { GettingStarted } from '../components/getting-started.js';

const topic = pref('help.topic', 'start');

const TOPICS = [
  ['start', 'Getting started', 'beacon'],
  ['updates', 'Updating machines', 'download'],
  ['schedule', 'Scheduling & rollouts', 'clock'],
  ['apps', 'Apps & installers', 'package'],
  ['machines', 'Machines, power & Deadline', 'server'],
  ['alerts', 'Alerts & Ask the farm', 'bell'],
  ['keys', 'Keyboard shortcuts', 'command'],
  ['trouble', 'Troubleshooting', 'alert'],
];

const QA = ({ q, children }) => html`<details class="qa"><summary>${q}</summary><div>${children}</div></details>`;

const CONTENT = {
  start: () => html`<${GettingStarted} />`,
  updates: () => html`
    <p>New versions are found automatically (Maxon, Adobe, Blender, FFmpeg, NotchLC, NVIDIA, and anything you add with a version check). <b>Farm → Updates</b> lists every app that's behind, its version jump, how many machines are current, and whether its installer is ready.</p>
    <ul>
      <li><b>Update all</b> — every app on every machine that's behind.</li>
      <li><b>A few apps</b> — tick their checkboxes and press <b>Update selected</b>.</li>
      <li><b>Chosen machines</b> — click an app to open its machine list and pick exactly which get it (shortcuts: all, online &amp; idle only, none).</li>
      <li><b>One machine</b> — switch to <b>Machines</b> (same page, second lens), select machines and press <b>Update everything</b>, or open a machine and use the Update button next to a single app.</li>
    </ul>
    <p>Every one of those opens the same review step: what installs where, anything that will make it wait, and when it runs.</p>
    <ul>
      <li><b>Every idle machine installs at once.</b> Installers stream from the tracker over the LAN, one install at a time per machine.</li>
      <li><b>New versions test first:</b> until one machine installs a version successfully, at most 3 try it. If those fail the rollout pauses, so a broken update never reaches the whole farm.</li>
      <li><b>Never under a render.</b> An install waits while Cinema 4D, Redshift, After Effects or Blender is rendering, or while the GPU is busy, and starts by itself afterwards.</li>
      <li><b>Status is verified.</b> A job succeeds when the machine reports the new version, not because the installer exited cleanly. A failure says why, e.g. <${Badge} tone="bad">failed · reboot needed<//>.</li>
      <li><b>Stop really stops.</b> Stopping a running job kills the installer and everything it started on the machine.</li>
    </ul>
    <${QA} q="Patch vs. new major">A patch (2026.3.0 → 2026.3.4) replaces the installed version and is what "Update" does. A new major (2026 → 2027) installs side by side and is opt-in, under "New major versions", so existing scenes keep working.<//>
    <${QA} q="“No installer yet”">The new version's installer isn't on the share. With a saved download link the tracker fetches it once (the app shows "Downloads first"); otherwise add the installer or a link in <b>Apps</b>.<//>
    <${QA} q="NVIDIA drivers">Driver updates are always in-place. GTX 9xx/10xx cards stay on NVIDIA's legacy driver track, so they're never flagged behind the current driver. A pending Windows restart blocks the driver installer — restart first.<//>
    <${QA} q="After Effects">After Effects updates through Adobe Remote Update Manager (together with Media Encoder). RUM only patches within a major; a new major needs a full install from the Adobe Admin Console.<//>
    <${QA} q="Creative Cloud">Adobe publishes no per-version installer for the Creative Cloud desktop app, so "Update" here restarts Adobe's own updater on each machine and Adobe applies the update from there — the new build shows up on the next check-in, not immediately. "Behind" means older than the newest build on the farm <b>for that OS</b> (Adobe numbers Windows and Mac builds differently). If a machine still won't move, reinstall the Creative Cloud app with <b>Install a specific version…</b>.<//>
    <${QA} q="Installing a specific version">Updates → <b>Install a specific version…</b> picks the installer yourself: a file on the share, a saved or pasted download link, and the exact machines.<//>`,
  schedule: () => html`
    <p>In the review step, <b>When</b> decides if the update runs now or later:</p>
    <ul>
      <li><b>Now</b> — every machine starts as soon as it's free.</li>
      <li><b>Tonight</b> — defaults to 2:00 AM, with a <b>finish by</b> time (default 6:00 AM).</li>
      <li><b>Pick a time</b> — any date and time.</li>
    </ul>
    <ul>
      <li><b>Only on idle machines</b> (on by default) — a machine starts its install when its GPU isn't busy.</li>
      <li><b>Wake sleeping machines first</b> — machines that are off or asleep get a Wake-on-LAN at the start. A scheduled rollout also includes machines that are offline when you schedule it.</li>
      <li><b>Unfinished machines continue next night</b> — at the finish-by time, installs already running finish; machines that didn't get their turn wait for the next night, up to a week. What never ran is listed in the report.</li>
      <li><b>Slack report when done</b> — a summary of what installed and what failed (needs a webhook in Settings).</li>
    </ul>
    <p>Scheduled and running rollouts appear at the top of Updates with a countdown, <b>Start now</b> and <b>Cancel</b>. Finished ones, with their results, are under <button class="linkish" onClick=${() => go('history')}>History → Rollouts</button>; every install with its log, plus Retry and Stop, is under History → Installs.</p>
    <p class="dim">Apps can also update themselves without you: turn on <b>Auto-deploy</b> for an app in Apps. Those rollouts respect the auto-deploy window in Settings.</p>`,
  apps: () => html`
    <p><b>Apps</b> is the catalog: what the tracker watches, where new versions come from, and the installers on the share.</p>
    <ul>
      <li><b>Add</b> tracks any app, After Effects plug-in or script. A name and a link are usually enough — Auto-fill finds the icon, version and installer.</li>
      <li>Apps are detected by installed name or by a file path (globs allowed); plug-ins and scripts are found in After Effects' folders from their name.</li>
      <li>Add a silent install command (<code>{file}</code> = the installer) to deploy it; add an uninstall command to remove it from machines.</li>
      <li><b>Track</b> hides an app from the dashboard without forgetting it. <b>Auto-deploy</b> installs new versions everywhere by itself, testing on 3 machines first.</li>
    </ul>
    <p><b>Apps → Installers</b> is the installer library on the share:</p>
    <ul>
      <li><b>Organize into app folders</b> moves each installer into a folder named after its app. You see every move first, and files the tracker doesn't recognise are never touched.</li>
      <li><b>Clean up</b> lists installers older than what each app installs now and unused by any queued or running install. You pick what goes and confirm; nothing is deleted automatically.</li>
      <li>Downloads always land on the share, never on the tracker's own disk. If the share isn't mounted, downloads stop with a message instead.</li>
    </ul>`,
  machines: () => html`
    <p><b>Farm → Machines</b> shows each machine from the update point of view: what it's behind on, when it last updated, and a status — but only what matters for updating.</p>
    <ul>
      <li><span class="tag bad">Offline</span> — no check-in for ~3 minutes; its updates wait until it's back.</li>
      <li><span class="tag violet">Rendering</span> — installs wait until it's idle.</li>
      <li><span class="tag warn">Restart pending</span> — Windows is waiting for a restart; driver installs won't run until then.</li>
      <li><span class="tag warn">Not set up</span> — the elevate step hasn't been run, so installs would stop at a prompt.</li>
    </ul>
    <p><b>Power</b> — from a machine's menu or the selection bar:</p>
    <ul>
      <li><b>Restart</b> goes through the agent (or Deadline if the agent is unreachable) and interrupts any render.</li>
      <li><b>Shut down</b> powers a Windows machine fully off. Macs are put to sleep instead — a shut-down Mac can't be woken over the network.</li>
      <li><b>Wake</b> sends Wake-on-LAN from the tracker and from up to 3 online machines on the same network, and reports when the machine is back, or why not.</li>
    </ul>
    <p><b>Deadline</b> — the tracker isn't a render manager, so it only flags <span class="tag bad">Deadline down</span>: the machine is on, but its Deadline Worker isn't running, so it takes no renders. On Windows, <b>Fix Deadline startup</b> registers the Launcher to start at the desktop user's logon, turns on "start the Worker with the Launcher" — in the machine-wide <i>and</i> that user's own settings — and starts it now. The machine needs automatic login for Deadline to come back after a restart. Macs are handled by their own Deadline Watchdog.</p>
    <${QA} q="Wake doesn't turn a machine on">The agent sets up each wired network card (wake on magic packet, wake from shutdown, Energy-Efficient Ethernet off). What it can't change is the BIOS: enable <b>Wake on LAN</b> / <b>Power On by PCIe</b> and disable <b>ErP/EuP</b> deep power-saving. Add-in 10G cards often can't wake a PC from full shutdown — cable the onboard port.<//>`,
  alerts: () => html`
    <p><b>Desktop alerts</b> (Settings → Desktop alerts) pop up on your computer while the dashboard is open in a tab, even when you're in another app. When you're looking at the dashboard they appear as a message in the corner instead. It's a per-browser setting, and you can switch off any of the four kinds:</p>
    <ul>
      <li>a rollout starts, pauses for the night or finishes,</li>
      <li>a machine drops out of Deadline,</li>
      <li>a machine goes offline,</li>
      <li>an install fails.</li>
    </ul>
    <p><b>Ask the farm</b> (the sidebar button, or ⌘J) answers questions about the farm in plain English — "what needs attention?", "why did the install on MARS-02 fail?", "which machines are behind?". It uses the local AI model on the tracker server, so nothing leaves the building, and it only sees the tracker's own data: machine states, timelines, rollouts, jobs and logs. Answers take 20–50 seconds, and machine names in them are clickable. It's a small model — check anything important on the machine itself.</p>
    <p><b>Slack</b> (Settings → Slack alerts) posts failed installs, paused rollouts and rollout reports to a webhook.</p>`,
  keys: () => html`
    <table class="table" style="max-width:520px"><tbody>
      ${[['⌘K / Ctrl K', 'Search machines, apps and actions'], ['⌘J / Ctrl J', 'Ask the farm'], ['/', 'Search machines'],
        ['g then u', 'Farm → Updates'], ['g then m', 'Farm → Machines'], ['g then h', 'Farm → History'], ['g then a', 'Apps'], ['g then s', 'Settings'],
        ['Esc', 'Close panel · clear selection']]
        .map(([k, d]) => html`<tr key=${k}><td class="nowrap"><span class="kbd">${k}</span></td><td>${d}</td></tr>`)}
    </tbody></table>`,
  trouble: () => html`
    <${QA} q="A machine shows offline">"Offline" means no check-in for ~3 minutes. The tracker also probes it: if the machine still answers on the network it says <span class="tag warn">On, agent silent</span> instead — the machine is up but its agent isn't reporting (it didn't come back after a restart, or its scheduled task was removed). Fix it by running the one-click installer on that machine again; it reinstalls and starts the agent in one go. If nothing answers, it's really off — use Wake.<//>
    <${QA} q="An agent didn't come back after a restart">The Windows agent runs as a scheduled task (SYSTEM, at startup and every 5 minutes) and the Mac agent as a root LaunchDaemon, so it normally returns on its own. It won't if that task/daemon was removed, or its Python moved (a Deadline upgrade can do this). Running the one-click installer again restores it. A machine on Wi-Fi that logs in nobody can also have no network until someone logs in.<//>
    <${QA} q="A job failed with “reboot needed”">Windows has updates waiting on a restart and the installer refuses to run. Restart the machine, then Retry (Farm → History → Installs, or the machine's details).<//>
    <${QA} q="A job says the machine stopped running it">The download or install ended without its result reaching the tracker (e.g. the agent restarted). Retry — if the software did install, the job corrects itself to success on the next check-in. Each agent keeps a log at C:\\ProgramData\\TrackerAgent\\agent.log.<//>
    <${QA} q="An update never runs on a machine">Open Farm → History → Installs: the job says what it's waiting for — a render to finish, the machine to come back online, elevation, its own current install, or a scheduled start time.<//>
    <${QA} q="An app says “No installer yet”">Its installer isn't on the share for that OS. Add it in Apps (a link the tracker downloads once, or the file itself), then update again.<//>
    <${QA} q="Downloads fail / installers can't be found">The installer share isn't mounted on the tracker server. Settings → Installer downloads shows a warning when that's the case; installers are never written to the server's own disk.<//>
    <${QA} q="Restoring the database">Backups are in ~/tracker-backups (startup and nightly). Stop the tracker and run <code>./restore-db.sh</code> (newest) or <code>./restore-db.sh path/to/backup.db</code>.<//>`,
};

export function HelpView() {
  return html`<div class="page"><${PageHeader} title="Help" subtitle="How the tracker works, and what to do when something looks wrong." /><div class="help">
    <aside class="help-nav">${TOPICS.map(([k, l, i]) => html`<button key=${k} class=${topic.value === k ? 'on' : ''} onClick=${() => { topic.value = k; }}><${Icon} name=${i} />${l}</button>`)}</aside>
    <article class="card card-pad help-body"><h1>${(TOPICS.find((t) => t[0] === topic.value) || TOPICS[0])[1]}</h1>${(CONTENT[topic.value] || CONTENT.start)()}</article>
  </div></div>`;
}
