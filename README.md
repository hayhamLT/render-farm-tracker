# Render Farm Update Tracker

A local web app for monitoring and deploying software updates across a mixed
Windows/macOS render farm. Tracks **Maxon Cinema 4D**, **Redshift**,
**Red Giant**, and **Adobe After Effects** out of the box.

- **Zero dependencies** — the server is plain Node.js (≥ 22.5, uses the
  built-in SQLite module). No `npm install`.
- **One agent script** — a stdlib-only Python 3 script runs on every node,
  Windows and macOS alike.

```
┌─────────────┐   check-in every 60s    ┌──────────────────────┐
│ render node │ ──────────────────────▶ │  tracker server      │
│  (agent.py) │ ◀── queued jobs ─────── │  node server.js      │
│             │ ──── job status ──────▶ │  dashboard :4400     │
│             │ ◀── installer files ─── │  installers/ folder  │
└─────────────┘                         └──────────────────────┘
```

## 1. Start the server

```sh
node server.js
```

- Dashboard: **http://localhost:4400** (reachable on your LAN at
  `http://<this-machine>:4400`)
- On first start it writes `config.json` with a generated **agent key** —
  printed to the console, also available at `/api/agent-setup`.
- Data lives in `tracker.db` (SQLite). Delete it to start fresh.

To keep it running on this Mac: `nohup node server.js >> tracker.log 2>&1 &`,
or create a LaunchAgent.

## 2. Enrol the render nodes

Each node needs **Python 3.8+** (preinstalled on macOS; install from
python.org on Windows) and a copy of `agents/render_agent.py`.

Quick test on any node:

```sh
python3 render_agent.py --server http://TRACKER-HOST:4400 --key <AGENT_KEY> --once
```

The node appears on the dashboard within seconds, with detected versions.

Run it permanently **with admin rights** (required so it can run installers):

- **macOS** — edit `agents/com.tracker.agent.plist` (server URL + key), then:
  ```sh
  sudo mkdir -p /usr/local/tracker
  sudo cp render_agent.py /usr/local/tracker/
  sudo cp com.tracker.agent.plist /Library/LaunchDaemons/
  sudo launchctl load -w /Library/LaunchDaemons/com.tracker.agent.plist
  ```
- **Windows** — from an elevated PowerShell prompt:
  ```powershell
  .\install-windows-task.ps1 -Server "http://TRACKER-HOST:4400" -Key "<AGENT_KEY>"
  ```

### How version detection works

| OS | Method |
|---|---|
| Windows | Uninstall registry (`DisplayName`/`DisplayVersion`), fallback to Program Files folder names |
| macOS | `/Applications` app-bundle `Info.plist` versions + `pkgutil` package receipts |

Products are matched by name patterns (Cinema 4D, Redshift, Red Giant /
Trapcode / Magic Bullet / Universe, After Effects) — edit
`PRODUCT_PATTERNS` in `render_agent.py` to tune.

## 3. Track latest versions

On the **Catalog** tab, enter the newest released version of each product
(check the Maxon and Adobe release-notes pages). Every node is compared
against these values and flagged **up to date / outdated / not installed**
on the dashboard.

## 4. Deploy updates

1. Drop the installer file(s) into the `installers/` folder on the server
   (e.g. the offline C4D installer, Redshift installer, AE admin package).
2. On the **Deploy** tab, register a *package*: product, version, target OS,
   the file, and a silent-install command. `{file}` is replaced with the
   downloaded installer path on the node. Typical commands:

   | Product / OS | Command |
   |---|---|
   | Cinema 4D, Windows | `"{file}" --mode unattended --unattendedmodeui none` |
   | Cinema 4D, macOS (pkg) | `installer -pkg "{file}" -target /` |
   | Redshift, Windows | `"{file}" /S` |
   | After Effects (admin pkg), Windows | `"{file}\setup.exe" --silent` (zip the built package; or use the msi with `msiexec /i "{file}" /qn`) |
   | Generic macOS pkg | `installer -pkg "{file}" -target /` |

   Always verify the silent flags for the exact installer build you
   downloaded — vendors change them between releases. Test on one node first.

3. Pick the package, tick target nodes (OS-mismatched nodes are disabled
   automatically), and click **Deploy**. Each node picks the job up at its
   next check-in (≤ 60 s), downloads the installer, runs the command, and
   reports back. Watch progress and per-job logs in the **Jobs** table; the
   node re-scans immediately after installing so the dashboard reflects the
   new version.

## Notes & limits

- **Security**: agent endpoints require the agent key; the dashboard itself
  has no login — run it on a trusted LAN (or bind it behind a firewall/VPN).
  Anyone who can reach the dashboard can deploy packages.
- Adobe apps are normally deployed via Creative Cloud **admin packages**
  (built in the Adobe Admin Console) — build the package, then distribute its
  installer through this tool.
- Maxon apps can also be updated via `mx1` / Maxon App CLI; if you prefer
  that route, set the package command accordingly
  (e.g. `"C:\Program Files\Maxon\Tools\mx1.exe" install ...`).
- A node is shown **offline** after 3 missed check-ins
  (`offlineAfterSeconds` in `config.json`, default 180 s).

## File map

```
server.js                       HTTP server + API (zero-dep Node)
lib/db.js                       SQLite schema (tracker.db)
public/                         dashboard UI
agents/render_agent.py          cross-platform node agent
agents/com.tracker.agent.plist  macOS LaunchDaemon template
agents/install-windows-task.ps1 Windows scheduled-task installer
installers/                     drop installer files here
config.json                     port + agent key (created on first run)
```
