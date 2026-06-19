# Render Farm Update Tracker

A self-hosted web app for monitoring and deploying software updates across a
mixed Windows/macOS render farm. Tracks **Cinema 4D, Redshift, Red Giant, After
Effects, Blender, FFmpeg, NotchLC, NVIDIA Studio drivers** and the Creative
Cloud / Maxon manager apps — shows each node's installed vs. latest version and
rolls out updates with progress, retries, and a failure circuit breaker.

- **Zero dependencies** — the server is plain Node.js (**≥ 22.5**, uses the
  built-in `node:sqlite` module). No `npm install`, no build step.
- **One agent script** — a stdlib-only Python 3 script (`agents/render_agent.py`)
  runs on every node, Windows and macOS alike. It self-updates from the server.

```
┌─────────────┐   check-in (poll)       ┌──────────────────────┐
│ render node │ ──────────────────────▶ │  tracker server      │
│  ("Beacon"  │ ◀── queued jobs ─────── │  node server.js      │
│   agent.py) │ ──── job status ──────▶ │  dashboard :4400     │
│             │ ◀── installer files ─── │  + SQLite tracker.db │
└─────────────┘                         └──────────────────────┘
```

The UI has six tabs: **Dashboard** (per-node software versions + actions),
**Updates** (deploy wizard + recent jobs), **Fleet** (live NOC view: what every
machine is doing, agent rollout, GPU/driver/disk health, alerts), **Activity**
(event log), **Catalog** (product/version config + settings), **Help**.

---

## 👋 Handing this off / integrating into a bigger app

**Start with [`HANDOFF.md`](HANDOFF.md).** It is the engineering reference:
architecture, component/file map, the SQLite data model, the **full HTTP API
reference**, configuration & hard-coded assumptions, a step-by-step
**"merging onto a custom domain / mounting under a bigger app"** guide
(reverse proxy, `X-Forwarded-*`, the agent re-pointing gotcha, sub-path
mounting), the **security must-fix list** before exposing beyond the LAN, and a
final **merge checklist**.

Integration in one line: everything the UI needs comes from a single polled
endpoint, **`GET /api/state`** (denormalized JSON snapshot). External consumers
should call the API, never read `tracker.db` directly — many fields (`online`,
`dl_pct`, job progress) are computed per-request and don't exist as columns.

---

## After cloning (what's gitignored)

These are intentionally **not** in the repo (secrets / state / large binaries) —
see `.gitignore`:

| Path | What it is | How to recreate |
|---|---|---|
| `config.json` | port + plaintext **agent key** + Slack webhook | **Auto-generated on first `node server.js`** (key printed to console). See `config.example.json` for the shape. |
| `tracker.db*` | SQLite state (nodes, jobs, history) | Created empty on first run. |
| `installers/` | staged installer binaries (large / licensed) | Drop files in per deployment. |
| `.claude/` | local editor/tooling settings | n/a |

Requires **Node ≥ 22.5** and **Python 3.8+** on the nodes.

---

## 1. Start the server

```sh
node server.js
```

- Dashboard: **http://localhost:4400** (LAN: `http://<this-machine>:4400`).
- First start writes `config.json` with a generated **agent key** (printed to
  the console; also at `GET /api/agent-setup`).
- State lives in `tracker.db`. Delete it to start fresh.

Keep it running with a LaunchAgent/systemd unit, or
`nohup node server.js >> tracker.log 2>&1 &`.

## 2. Enrol the render nodes

The **Help** tab shows copy-paste one-liners (they fetch a generated installer
that embeds the server URL + agent key):

- **macOS** — `curl -fsSL http://TRACKER-HOST:4400/enroll.sh | bash`, then once
  with admin rights: `curl -fsSL http://TRACKER-HOST:4400/setup.sh | sudo bash`
- **Windows** (PowerShell) — `irm http://TRACKER-HOST:4400/enroll.ps1 | iex`,
  then once elevated: `irm http://TRACKER-HOST:4400/elevate.ps1 | iex`

The elevation step installs the agent as a SYSTEM scheduled task (Windows) /
root LaunchDaemon (macOS) so it can run installers headlessly. Nodes appear on
the Dashboard within seconds with detected versions.

> ⚠️ The enrol/setup scripts **embed the agent key in plaintext** — serve them
> only on a trusted LAN, never expose them publicly. (See HANDOFF §8.)

Quick manual test on a node:

```sh
python3 render_agent.py --server http://TRACKER-HOST:4400 --key <AGENT_KEY> --once
```

## 3. Track latest versions

Most products auto-detect "latest" server-side (Maxon Zendesk feed, NVIDIA's
public driver lookup, Adobe RUM for After Effects, gyan.dev/evermeet for
FFmpeg). The **Catalog** tab lets you override versions, set install sources,
and toggle per-product **auto-deploy** (canary-first).

## 4. Deploy updates

On the **Updates** tab: pick software → choose machines (outdated only, or pick)
→ options (platform/source) → **Update now**. Deploys are a **bounded rolling
rollout** (`maxConcurrentInstalls` at a time) with a **circuit breaker** (pauses
if 3+ fail with no success). Watch live progress, Stop/Retry per job, in the
**Recent jobs** table and the **Fleet** tab.

Installer commands use `{file}` for the downloaded path. Examples and the silent
flags per product are in HANDOFF and the in-app Catalog presets.

## Notes & limits

- **Security**: agent endpoints require the agent key; **the dashboard/admin API
  has no login** — run it on a trusted LAN or behind a VPN/reverse-proxy auth.
  Anyone who can reach the dashboard can deploy. (Full list: HANDOFF §8.)
- Adobe After Effects updates via **RUM** (patch-only within the installed
  major); the Creative Cloud desktop app self-updates and is not managed here.
- A node shows **offline** after ~3 missed check-ins (`offlineAfterSeconds`,
  default 180 s). Offline machines can be woken via **Wake-on-LAN**.

## File map

```
server.js                       HTTP server + all API routes (zero-dep Node)
lib/db.js                       SQLite schema + migrations (tracker.db)
lib/extra_versions.js           NVIDIA driver latest-version detection
lib/maxon_versions.js           Maxon release-notes feed parsing
public/                         dashboard UI (vanilla JS — app.js / index.html / style.css)
agents/render_agent.py          cross-platform "Beacon" node agent (self-updating)
agents/com.tracker.agent.plist  macOS LaunchDaemon template
agents/install-windows-task.ps1 Windows scheduled-task installer
deploy/                         fleet enrol/elevate helper scripts
installers/                     drop installer files here (gitignored)
config.json                     port + agent key (created on first run; gitignored)
config.example.json             reference shape for config.json
HANDOFF.md                      ★ engineering + integration reference
```
