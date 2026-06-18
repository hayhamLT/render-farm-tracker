# HANDOFF.md — Render Farm Tracker

> Handoff for merging the **Render Farm Tracker** into a larger project served on a custom domain.
> Repo root: `/Users/trm/Library/CloudStorage/Dropbox-Personal/VibeCoding/Tracker/`
> **Read Section 8 (Security) before exposing anything beyond the LAN.** This tool was designed for a trusted LAN and is currently unsafe to put on a public domain as-is.

---

## 1. Overview

The Render Farm Tracker keeps software up to date across **~28 render nodes**. It has three parts, all with **zero npm dependencies**:

- **Server** — `server.js` built on Node's built-in `http.createServer` (plain HTTP, no TLS). Listens on **port 4400** (`PORT` env or `config.port`; `config.json:2`). Manual router, no framework, no middleware. Persists state to SQLite via the built-in `node:sqlite` (DB layer in `lib/db.js`).
- **Agent** — a stdlib-only Python script `agents/render_agent.py` (`AGENT_VERSION="2.8.0"`) installed on each render node. Polls the server every 60s, reports detected software + latest-available versions, and executes install jobs.
- **Dashboard** — a no-framework, vanilla-JS single-page app in `public/` (`index.html`, `app.js`, `style.css`, `icons/`). Polls `GET /api/state` and renders via `innerHTML`.

It integrates three external tools that live **on each node** (not on the server): **Adobe RUM** (RemoteUpdateManager — After Effects updates), **Maxon mx1** CLI (Cinema 4D / Redshift / Red Giant — installed + latest versions), and **Thinkbox Deadline** (`deadlinecommand`, used by the enrolment scripts to push agents to nodes).

The single security boundary is one **shared static agent key** (`config.agentKey`). Only `/api/agent/*` routes check it. **Every dashboard/admin route is unauthenticated.**

---

## 2. Architecture

```
            ┌─────────────────────────────────────────┐
            │  ~28 render nodes                        │
            │  agents/render_agent.py  (v2.8.0)        │
            │  - Windows: scheduled task (SYSTEM)      │
            │  - macOS:   root LaunchDaemon            │
            │  each baked with: --server               │
            │     http://10.10.10.96:4400              │
            │     --key 27b99007...                    │
            └───────────────┬─────────────────────────┘
                            │  HTTP  (X-Agent-Key header)
                            │  POST /api/agent/checkin  (every 60s)
                            │  GET  /api/agent/download/:pkgId
                            │  POST /api/agent/jobs/:id/status
                            │  POST /api/agent/upload?filename=
                            │  GET  /agent  (self-update source)
                            ▼
   ┌──────────────────────────────────────────────────────────┐
   │  server.js   (Node >= 22.5, plain HTTP, binds 0.0.0.0)    │
   │  - port 4400                                              │
   │  - router: manual method+pathname match                  │
   │  - /api/agent/*  → X-Agent-Key required                   │
   │  - everything else /api/*  → NO AUTH                      │
   │  - serves public/ static UI + bootstrap scripts          │
   │  - reads/writes config.json, installers/, tracker.db     │
   └───────┬──────────────────────────────────┬───────────────┘
           │ node:sqlite (lib/db.js)           │ HTTP, root-relative paths
           ▼                                   ▼  GET /api/state (poll)
   ┌────────────────┐              ┌──────────────────────────────┐
   │  tracker.db    │              │  Dashboard (public/)         │
   │  + .db-wal     │              │  vanilla JS, no framework,   │
   │  + .db-shm     │              │  NO auth, innerHTML render   │
   │  (WAL mode)    │              └──────────────────────────────┘
   └────────────────┘
```

Data flow: **agents push** inventory and **pull** jobs/installers from the server. The **dashboard pulls** the full farm snapshot from `/api/state` and pushes deploy/admin commands. All state lives in `tracker.db`. Installer binaries (~51 GB) live on disk in `installers/` and a configured mirror, **not** in the DB.

---

## 3. Components & files

| Path | What it is |
|---|---|
| `server.js` | The HTTP server + API: manual router, agent-key auth helper, `fullState()` snapshot, static serving, enrolment-script generators (inline GET routes), the reaper, and the listener. Requires Node >= 22.5. |
| `lib/db.js` | SQLite layer. `require('node:sqlite')` (`lib/db.js:2`); DB path hardcoded `__dirname/../tracker.db` (`lib/db.js:5,7`); schema (CREATE IF NOT EXISTS + ALTER migrations on every boot); **WAL mode only** (`lib/db.js:10`); seeds 6 products (`lib/db.js:71-77`); `logEvent()` self-trims events to 500 rows (`lib/db.js:96-103`). Exports `{ db, logEvent }`. |
| `agents/render_agent.py` | The node agent, `AGENT_VERSION="2.8.0"`. Check-in, job runner, self-update, and version detection (RUM, mx1). Reads `--server`/`--key` only at startup; never persists/rediscovers the URL. |
| `agents/com.tracker.agent.plist` | macOS LaunchDaemon **template** for manual installs — its `--server` is the placeholder `http://TRACKER-HOST:4400` (`:20`), NOT the live IP. The *deployed* agents are pinned to `http://10.10.10.96:4400` (baked at enrol time by the server-generated `/setup.sh`). |
| `agents/install-windows-task.ps1` | Windows scheduled-task installer for the agent (`README.md:129`). |
| `public/index.html` | SPA shell (5 tabs). Relative asset links (`style.css`, `app.js`); **no `<base>` tag**; a cosmetic hardcoded share path `\\THIS-server\INSTALLERS` in the Setup tab. |
| `public/app.js` | All UI logic (~1200 lines). `api()` helper uses **root-relative** fetch paths; `esc()` HTML-escaper; polling loops; enrol-command UI; the themed `toast()`/`uiConfirm()` dialogs. |
| `public/style.css`, `public/icons/`, `public/mac_elevate.sh` | Styles, real product icons, and the mac elevation helper. `mac_elevate.sh:11` hardcodes `http://10.10.10.96:4400`. |
| `config.json` | `port` (4400), `agentKey` (`27b99007...` — **secret, in plaintext**), `installerSources` (`/Volumes/THIS-server/INSTALLERS`), `maxConcurrentInstalls`, `monitoringActive`, `offlineAfterSeconds`. Read AND written at runtime (`/api/settings`, `/api/monitoring`). |
| `tracker.db` (+ `.db-wal`, `.db-shm`) | The only datastore. WAL is uncheckpointed; **copy all three files together** or checkpoint first. Currently holds demo/test data; **no backups exist**. |
| `installers/` | Staged installer binaries (~51 GB). Served over LAN via `GET /api/agent/download/:id`. |
| Enrolment scripts (**no `deploy/` folder exists**) | Generated **inline by `server.js`** as GET routes (`/setup.sh`, `/setup.ps1`, `/enroll.ps1`, `/elevate.ps1`, `/stage.bat`), plus the `agents/*` templates and `public/mac_elevate.sh`. These use Deadline `deadlinecommand` to push agents to nodes. |
| `/Users/trm/Library/LaunchAgents/com.tracker.server.plist` | The **live server LaunchAgent** (NOT in the repo). Per-user agent, so it runs only while user `trm` is logged in. |

---

## 4. Data model

SQLite via `node:sqlite` `DatabaseSync`. **WAL mode on, foreign-key enforcement OFF** (`lib/db.js:10` sets only `journal_mode=wal`; `PRAGMA foreign_keys` defaults to 0, so the declared `ON DELETE CASCADE` is **inert** — deletions are handled manually in code).

Six application tables (`lib/db.js:12-64`):

| Table | Purpose / key columns | Notes |
|---|---|---|
| `nodes` | Render machines. `id` PK; `hostname` UNIQUE (short name only — DNS suffix stripped on check-in); `os` (`windows`/`macos`); `ip` (IPv4-mapped IPv6, e.g. `::ffff:10.10.10.153`); `agent_version`; `last_seen`; `created_at`; `elevated` (0/1, nullable). | `online` is **not stored** — computed per request: `last_seen != null && now-last_seen < offlineAfterSeconds*1000` (`offlineAfterSeconds`=180). Nodes keyed only on short hostname — duplicate short names collapse. |
| `software` | Per-node detected installs. Composite PK `(node_id, product_key)`; `version`, `install_path`, `detected_at`. | `product_key` is free text, NOT FK-constrained. Fully replaced on each full check-in. |
| `products` | Trackable-app catalog. `key` PK; `name`; `latest_version` (auto-bumped from agent reports); `notes`; `source_url_win`/`source_url_mac`. | Seeded with 6: `cinema4d`, `redshift`, `redgiant`, `aftereffects`, `maxonapp`, `creativecloud` (`lib/db.js:71-77`). |
| `packages` | Deployable versions. `id` PK; `product_key`; `version`; `os`; `filename`; `install_command` (template, `{file}` = downloaded path); `kind` (`installer` or `command`). | `installer` = download + run a staged file; `command` = run a tool already on the node (RUM/mx1/winget). Binaries on disk, **not in the DB**. |
| `jobs` | Deploy attempts. `id` PK; `package_id`; `node_id`; `status` (`pending`→`downloading`→`installing`→`success`/`failed`/`cancelled`); `log` (capped 20000 chars); `created_at`/`updated_at`. | A reaper (every 5 min) fails in-flight jobs idle >45 min and pending >24h; flips to success if the node already reports the target version. `dl_pct`/`inst_pct` are computed in-memory, never persisted. |
| `events` | Bounded activity log. `id`, `ts`, `kind`, `message`. | Self-trims to newest 500 rows on every write. Kinds: `job`, `deploy`, `package`, `node`, `catalog`, `monitoring`. |

### `/api/state` shape (the single endpoint the UI polls)

`fullState()` returns one denormalized snapshot:

```jsonc
{
  "now": 0,                                  // unix ms
  "monitoring": { "active": true },
  "maxConcurrentInstalls": 4,
  "nodes":   [ { /* all node cols */, "online": true,
                 "software": [ { "product_key","version","install_path","detected_at" } ] } ],
  "products":[ { /* all product cols */, "staged_win": "file|null", "staged_mac": "file|null" } ],
  "packages":[ { /* all package cols */ } ],
  "jobs":    [ { /* all job cols */, "hostname","product_key",
                 "package_version", "package_os",       // JOIN aliases
                 "dl_pct"|"inst_pct" } ],               // newest 200
  "events":  [ { "id","ts","kind","message" } ]         // newest 100
}
```

**The frontend depends on these exact alias names** — `j.package_version`, `j.hostname`/`j.product_key`, `prod.staged_win`/`staged_mac`, `n.online`. Renaming any alias breaks the UI silently. External consumers must call `/api/state`, never read the DB directly — none of these computed fields exist as columns.

---

## 5. HTTP API reference

Router parses the URL, then matches method + pathname. **Auth = `X-Agent-Key` header equality, applied ONLY inside the `/api/agent/` block. Everything else is open.**

### Agent routes — authenticated (`X-Agent-Key`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/agent/checkin` | ✅ key | Heartbeat + inventory + job dispatch. Body `{hostname, os, ip?, agentVersion?, elevated?, software?, latest?}`. Returns `{nodeId, active, latestAgent, pollSeconds, jobs[]}`. Core loop. |
| POST | `/api/agent/upload?filename=NAME` | ✅ key | Node stages an installer to the server cache. Raw binary body (NOT subject to the 2 MB JSON cap). |
| POST | `/api/agent/jobs/:id/status` | ✅ key | Agent reports job progress. Body `{status, log?}`; status ∈ pending/downloading/installing/success/failed. |
| GET | `/api/agent/download/:id` | ✅ key | Agent pulls an installer (`:id` is the **package** id). Streams the file. |

### Bootstrap / enrolment / agent source — **UNAUTHENTICATED (leak the key!)**

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/agent` | ❌ **NONE** | Serves `agents/render_agent.py` as text. Used for enrolment + self-update. Anyone can fetch agent source. |
| GET | `/setup.sh` `/setup.ps1` `/enroll.sh` `/enroll.ps1` `/elevate.ps1` `/stage.bat` | ❌ **NONE — EMBEDS `config.agentKey` IN PLAINTEXT** | Generated install scripts. Base URL built from `req.headers.host` but **hardcodes `http://`**. MUST NOT be exposed publicly. |
| GET | `/api/agent-setup` | ❌ **NONE — RETURNS `{agentKey, port, lanUrl}`** | Hands the plaintext agent key to any caller. Critical to lock down. |

### Static UI — unauthenticated (GET, expected)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/`, `/index.html` | ❌ none | Dashboard SPA. |
| GET | any non-`/api/` path | ❌ none | Serves from `public/` (path-traversal guard, MIME map, no caching, no SPA fallback). |

### Dashboard / admin API — **ALL UNAUTHENTICATED**

> ⚠️ These can register packages with arbitrary install commands and deploy them farm-wide. Agents run `install_command` via `subprocess.run(..., shell=True)` as root/SYSTEM. **Unauthenticated access here = farm-wide RCE.**

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/state` | ❌ **NONE** | Full farm snapshot. |
| POST | `/api/monitoring` | ❌ **NONE** | Toggle monitoring; writes `config.json` (largely vestigial — forced true at boot). |
| POST | `/api/settings` | ❌ **NONE** | Set `maxConcurrentInstalls` (1..50); writes `config.json`. |
| GET | `/api/installer-files` | ❌ **NONE** | List installer files + sources. |
| POST | `/api/download-url` | ❌ **NONE — SSRF** | Server fetches an arbitrary http/https URL into `installers/` (≤8 redirects, no IP allowlist). |
| GET | `/api/downloads` | ❌ **NONE** | In-memory download-progress list. |
| PUT | `/api/products/:key` | ❌ **NONE** | Edit catalog entry. |
| POST | `/api/packages` | ❌ **NONE** | Create package. |
| DELETE | `/api/packages/:id` | ❌ **NONE** | Delete package (refuses if active jobs). |
| POST | `/api/deployments` | ❌ **NONE** | Queue a job per OS-matching node. |
| POST | `/api/quick-update` | ❌ **NONE** | Queue one node. |
| POST | `/api/update-outdated` | ❌ **NONE** | Batch-queue every outdated node. |
| POST | `/api/jobs/:id/cancel` `/api/jobs/:id/kill` | ❌ **NONE** | Cancel a job. |
| POST | `/api/jobs/kill-all` | ❌ **NONE** | Cancel ALL pending + in-flight jobs farm-wide. |
| POST | `/api/jobs/:id/retry` | ❌ **NONE** | Re-queue a failed/cancelled job. |
| DELETE | `/api/nodes/:id` | ❌ **NONE** | Delete a node + its jobs + software. Destructive. |

Other behavior: no CORS/CSP/X-Frame-Options/HSTS headers; top-level catch returns raw `err.message` to the client as a 500 JSON; `readBody()` caps JSON bodies at 2 MB but upload/download streams are uncapped.

---

## 6. Configuration & hard-coded assumptions

Everything below must be reviewed/parameterized for the merge.

| Item | Where | Problem / action |
|---|---|---|
| Port 4400, plain HTTP | `config.json:2` / listener | `PORT` env overrides `config.port`. No TLS in the listener. Bind to loopback; terminate TLS upstream. |
| `config.agentKey` | `config.json:3` | Live key `27b99007...` in plaintext. **Rotate** on merge; treat `config.json` as a secret; keep out of VCS. |
| DB path | `lib/db.js:5,7` | Hardcoded `__dirname/../tracker.db`, no env override. Parameterize (e.g. `DB_PATH`) so data lives on a durable, backed-up volume outside the web root. |
| `config.json` + `installers/` location | server ROOT | Anchored to repo ROOT, currently inside Dropbox. Move out of Dropbox and VCS. |
| `installerSources` | `config.json:6` | `/Volumes/THIS-server/INSTALLERS` — a macOS SMB mount that won't exist on Linux → installer 404s. Re-point for the target host. |
| Enrol base URL scheme | enrol-script generator | Built from `req.headers.host` but **hardcodes `http://`**. Behind HTTPS, generated scripts point agents at `http://`. Make proxy-aware (honor `X-Forwarded-Proto`). |
| `lanUrl` for copy-enrol buttons | `/api/agent-setup` → `app.js` | Returns `http://<first non-internal IPv4>:config.port`, ignores Host. By design for LAN agent traffic — do NOT "fix" to the public domain. |
| Hardcoded `10.10.10.96:4400` | every *deployed* node's launchd plist / scheduled task (baked at enrol time — confirmed on AVA-01); `public/mac_elevate.sh:11`. NOTE: the `agents/com.tracker.agent.plist` repo file is a `TRACKER-HOST` template, not the live IP. | Agents are physically pinned here with no in-band re-point. See Section 7. |
| `\\THIS-server\INSTALLERS` | `public/index.html` (Setup tab) | Cosmetic Windows share path. |
| External tool paths | `render_agent.py` (mx1, RUM); enrol scripts (Deadline `deadlinecommand`) | Node-local; unaffected by the server move but required on each node. |
| Node version | `lib/db.js:2` | Requires `node:sqlite` → **Node >= 22.5** (prefer >= 24 to avoid the experimental warning). No `package.json`/engines today. |

---

## 7. Merging onto a custom domain — step-by-step

The cleanest target is a **subdomain root** (e.g. `https://tracker.example.com/`), NOT a sub-path of a bigger app. A sub-path requires either prefix-stripping in the proxy or source edits in both server and frontend (see 7.4).

### 7.1 Reverse proxy in front of :4400

1. Bind the Node process to **loopback** (`127.0.0.1:4400`) so 4400 is never directly reachable.
2. Terminate TLS at nginx/Caddy/Traefik and forward to `http://127.0.0.1:4400`.
3. **Forward the real `Host` header and set `X-Forwarded-Proto`/`X-Forwarded-For`.**
4. **Disable proxy buffering and raise limits** for the streaming routes:
   - `POST /api/agent/upload` (raw installer uploads, uncapped)
   - `GET /api/agent/download/:id` (multi-GB downloads)
   - In nginx terms: large `client_max_body_size`, high `proxy_read_timeout`, `proxy_buffering off`.
5. The server matches download-progress on `req.socket.remoteAddress` and does **not** read `X-Forwarded-For`, so progress bars may misattribute behind a proxy unless you pass real client IPs and/or patch the server to honor XFF.

Example (subdomain root, nginx):
```nginx
server {
  listen 443 ssl;
  server_name tracker.example.com;
  # ... ssl_certificate / ssl_certificate_key ...

  # AUTH layer goes here — see Section 8. e.g. auth_request / basic_auth / SSO.

  client_max_body_size 0;          # uncapped installer uploads
  proxy_read_timeout 3600s;        # long installs/downloads
  proxy_buffering off;

  location / {
    proxy_pass http://127.0.0.1:4400;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
  }
}
```

### 7.2 Make the enrol "base" honor X-Forwarded-Proto / Host

The bootstrap-script generator builds the embedded server URL from `req.headers.host` but **hardcodes the `http://` scheme**; `/api/agent-setup`'s `lanUrl` is similarly `http://<ip>:port`. Behind HTTPS, generated install commands will point agents at `http://`.

Options:
- **Patch the scheme to be proxy-aware:** derive scheme from `X-Forwarded-Proto` (fallback `http`) and host from `X-Forwarded-Host`/`Host`, via a `publicBaseUrl(req)` helper used by both the enrol generator and `/api/agent-setup`.
- **Or** enroll agents with an explicit `--server https://tracker.example.com` value and don't rely on the generated scheme.

Either way the proxy must forward the `Host` header.

### 7.3 The AGENT RE-POINTING problem (the big operational gotcha)

All ~28 agents are baked with `--server http://10.10.10.96:4400` in their launchd plist (macOS) / scheduled task (Windows). The agent reads `--server` only at startup and **never persists, rediscovers, or accepts a new URL from the server**. The server **cannot** tell agents to move. Choose one:

- **Option A — DNS/IP takeover of `.96` (SAFEST, zero node changes).** Keep `10.10.10.96:4400` answering the agent endpoints — either keep a LAN listener reachable at that IP:port, or NAT/forward `10.10.10.96:4400` to the app's new internal address. Existing agents keep checking in unchanged over plain HTTP with the same `X-Agent-Key`. **Do NOT force-redirect `/api/agent/*`, `/agent`, or `/api/agent/download/*` to HTTPS or to a sub-path** — agents call fixed root paths with no base-path awareness, and `urllib` will not transparently follow an http→https upgrade on POSTs.
  - Note: `10.10.10.96` is currently a **secondary IP alias on the MacBook itself** (which also holds `10.10.10.65`). Reassigning `.96` to the new host is therefore a clean cutover lever.
- **Option B — re-enrol all agents.** Push a new launchd plist (macs) / re-run `elevate.ps1`/`setup.ps1` with the new `--server https://tracker.example.com` (Windows) on every node — the existing channel for this is **Deadline RemoteControl**. Required if you mount under a sub-path.
- **Option C — make agents follow a hostname.** Re-enrol agents pointed at a stable DNS name (e.g. `tracker.lan` → current IP), so future server moves are a DNS change only. One-time re-enrol (same effort as B) but removes future re-point pain.

If you also **rotate the agent key** during the merge, every node's stored `--key` must be re-pushed in lockstep or those nodes drop to 401.

### 7.4 Sub-path mounting considerations (vanilla-JS frontend)

If you must mount under `/tracker/`:
- The dashboard's `api()` helper uses **root-absolute** fetch paths (`/api/state`, etc.) and the server only serves the UI at `/` and `/index.html`. There is **no `<base>` tag** and **no `API_BASE` constant**.
- Cleanest fix: have the proxy **strip the prefix** before forwarding, so both the page and `/api/*` arrive unprefixed:
  ```nginx
  location /tracker/ { proxy_pass http://127.0.0.1:4400/; }  # trailing slash strips /tracker
  ```
  Index.html's relative asset links then resolve correctly **only if the page is requested with a trailing slash**.
- If prefix-stripping isn't possible, you must edit `app.js` to prepend a base to every `fetch`, and thread a base path through the server's static serving.
- **Recommendation:** mount at a subdomain root to avoid all of this.

### 7.5 Node 22+ requirement

The app uses Node's built-in `node:sqlite` (`lib/db.js:2`) — requires **Node >= 22.5**. There is no `package.json`. The live server runs Node v24.14.1. Add a `package.json` with `"type": "commonjs"` and an `engines` field, and ensure the merge target's Node satisfies it.

---

## 8. Security — MUST-FIX before exposing beyond the LAN

> The README itself (`README.md:109-111`) states the dashboard has no login and must stay on a trusted LAN / behind a firewall or VPN. Exposing this on a custom domain without an auth layer turns a LAN tool into an **internet-reachable, farm-wide remote-code-execution panel.**

Prioritized:

### CRITICAL

1. **The entire dashboard/admin API is unauthenticated.** The key check runs only for `/api/agent/*`; every other route has no auth. Because deploys queue install commands that agents run via `shell=True` as root/SYSTEM, an unauthenticated request = **farm-wide RCE**, not just data tampering.
   **Fix:** Put the **whole app** behind the larger project's auth (reverse-proxy auth / SSO / VPN / IP allowlist). Do NOT rely on the agent-key gate for the dashboard. Allow the background polling XHRs (`/api/state`, `/api/downloads`) through the auth layer or the UI silently goes "stale".

2. **The shared agent key is disclosed by unauthenticated endpoints.** `GET /api/agent-setup` returns `{agentKey,...}`; the bootstrap scripts embed it verbatim and are served unauthenticated; and it is committed in `config.json:3`. The single security boundary is therefore effectively zero.
   **Fix:** Lock down / remove `/api/agent-setup`, `/agent`, and `/setup.* /enroll.* /elevate.ps1 /stage.bat` behind admin auth or an internal-only path. **Rotate the key** and re-push to all nodes (see 7.3). Keep `config.json` out of any public artifact.

### HIGH

3. **Plain HTTP only, binds all interfaces.** The `X-Agent-Key` header and the key returned by `/api/agent-setup`/scripts travel in cleartext.
   **Fix:** Terminate TLS at the proxy; bind Node to loopback. Note generated scripts hardcode `http://` — fix per 7.2 or agents keep leaking the key in cleartext even after TLS is added.

4. **Single shared static key, no rotation, no per-node identity, not timing-safe.** Plain `===` of one global key; `handleCheckin` trusts agent-supplied `hostname/os/software/latest`. One leaked key compromises the whole farm; any key holder can spoof/overwrite node records.
   **Fix (longer-term):** consider per-node credentials or mTLS for a domain deployment.

### MEDIUM

5. **SSRF via `POST /api/download-url`** (unauthenticated). Server fetches an arbitrary http/https URL, follows ≤8 redirects, no allowlist, no block on private/link-local/metadata IPs. On a cloud host this can probe internal services / cloud metadata, and is a disk-fill vector.
   **Fix:** auth-gate it AND block RFC1918 / `127.0.0.0/8` / `169.254.169.254` / link-local destinations.

6. **No CORS/CSP/X-Frame-Options, no CSRF protection.** State-changing admin POSTs take plain JSON with no token; no CSP in `index.html`. Once auth exists, a drive-by page could still fire `POST /api/deployments`.
   **Fix:** add a CSRF token or SameSite-cookie session, plus a baseline CSP at the proxy.

### LOW

7. **XSS surface is currently sound but defense-in-depth is missing.** `esc()` is consistently applied to all agent-supplied strings rendered via `innerHTML` (hostnames, IPs, versions, logs, event messages). No unescaped path was found. But there is **no CSP**, so any future escaping miss becomes stored XSS that can drive the now-RCE-capable admin API.
   **Fix:** add a CSP; prefer `textContent` for new dynamic values.

8. **Verbose error disclosure.** Top-level catch returns raw `err.message` to clients, leaking internal paths.
   **Fix:** return a generic message; log details server-side.

---

## 9. Deployment & runtime

- **Node version:** >= 22.5 for built-in `node:sqlite` (`lib/db.js:2`); the live server runs **v24.14.1**. No `package.json`/`node_modules` — the Node version is the only binding constraint. Add `package.json` (`"type": "commonjs"`, `engines`).
- **How it runs today (macOS, per-user):** LaunchAgent `/Users/trm/Library/LaunchAgents/com.tracker.server.plist` — `RunAtLoad` + `KeepAlive`, `WorkingDirectory` = the Dropbox repo, runs nvm node v24.14.1 + `server.js`, logs to `/tmp/tracker-server.log`. It is a **per-user agent (not a LaunchDaemon)**, so it runs only while user `trm` is logged in. The plist is **NOT in the repo**.
- **Reload after editing `server.js`:** the process is under launchd, so a plain restart won't pick it up — kickstart it:
  ```bash
  launchctl kickstart -k gui/$(id -u)/com.tracker.server
  ```
  (Static files in `public/` and the agent file are re-read live, so only server-code changes need this.)
- **No graceful shutdown:** no SIGTERM handler, no `db.close()` — relies on launchd `KeepAlive`. WAL mode tolerates this but consider checkpointing.
- **Target hosts:**
  - **Linux:** write a systemd unit (`WorkingDirectory`, `Restart=always`, absolute node path). Paths resolve via `__dirname`.
  - **Windows:** NSSM or winsw.
- **macOS-only bits:** `config.json` auto-adds the `/Volumes/THIS-server/INSTALLERS` mount at boot; `lanAddress()` picks the first non-internal IPv4; the **agent** supports only Windows + macOS — **no Linux agent** (the Linux concern is the server host, not the nodes).
- **External tool paths (on nodes, must exist):** mx1 — `…/Maxon/Tools/mx1.exe` (Win), `/Library/Application Support/Maxon/Tools/mx1` (Mac); Adobe RUM — the OOBE_Enterprise path & `…/ProgramData/TrackerAgent/RemoteUpdateManager.exe` (Win), `/usr/local/bin/RemoteUpdateManager` (Mac); Deadline `deadlinecommand` at `…/Thinkbox/Deadline10/…` (used by the server's inline enrol scripts + `agents/install-windows-task.ps1`, and by the server's Windows enrol, which uses Deadline's bundled python, `server.js:366,511`). The agent guards each with `os.path.exists`.
- **Self-update mechanism (good to know):** the server scrapes `AGENT_VERSION` out of `agents/render_agent.py` at startup and re-reads every 60s, so dropping in a new agent file rolls out farm-wide with no server restart. `SAFE_SELFUPDATE_FROM='2.1.0'` means agents below 2.1.0 are never told to update. All 28 nodes are on 2.8.0 today, so the gate is currently moot.
- **State location:** `tracker.db` (+ `.db-wal` + `.db-shm`), `config.json` (live key), and ~51 GB of installers all live in the repo dir **inside Dropbox**. **Move data, installers, and `config.json` out of Dropbox and VCS** before production.

---

## 10. Merge checklist

Work top to bottom.

- [ ] **Runtime:** confirm target runs **Node >= 22.5** (prefer >= 24). Add `package.json` (`"type":"commonjs"`, `engines`).
- [ ] **Get data out of Dropbox/VCS:** move `tracker.db` (+ `.db-wal` + `.db-shm` *together*, or checkpoint first), `installers/` (~51 GB), and `config.json` to a durable volume. Parameterize the DB path (`lib/db.js:5`) and verify `installers/`/`config.json` resolution.
- [ ] **Start from a fresh DB** (current `tracker.db` is demo data; `db.js` auto-creates schema + seeds 6 products on first boot). Add a backup/checkpoint routine — **none exists today**.
- [ ] **Re-point** `installerSources` (`config.json:6`) away from the macOS `/Volumes/THIS-server/INSTALLERS` mount to a path that exists on the target host.
- [ ] **Rotate the agent key** (`config.json:3`) and treat `config.json` as a secret. Plan to re-push the new `--key` to all nodes in lockstep.
- [ ] **Stand up the service:** systemd (Linux) / NSSM (Windows). Bind Node to **loopback** (`127.0.0.1:4400`).
- [ ] **Reverse proxy + TLS:** terminate HTTPS, forward to `127.0.0.1:4400`; forward `Host`, set `X-Forwarded-Proto`/`X-Forwarded-For`; `proxy_buffering off`, large body size, long read timeout for upload/download routes.
- [ ] **Add an AUTH layer** in front of the dashboard + all `/api/*` (SSO/basic-auth/IP allowlist/VPN). Verify the polling XHRs (`/api/state`, `/api/downloads`) are allowed through.
- [ ] **Lock down key-leaking routes:** `/api/agent-setup`, `/agent`, `/setup.* /enroll.* /elevate.ps1 /stage.bat` behind admin auth or an internal-only path.
- [ ] **Auth-gate + SSRF-harden** `POST /api/download-url` (block private/link-local/metadata IPs).
- [ ] **Fix the enrol base URL:** make the enrol generator (and `/api/agent-setup`) honor `X-Forwarded-Proto`/`X-Forwarded-Host`, or enroll agents with an explicit `https://…` `--server`.
- [ ] **Choose the agent re-point strategy (Section 7.3):** A) keep `10.10.10.96:4400` answering (no node changes), B) re-enrol all ~28 nodes via Deadline RemoteControl, or C) re-enrol to a stable DNS name. If rotating the key, re-push `--key` at the same time.
- [ ] **Mounting:** prefer a **subdomain root** (`tracker.example.com/`). If a sub-path is mandatory, strip the prefix in the proxy (`proxy_pass …:4400/;`) and serve the page with a trailing slash; otherwise patch `app.js` fetch paths + server static serving.
- [ ] **Do NOT** redirect agent traffic (`/api/agent/*`, `/agent`, `/api/agent/download/*`) to HTTPS or a sub-path, and do NOT rewrite the LAN enrol URLs to the public domain (they are http-LAN by design).
- [ ] **Hardening (defense-in-depth):** add CSP / X-Frame-Options / X-Content-Type-Options at the proxy; add CSRF protection or SameSite session once auth exists; suppress raw `err.message`.
- [ ] **Smoke test:** one agent checks in over the chosen path; a deploy job runs end-to-end (download → install → success); dashboard loads behind auth and polls without going stale.
