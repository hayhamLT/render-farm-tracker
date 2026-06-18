'use strict';
/*
 * Render Farm Update Tracker — zero-dependency local web app.
 * Requires Node.js >= 22.5 (uses the built-in node:sqlite module).
 *
 *   node server.js            start on the port in config.json (default 4400)
 */
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { db, logEvent } = require('./lib/db');
const { checkMaxonVersions, fetchInstallerUrls, pickInstallerUrl, INSTALLER_KEYWORDS } = require('./lib/maxon_versions');
const { fetchExtraLatest } = require('./lib/extra_versions');

// In-memory progress for server-side installer downloads (URL -> cache file).
// id -> { url, filename, status, received, total, error }
const downloads = new Map();

// The agent version the server is serving — agents self-update to match it.
function readAgentVersion() {
  try {
    const src = fs.readFileSync(path.join(__dirname, 'agents', 'render_agent.py'), 'utf8');
    const m = src.match(/AGENT_VERSION\s*=\s*["']([^"']+)["']/);
    return m ? m[1] : null;
  } catch { return null; }
}
// jobId -> { sent, total } for installers currently streaming to a node (LAN).
const DL_PROGRESS = new Map();
// "product|os" -> learned install duration (ms, EMA of completed installs).
// Powers the install progress bar: elapsed vs what this product usually takes.
const INSTALL_EMA = new Map();

let LATEST_AGENT_VERSION = readAgentVersion();
// Node IDs with a pending agent-side reboot — used as a fallback when Deadline's
// RemoteControl can't reach a machine (Launcher down / port 17000 blocked) but the
// tracker agent is still checking in. The flag is handed to the agent on its next
// check-in (which then reboots itself) and cleared.
const pendingAgentReboot = new Set();
// Re-read periodically so dropping in a new render_agent.py rolls out with no restart.
setInterval(() => { LATEST_AGENT_VERSION = readAgentVersion() || LATEST_AGENT_VERSION; }, 60 * 1000);

// Compare dotted versions numerically: -1 | 0 | 1.
function cmpVersionServer(a, b) {
  const pa = String(a).split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b).split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
// First numeric component = the "major" line (used to tell a safe in-place patch
// from a new-major / fresh install, which is opt-in side-by-side).
const verMajorServer = (v) => { const m = String(v || '').match(/\d+/); return m ? Number(m[0]) : 0; };

// True if a node already has an in-flight job for this PRODUCT (any package/version).
// Dedup must key on product, not package_id: every "Update now" mints a fresh
// package row, so a package-id check would let a second AE update queue while one
// is already installing. This stops that.
function activeJobForProduct(nodeId, productKey) {
  return db.prepare(
    `SELECT j.id FROM jobs j JOIN packages p ON p.id = j.package_id
      WHERE j.node_id = ? AND p.product_key = ? AND j.status IN ('pending','downloading','installing')`
  ).get(nodeId, productKey);
}

// Circuit breaker for a rolling rollout: if the first few installs of a product@version all
// FAIL and none has succeeded, the update is probably broken — so we PAUSE handing out the
// rest (they stay queued) instead of blasting the whole fleet. A single success proves the
// update works, so node-specific failures after that don't halt it. Clearing/retrying the
// failed jobs lifts the halt automatically. Industry-standard "rolling deploy + failure halt".
const ROLLOUT_HALT_THRESHOLD = 3;
const _rolloutHaltAlerted = new Set();
function rolloutHalted(productKey, version) {
  const rows = db.prepare(
    `SELECT j.status FROM jobs j JOIN packages p ON p.id = j.package_id
      WHERE p.product_key = ? AND p.version = ?`
  ).all(productKey, version);
  const failed = rows.filter((r) => r.status === 'failed').length;
  const success = rows.filter((r) => r.status === 'success').length;
  return success === 0 && failed >= ROLLOUT_HALT_THRESHOLD;
}
function flagRolloutHalt(productKey, version) {
  const key = `${productKey}|${version}`;
  if (_rolloutHaltAlerted.has(key)) return;
  _rolloutHaltAlerted.add(key);
  const prod = db.prepare('SELECT name FROM products WHERE key = ?').get(productKey);
  const msg = `Rollout paused: ${prod ? prod.name : productKey} ${version} — ${ROLLOUT_HALT_THRESHOLD}+ installs failed and none succeeded. The rest stay queued until you retry or investigate.`;
  logEvent('deploy', msg);
  try { notifySlack(`🛑 ${msg}`); } catch { /* slack optional */ }
}
// A success anywhere clears the alert dedupe so a later genuine halt can re-fire.
function clearRolloutHaltFlag(productKey, version) { _rolloutHaltAlerted.delete(`${productKey}|${version}`); }

// Parse a version-like token from an installer filename (redshift_2026.7.0_..., RedGiant-2026.4.1_Win.exe).
function versionFromFilename(filename) {
  const m = String(filename || '').match(/(\d+(?:\.\d+){1,3})/);
  return m ? m[1] : null;
}
// Guard against a doomed deploy: an installer whose STAGED file is older than the
// package's target version can never reach it (the agent fails it "version unchanged").
// Returns an error string in that case, else null. Only fires when the filename has a
// parseable version (custom/unparseable names pass through untouched).
function installerVersionMismatch(pkg) {
  if (!pkg || pkg.kind !== 'installer' || !pkg.filename) return null;
  const fv = versionFromFilename(pkg.filename);
  if (fv && pkg.version && cmpVersionServer(fv, pkg.version) < 0) {
    return `staged installer "${pkg.filename}" (${fv}) is older than the target ${pkg.version} — stage the ${pkg.version} installer before deploying`;
  }
  return null;
}

// The Maxon App is hidden from the UI as a "manager" app; instead it rides along —
// after any Maxon creative-product install completes, queue the latest staged Maxon
// App installer for that node if it's behind it. Reuses the existing package rows.
const MAXON_RIDE_ALONG = new Set(['cinema4d', 'redshift', 'redgiant']);
function maybeRideAlongMaxonApp(nodeId, justInstalledKey) {
  if (!MAXON_RIDE_ALONG.has(justInstalledKey)) return;
  if (activeJobForProduct(nodeId, 'maxonapp')) return;            // already queued/running
  const node = db.prepare('SELECT id, os FROM nodes WHERE id = ?').get(nodeId);
  if (!node) return;
  // Newest staged Maxon App installer for this OS whose file is actually present.
  let pkg = null;
  for (const p of db.prepare(
    "SELECT id, version, filename FROM packages WHERE product_key='maxonapp' AND os=? AND kind='installer' ORDER BY id DESC"
  ).all(node.os)) {
    if (p.filename && resolveInstaller(p.filename) && (!pkg || cmpVersionServer(p.version, pkg.version) > 0)) pkg = p;
  }
  if (!pkg) return;                                               // nothing staged to deploy
  const sw = db.prepare("SELECT version FROM software WHERE node_id=? AND product_key='maxonapp'").get(nodeId);
  if (sw && sw.version && cmpVersionServer(sw.version, pkg.version) >= 0) return; // already current
  const now = Date.now();
  db.prepare("INSERT INTO jobs (package_id, node_id, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)")
    .run(pkg.id, nodeId, now, now);
  logEvent('deploy', `Maxon App ride-along: queued ${pkg.version} on ${node.os} node #${nodeId} after ${justInstalledKey} update`);
}

function filenameFromUrl(u, fallback) {
  try {
    const base = path.basename(new URL(u).pathname);
    if (base && base !== '/' && /\.[a-z0-9]{2,5}$/i.test(base)) return base;
  } catch { /* ignore */ }
  return fallback;
}

// Fetch a URL into installers/, following redirects, tracking progress.
function fetchToInstallers(dlId, fileUrl, filename) {
  const rec = downloads.get(dlId);
  const dest = path.join(downloadDir(), filename);
  const tmp = dest + '.part';

  const go = (u, redirects) => {
    if (redirects > 8) { fail('too many redirects'); return; }
    const lib = u.startsWith('https:') ? https : http;
    const req = lib.get(u, { headers: { 'User-Agent': 'tracker/1' } }, (resp) => {
      if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location) {
        resp.resume();
        return go(new URL(resp.headers.location, u).toString(), redirects + 1);
      }
      if (resp.statusCode !== 200) { resp.resume(); return fail(`HTTP ${resp.statusCode}`); }
      rec.total = Number(resp.headers['content-length']) || 0;
      const out = fs.createWriteStream(tmp);
      resp.on('data', (c) => { rec.received += c.length; });
      resp.pipe(out);
      out.on('finish', () => out.close(() => {
        fs.renameSync(tmp, dest);
        rec.status = 'done';
        logEvent('package', `Downloaded installer from URL: ${filename} (${(rec.received / 1048576).toFixed(1)} MB)`);
      }));
      out.on('error', (e) => fail(e.message));
    });
    req.on('error', (e) => fail(e.message));
    req.setTimeout(20 * 60 * 1000, () => req.destroy(new Error('download timed out')));
  };
  const fail = (msg) => {
    rec.status = 'error';
    rec.error = msg;
    try { fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch { /* ignore */ }
    logEvent('package', `Installer download failed (${filename}): ${msg}`);
  };
  go(fileUrl, 0);
}

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const INSTALLERS_DIR = path.join(ROOT, 'installers');
const CONFIG_PATH = path.join(ROOT, 'config.json');

if (!fs.existsSync(INSTALLERS_DIR)) fs.mkdirSync(INSTALLERS_DIR);

// ---------------------------------------------------------------- config ---
let config;
if (fs.existsSync(CONFIG_PATH)) {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} else {
  config = {
    port: 4400,
    agentKey: crypto.randomBytes(16).toString('hex'),
    offlineAfterSeconds: 180,
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

// Monitoring is always on (the master on/off toggle was removed by request).
config.monitoringActive = true;

// Extra read-only installer source folders (e.g. a network share you control).
// Files in installers/ and these dirs are all available to deploy.
let configDirty = false;
if (!Array.isArray(config.installerSources)) {
  config.installerSources = [];
  // Auto-pick up the THIS-server mirror if it's mounted.
  const mirror = '/Volumes/THIS-server/INSTALLERS';
  if (fs.existsSync(mirror)) config.installerSources.push(mirror);
  configDirty = true;
}

// Where downloaded installers are written. Default to the THIS-server share so the
// (Dropbox-synced) project folder doesn't fill up with multi-GB installers. Settable
// in the Catalog tab.
if (config.downloadDir === undefined) {
  const mirror = '/Volumes/THIS-server/INSTALLERS';
  config.downloadDir = fs.existsSync(mirror) ? mirror : INSTALLERS_DIR;
  configDirty = true;
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}
if (configDirty) saveConfig();

// Web-based Maxon "latest version" auto-detect: read Maxon's public release notes
// (Zendesk Help Center API) and bump the catalog upward. Maxon has no headless mx1
// query for this; the public release notes are the reliable source. Runs shortly
// after boot and every 6h. Best-effort — never throws into the request path.
// After detecting versions, auto-download any missing Maxon installer straight from
// Maxon's PUBLIC downloads page (full offline .exe/.dmg, no login). Guarded: only when
// the latest isn't already staged or downloading, and there's disk headroom. Cinema 4D
// isn't on that page so it stays manual. Disable with config.autoFetchMaxonInstallers=false.
async function autoFetchMaxonInstallers() {
  if (config.autoFetchMaxonInstallers === false) return [];
  let urls;
  try { urls = await fetchInstallerUrls(config); } catch { return []; }
  if (!urls.length) return [];
  const files = listInstallerFiles();
  const fetched = [];
  for (const [key, kw] of Object.entries(INSTALLER_KEYWORDS)) {
    const prod = db.prepare('SELECT * FROM products WHERE key = ?').get(key);
    if (!prod || !prod.latest_version) continue;
    if (!isTracked(prod)) continue;   // app toggled off — don't fetch its installer
    for (const os of ['windows', 'macos']) {
      const staged = findStagedInstaller(key, os, prod.latest_version, files);
      const sv = staged ? versionFromFilename(staged.name) : null;
      if (sv && cmpVersionServer(sv, prod.latest_version) >= 0) continue;          // already have the latest
      const url = pickInstallerUrl(urls, kw, prod.latest_version, os);
      if (!url) continue;
      const filename = filenameFromUrl(url, null);
      if (!filename || resolveInstaller(filename)) continue;                        // already on disk
      if ([...downloads.values()].some((d) => d.filename === filename)) continue;   // already downloading
      try { const st = fs.statfsSync(downloadDir()); if (st.bavail * st.bsize < 25e9) { console.error('auto-fetch skipped (low disk):', filename); continue; } } catch { /* statfs unavailable — proceed */ }
      const dlId = crypto.randomBytes(6).toString('hex');
      downloads.set(dlId, { url, filename, status: 'downloading', received: 0, total: 0, error: null });
      fetchToInstallers(dlId, url, filename);
      logEvent('package', `Auto-fetching ${prod.name} ${prod.latest_version} installer (${os}) from Maxon`);
      console.log('Auto-fetch started:', filename);
      fetched.push(filename);
    }
  }
  return fetched;
}
// Self-managed managers (CC self-updates; Maxon App rides along) — always handled
// specially regardless of the per-app tracking toggle.
const SELF_MANAGED = new Set(['creativecloud', 'maxonapp']);
// Products that exist on only one OS. The NVIDIA GeForce driver is Windows-only (the
// farm's NVIDIA cards run on Windows; Macs are Apple Silicon), so it's never checked,
// fetched, or deployed for macOS.
const WINDOWS_ONLY = new Set(['nvidia']);
const appliesToOS = (key, os) => !(WINDOWS_ONLY.has(key) && os !== 'windows');
// GPUs NVIDIA dropped from the 590+/610.x driver branch: Maxwell (GTX 9xx) + Pascal
// (GTX 10xx). The 610.62 installer rejects them (exit 0xE6000100) — never target them.
const NVIDIA_EOL_GPU = /\bGTX\s*(9\d\d|10\d\d)\b/i;
const nvidiaIsLegacy = (gpu) => NVIDIA_EOL_GPU.test(gpu || '');
// The newest driver a node's GPU supports: legacy (Maxwell/Pascal) → the ~581 track,
// everything else → the current 610.x track.
function nvidiaTargetVersion(node, prod) {
  if (!prod) return null;
  return nvidiaIsLegacy(node && node.gpu) ? prod.latest_legacy : (prod.latest_win || prod.latest_version);
}
// Find (or create) the nvidia install package for a specific driver version, from the
// staged installer that matches it. Returns null if that version isn't staged yet.
function nvidiaPackageForVersion(version) {
  if (!version) return null;
  const existing = db.prepare("SELECT * FROM packages WHERE product_key='nvidia' AND version=? AND os='windows' ORDER BY id DESC LIMIT 1").get(version);
  if (existing) return existing;
  const staged = findStagedInstaller('nvidia', 'windows', version, listInstallerFiles());
  if (!staged) return null;
  const id = Number(db.prepare('INSERT INTO packages (product_key, version, os, filename, install_command, kind, created_at) VALUES (?,?,?,?,?,?,?)')
    .run('nvidia', version, 'windows', staged.name, SERVER_PRESETS.nvidia.windows, 'installer', Date.now()).lastInsertRowid);
  return db.prepare('SELECT * FROM packages WHERE id=?').get(id);
}
// Pick the right install package for a node. For NVIDIA this swaps to the driver track the
// node's GPU actually supports, so a Pascal card gets 581.x instead of a doomed 610.x.
// Returns null when no usable driver/installer exists for that GPU (caller skips the node).
function packageForNode(node, pkg) {
  if (!pkg || pkg.product_key !== 'nvidia') return pkg;
  // The node must actually HAVE an NVIDIA GPU — by reported GPU name or an installed
  // driver. A GPU-less / AMD box (e.g. Node-00) must never be sent a GeForce driver.
  const hasDriver = db.prepare("SELECT 1 FROM software WHERE node_id = ? AND product_key = 'nvidia'").get(node.id);
  if (!/nvidia/i.test(node.gpu || '') && !hasDriver) return null;
  const prod = db.prepare("SELECT * FROM products WHERE key='nvidia'").get();
  const tv = nvidiaTargetVersion(node, prod);
  if (!tv) return null;
  return tv === pkg.version ? pkg : nvidiaPackageForVersion(tv);
}
// A product is "tracked" (version-checked, fetched, auto-deployed, shown) unless the user
// toggled it off in the Catalog. The self-managed managers are always tracked.
function isTracked(prod) {
  if (!prod) return false;
  if (SELF_MANAGED.has(prod.key)) return true;
  return !prod.dashboard_hidden;
}

// Blender + FFmpeg + NotchLC: detect latest from public sources and auto-fetch their
// installers (Blender .msi/.dmg; FFmpeg gyan/evermeet static builds; NotchLC .exe/.pkg),
// saved under versioned, OS-tagged names so the normal staging pipeline matches. Per-OS
// versions are stored (latest_win/latest_mac) for apps that differ by OS (NotchLC).
async function checkExtraVersions() {
  let latest;
  try { latest = await fetchExtraLatest(); } catch { return { bumped: [], fetched: [] }; }
  const bumped = [], fetched = [];
  for (const key of ['blender', 'ffmpeg', 'notchlc', 'nvidia']) {
    const info = latest[key];
    if (!info || !info.version) continue;
    const prod = db.prepare('SELECT * FROM products WHERE key = ?').get(key);
    if (!prod) continue;
    if (!isTracked(prod)) continue;   // app toggled off — don't track/fetch it
    // Per-OS latest (null when this app doesn't differ by OS).
    const winV = info.windows && info.windows.version;
    const macV = info.macos && info.macos.version;
    if ((winV && winV !== prod.latest_win) || (macV && macV !== prod.latest_mac)) {
      db.prepare('UPDATE products SET latest_win = ?, latest_mac = ?, updated_at = ? WHERE key = ?')
        .run(winV || prod.latest_win || null, macV || prod.latest_mac || null, Date.now(), key);
    }
    if (!prod.latest_version || cmpVersionServer(info.version, prod.latest_version) > 0) {
      db.prepare('UPDATE products SET latest_version = ?, updated_at = ? WHERE key = ?').run(info.version, Date.now(), key);
      logEvent('catalog', `Auto-detected newer ${prod.name}: latest is now ${info.version}`);
      bumped.push(`${key} ${info.version}`);
    }
    // NVIDIA legacy-GPU (Maxwell/Pascal) driver track — the newest those cards still support.
    if (info.legacy && info.legacy.version && info.legacy.version !== prod.latest_legacy) {
      db.prepare('UPDATE products SET latest_legacy = ?, updated_at = ? WHERE key = ?').run(info.legacy.version, Date.now(), key);
      logEvent('catalog', `${prod.name} legacy-GPU driver (Maxwell/Pascal): ${info.legacy.version}`);
    }
    if (config.autoFetchMaxonInstallers === false) continue;
    for (const os of ['windows', 'macos']) {
      const t = info[os];
      if (!t || !t.url || !t.filename) continue;
      if (resolveInstaller(t.filename)) continue;
      if ([...downloads.values()].some((d) => d.filename === t.filename)) continue;
      try { const st = fs.statfsSync(downloadDir()); if (st.bavail * st.bsize < 25e9) continue; } catch { /* ignore */ }
      const dlId = crypto.randomBytes(6).toString('hex');
      downloads.set(dlId, { url: t.url, filename: t.filename, status: 'downloading', received: 0, total: 0, error: null });
      fetchToInstallers(dlId, t.url, t.filename);
      logEvent('package', `Auto-fetching ${prod.name} ${t.version} installer (${os})`);
      fetched.push(t.filename);
    }
    // Fetch the NVIDIA legacy-track installer too (Windows-only), same pipeline.
    const lt = info.legacy && info.legacy.windows;
    if (lt && lt.url && lt.filename && !resolveInstaller(lt.filename)
        && ![...downloads.values()].some((d) => d.filename === lt.filename)) {
      let space = true;
      try { const st = fs.statfsSync(downloadDir()); if (st.bavail * st.bsize < 25e9) space = false; } catch { /* ignore */ }
      if (space) {
        const dlId = crypto.randomBytes(6).toString('hex');
        downloads.set(dlId, { url: lt.url, filename: lt.filename, status: 'downloading', received: 0, total: 0, error: null });
        fetchToInstallers(dlId, lt.url, lt.filename);
        logEvent('package', `Auto-fetching ${prod.name} ${lt.version} legacy installer (windows)`);
        fetched.push(lt.filename);
      }
    }
  }
  return { bumped, fetched };
}
// Fetch a text page (follows redirects) — for custom products' version-check URLs.
function httpGetText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('too many redirects'));
    let lib;
    try { lib = new URL(url).protocol === 'http:' ? http : https; } catch { return reject(new Error('bad url')); }
    const req = lib.get(url, { headers: { 'User-Agent': 'render-farm-tracker' }, timeout: 25000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(httpGetText(new URL(res.headers.location, url).href, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; if (data.length > 5e6) req.destroy(); });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}
// Derive a filename (with extension) from a direct-download URL.
function filenameFromUrl(u) {
  try {
    const base = (new URL(u).pathname.split('/').filter(Boolean).pop() || '');
    return /\.[a-z0-9]{2,5}$/i.test(base) ? decodeURIComponent(base) : '';
  } catch { return ''; }
}

// Custom products: configurable analog of the built-in scrapers. For each custom product,
// optionally fetch check_url and extract the latest version (check_regex group 1, else the
// highest version-looking token), and auto-download the installer(s) from source_url_win/mac.
async function checkCustomVersions() {
  const bumped = [], fetched = [];
  for (const prod of db.prepare('SELECT * FROM products WHERE custom = 1').all()) {
    if (!isTracked(prod)) continue;
    if (prod.check_url) {
      try {
        const txt = await httpGetText(prod.check_url);
        let ver = null;
        if (prod.check_regex) {
          const m = txt.match(new RegExp(prod.check_regex));
          ver = m && (m[1] || m[0]);
        } else {
          ver = (txt.match(/\d+(?:\.\d+){1,3}/g) || []).sort((a, b) => cmpVersionServer(a, b)).pop() || null;
        }
        if (ver && (!prod.latest_version || cmpVersionServer(ver, prod.latest_version) > 0)) {
          db.prepare('UPDATE products SET latest_version = ?, updated_at = ? WHERE key = ?').run(ver, Date.now(), prod.key);
          logEvent('catalog', `Auto-detected newer ${prod.name}: latest is now ${ver}`);
          bumped.push(`${prod.key} ${ver}`);
        }
      } catch { /* best-effort: leave the manual/last value */ }
    }
    if (config.autoFetchMaxonInstallers === false) continue;
    for (const os of ['windows', 'macos']) {
      const srcUrl = os === 'windows' ? prod.source_url_win : prod.source_url_mac;
      if (!srcUrl) continue;
      const filename = filenameFromUrl(srcUrl);
      if (!filename || resolveInstaller(filename)) continue;
      if ([...downloads.values()].some((d) => d.filename === filename)) continue;
      try { const st = fs.statfsSync(downloadDir()); if (st.bavail * st.bsize < 25e9) continue; } catch { /* ignore */ }
      const dlId = crypto.randomBytes(6).toString('hex');
      downloads.set(dlId, { url: srcUrl, filename, status: 'downloading', received: 0, total: 0, error: null });
      fetchToInstallers(dlId, srcUrl, filename);
      logEvent('package', `Auto-fetching ${prod.name} installer (${os})`);
      fetched.push(filename);
    }
  }
  return { bumped, fetched };
}

function runMaxonVersionCheck() {
  checkMaxonVersions(db, logEvent, config)
    .then((bumped) => {
      if (bumped.length) { console.log('Maxon catalog auto-updated:', bumped.join(', ')); notifySlack(`🆕 New version detected: ${bumped.join(', ')}`); }
      return autoFetchMaxonInstallers();
    })
    .then(() => checkExtraVersions())
    .then((r) => {
      if (r.bumped.length || r.fetched.length) console.log('Blender/FFmpeg/NotchLC/NVIDIA:', JSON.stringify(r));
      if (r.bumped.length) notifySlack(`🆕 New version detected: ${r.bumped.join(', ')}`);
      return checkCustomVersions();
    })
    .then((r) => {
      if (r.bumped.length || r.fetched.length) console.log('Custom products:', JSON.stringify(r));
      if (r.bumped.length) notifySlack(`🆕 New version detected: ${r.bumped.join(', ')}`);
    })
    .catch((e) => console.error('version/installer check failed:', e.message));
}
setTimeout(runMaxonVersionCheck, 10 * 1000);
setInterval(runMaxonVersionCheck, 6 * 60 * 60 * 1000);

// Built-in install commands for SELF-CONTAINED apps (no license server / no first-run
// setup), so auto-deploy can install them from scratch even if they were never deployed
// manually. Kept in sync with INSTALL_PRESETS in public/app.js. Licensed apps
// (Adobe / Maxon) are intentionally NOT here — they must be deployed once manually to
// "learn" their silent-install command before auto-deploy will fan them out.
const SERVER_PRESETS = {
  blender: {
    windows: 'msiexec /i "{file}" /qn /norestart',
    macos: 'F="{file}"; M=$(mktemp -d); hdiutil attach "$F" -nobrowse -mountpoint "$M" >/dev/null 2>&1; '
      + 'A=$(find "$M" -maxdepth 2 -name "Blender.app" | head -1); '
      + 'if [ -n "$A" ]; then rm -rf /Applications/Blender.app; cp -R "$A" /Applications/; R=$?; else R=1; fi; '
      + 'hdiutil detach "$M" >/dev/null 2>&1; exit $R',
  },
  ffmpeg: {
    windows: 'rd /s /q "%TEMP%\\ffx" 2>nul & mkdir "%TEMP%\\ffx" & tar -xf "{file}" -C "%TEMP%\\ffx" & '
      + 'mkdir "C:\\ProgramData\\TrackerAgent\\ffmpeg" 2>nul & '
      + 'for /r "%TEMP%\\ffx" %i in (ffmpeg.exe ffprobe.exe) do copy /y "%i" "C:\\ProgramData\\TrackerAgent\\ffmpeg\\" >nul & ver >nul',
    macos: 'F="{file}"; D=$(mktemp -d); unzip -o "$F" -d "$D" >/dev/null 2>&1; '
      + 'B=$(find "$D" -maxdepth 2 -name ffmpeg -type f | head -1); '
      + 'if [ -n "$B" ]; then mkdir -p /usr/local/bin; cp "$B" /usr/local/bin/ffmpeg; chmod +x /usr/local/bin/ffmpeg; R=$?; else R=1; fi; '
      + 'rm -rf "$D"; exit $R',
  },
  // NotchLC Adobe CC Plugin — NSIS installer on Windows (silent = /S); a .pkg on macOS.
  notchlc: {
    windows: '"{file}" /S',
    macos: 'installer -pkg "{file}" -target /',
  },
  // NVIDIA GeForce Studio driver — Windows-only. Unattended flags: -s (silent),
  // -noreboot (never surprise-reboot a render node). We deliberately do NOT use -clean:
  // a clean install removes the existing driver first, so if the install then fails the
  // node is left with NO working driver. An in-place upgrade keeps the old driver intact
  // on failure. (The agent also defers the install while the GPU is rendering.)
  nvidia: {
    windows: '"{file}" -s -noreboot',
  },
};
// "Missing" only counts as a genuine gap (→ install from scratch) when the node runs an
// agent that can actually detect that product. Otherwise an old agent that simply doesn't
// look for the app would be treated as missing and get a needless duplicate install.
const MISSING_MIN_AGENT = { ffmpeg: '2.11.0', blender: '2.10.0', notchlc: '2.13.0', nvidia: '2.16.0' };

// ---- per-app auto-deploy (canary-first) ----------------------------------
// For each product with autodeploy=1, roll its newest version out automatically:
// FIRST to a single canary node, and only after that succeeds fan out to the rest.
// Covers patches AND new majors (behind nodes; side-by-side for majors) AND nodes that
// LACK the app entirely (installs from scratch). Render-gated by the agent, online-only,
// and idempotent — safe to run on a timer. Reuses the install command from a prior deploy
// of the same product; for self-contained apps (Blender/FFmpeg) it falls back to the
// built-in SERVER_PRESETS so they install with no prior manual deploy.
function runAutoDeploy() {
  if (!inMaintenanceWindow()) return;   // outside the maintenance window — hold off
  const offlineMs = (config.offlineAfterSeconds || 180) * 1000;
  const now = Date.now();
  let files = null;
  for (const prod of db.prepare('SELECT * FROM products WHERE autodeploy = 1').all()) {
    if (!isTracked(prod)) continue;   // app toggled off — don't auto-deploy it
    if (!prod.latest_version) continue;
    for (const os of ['windows', 'macos']) {
      if (!appliesToOS(prod.key, os)) continue;   // Windows-only product (NVIDIA driver)
      // Per-OS target version (NotchLC differs win vs mac); fall back to latest_version.
      const V = (os === 'windows' ? prod.latest_win : prod.latest_mac) || prod.latest_version;
      if (!V) continue;
      const nodes = db.prepare(
        'SELECT n.*, s.version AS iv FROM nodes n LEFT JOIN software s ON s.node_id = n.id AND s.product_key = ? WHERE n.os = ?'
      ).all(prod.key, os);
      const online = (n) => n.last_seen != null && now - n.last_seen < offlineMs;
      // A node needs the rollout if it's behind (has it, older than V) OR missing it
      // entirely — but "missing" only counts when this node's agent can actually detect
      // the product (else an old agent that never looks would get a duplicate install).
      const minAgent = MISSING_MIN_AGENT[prod.key];
      const missingCounts = (n) => !minAgent || (n.agent_version && cmpVersionServer(n.agent_version, minAgent) >= 0);
      // The NVIDIA driver only "applies" to a node that actually HAS an NVIDIA GPU — a
      // GPU-less / AMD Windows box has no nvidia-smi, so it reports no driver and would
      // otherwise look "missing" and get a needless GeForce install. Gate on the GPU the
      // health telemetry reports. (Nodes that DO report a driver version are NVIDIA by
      // definition, so this only bites the missing-install path.)
      const gpuOk = (n) => prod.key !== 'nvidia'
        || ((/nvidia/i.test(n.gpu || '') || !!n.iv) && !NVIDIA_EOL_GPU.test(n.gpu || ''));
      // A node that already has a SUCCESSFUL install job for this exact version is done —
      // even if its detected version hasn't caught up yet (the NVIDIA driver only reports
      // the new version after a reboot). Without this the node would be re-queued every
      // cycle during the install→reboot window.
      const installed = new Set(db.prepare(
        "SELECT DISTINCT j.node_id FROM jobs j JOIN packages p ON p.id = j.package_id WHERE p.product_key = ? AND p.version = ? AND p.os = ? AND j.status = 'success'"
      ).all(prod.key, V, os).map((r) => r.node_id));
      const needs = (n) => (n.iv ? cmpVersionServer(n.iv, V) < 0 : missingCounts(n));
      const eligible = nodes.filter((n) =>
        needs(n) && gpuOk(n) && online(n) && !installed.has(n.id) && !activeJobForProduct(n.id, prod.key));
      if (!eligible.length) continue;
      // canary state for this product@version
      const vjobs = db.prepare(
        'SELECT j.status FROM jobs j JOIN packages p ON p.id = j.package_id WHERE p.product_key = ? AND p.version = ? AND p.os = ?'
      ).all(prod.key, V, os);
      const proven = nodes.some((n) => n.iv && cmpVersionServer(n.iv, V) >= 0) || vjobs.some((j) => j.status === 'success');
      const inflight = vjobs.some((j) => ['pending', 'downloading', 'installing'].includes(j.status));
      const halted = !proven && !inflight && vjobs.some((j) => ['failed', 'cancelled'].includes(j.status));
      let target;
      if (proven) { _haltAlerted.delete(`${prod.key}|${V}|${os}`); target = eligible; } // validated → fan out
      else if (inflight) continue;              // canary running → wait
      else if (halted) {                        // canary failed/cancelled → stop; needs a manual look
        const hk = `${prod.key}|${V}|${os}`;
        if (!_haltAlerted.has(hk)) { _haltAlerted.add(hk); notifySlack(`🛑 Auto-deploy halted: *${prod.name} ${V}* (${os}) — the canary install failed. It won't fan out until you look. (Updates tab)`); }
        continue;
      }
      else target = [eligible[0]];              // first run → one canary node
      // find or create the package for this product@version+os (reuse a prior install command)
      let pkg = db.prepare('SELECT * FROM packages WHERE product_key=? AND version=? AND os=? ORDER BY id DESC LIMIT 1').get(prod.key, V, os);
      if (!pkg) {
        const last = db.prepare('SELECT * FROM packages WHERE product_key=? AND os=? ORDER BY id DESC LIMIT 1').get(prod.key, os);
        // Built-in preset, or a custom product's own install command (so customs auto-deploy too).
        const builtin = (SERVER_PRESETS[prod.key] && SERVER_PRESETS[prod.key][os])
          || (os === 'windows' ? prod.install_cmd_win : prod.install_cmd_mac);
        let filename, install_command, kind;
        if (last) {                             // reuse the learned command from a prior deploy
          filename = last.filename; install_command = last.install_command; kind = last.kind;
        } else if (builtin) {                   // self-contained app, never deployed — use built-in command
          install_command = builtin; kind = 'installer';
        } else {
          continue;                             // licensed app never deployed manually — no command to use
        }
        if (kind !== 'command') {               // installer: the staged file must match V
          if (!files) files = listInstallerFiles();
          const staged = findStagedInstaller(prod.key, os, V, files);
          const sv = staged ? versionFromFilename(staged.name) : null;
          if (!sv || cmpVersionServer(sv, V) < 0) continue; // installer for V not staged yet
          filename = staged.name;
        }
        const id = Number(db.prepare(
          'INSERT INTO packages (product_key, version, os, filename, install_command, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(prod.key, V, os, filename, install_command, kind, now).lastInsertRowid);
        pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(id);
      }
      const queued = [];
      for (const n of target) {
        if (activeJobForProduct(n.id, prod.key)) continue;
        db.prepare('INSERT INTO jobs (package_id, node_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(pkg.id, n.id, 'pending', now, now);
        queued.push(n.hostname);
      }
      if (queued.length) {
        logEvent('deploy', `Auto-deploy ${proven ? 'fan-out' : 'canary'}: ${prod.name} ${V} (${os}) → ${queued.join(', ')}`);
      }
    }
  }
}
setTimeout(runAutoDeploy, 30 * 1000);
setInterval(runAutoDeploy, 3 * 60 * 1000);

// Reaper: a job whose agent died mid-run (e.g. agent restarted) would otherwise
// sit "installing" forever. Mark any non-terminal job that hasn't been updated in
// jobStaleMinutes as failed, so the dashboard never shows phantom activity.
const JOB_STALE_MS = (config.jobStaleMinutes || 45) * 60 * 1000;
function reapStaleJobs() {
  const now = Date.now();
  // Only IN-FLIGHT jobs go stale on the short clock (an agent died mid-job).
  // Waiting in the queue is healthy — big rollouts queue for hours — so
  // 'pending' is only reaped after a day (machine gone / never coming back).
  // Pull the job's target product/version and the node's currently-detected
  // version, so we can tell a genuinely-dead job from one that actually finished
  // installing right before its agent restarted (and so never reported "done").
  const stale = db.prepare(
    `SELECT j.id, p.product_key, p.version AS target_version, j.node_id,
            s.version AS installed_version
       FROM jobs j
       JOIN packages p ON p.id = j.package_id
       LEFT JOIN software s ON s.node_id = j.node_id AND s.product_key = p.product_key
      WHERE (j.status IN ('downloading','installing') AND j.updated_at < ?)
         OR (j.status = 'pending' AND j.updated_at < ?)`
  ).all(now - JOB_STALE_MS, now - 24 * 3600 * 1000);
  let verified = 0, failed = 0;
  for (const j of stale) {
    // If the machine already reports the target version (or newer), the install
    // succeeded — the agent just restarted before it could acknowledge. Mark success.
    const done = j.installed_version &&
      cmpVersionServer(j.installed_version, j.target_version) >= 0;
    if (done) {
      db.prepare("UPDATE jobs SET status='success', log=COALESCE(log,'')||?, updated_at=? WHERE id=?")
        .run(`\n[verified: ${j.product_key} ${j.installed_version} is installed — install completed before the agent restarted]`, Date.now(), j.id);
      verified++;
    } else {
      db.prepare("UPDATE jobs SET status='failed', log=COALESCE(log,'')||?, updated_at=? WHERE id=?")
        .run('\n[timed out: no agent progress — likely agent restart]', Date.now(), j.id);
      failed++;
    }
  }
  if (verified) logEvent('job', `Reaper verified ${verified} stalled job(s) as already installed`);
  if (failed) logEvent('job', `Reaped ${failed} stalled job(s) with no agent progress`);
}
setInterval(reapStaleJobs, 5 * 60 * 1000);
reapStaleJobs();

// All folders that may hold installer files: the local cache first, then mirrors.
// Directory new downloads are written to (writable; prefers config.downloadDir → share → local).
function downloadDir() {
  for (const d of [config.downloadDir, ...(config.installerSources || []), INSTALLERS_DIR].filter(Boolean)) {
    try { fs.accessSync(d, fs.constants.W_OK); return d; } catch { /* not writable / missing */ }
  }
  return INSTALLERS_DIR;
}
// All folders searched for staged installers (includes the download dir).
function installerDirs() {
  const dirs = [INSTALLERS_DIR, config.downloadDir, ...config.installerSources];
  return [...new Set(dirs.filter((d) => d && fs.existsSync(d)))];
}

// Resolve a filename (basename) to a full path, searching cache then mirrors.
function resolveInstaller(filename) {
  const base = path.basename(filename);
  for (const dir of installerDirs()) {
    const full = path.join(dir, base);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  }
  return null;
}

// SHA256 of an installer, cached by path+mtime+size so we hash a big file once.
const hashCache = new Map();
function installerSha256(fullPath) {
  try {
    const st = fs.statSync(fullPath);
    const key = `${fullPath}:${st.size}:${st.mtimeMs}`;
    const cached = hashCache.get(fullPath);
    if (cached && cached.key === key) return cached.sha;
    // Stream the file in chunks — installers exceed Node's 2GB Buffer limit.
    const h = crypto.createHash('sha256');
    const fd = fs.openSync(fullPath, 'r');
    try {
      const buf = Buffer.allocUnsafe(8 * 1024 * 1024);
      let n;
      while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
        h.update(n === buf.length ? buf : buf.subarray(0, n));
      }
    } finally { fs.closeSync(fd); }
    const sha = h.digest('hex');
    hashCache.set(fullPath, { key, sha });
    return sha;
  } catch { return null; }
}

// List installer files across all sources (deduped by name, cache wins).
function listInstallerFiles() {
  const seen = new Map();
  for (const dir of installerDirs()) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      if (f.startsWith('.') || f.endsWith('.part') || seen.has(f)) continue;
      const full = path.join(dir, f);
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile()) continue;
      seen.set(f, { name: f, size: st.size, source: dir === INSTALLERS_DIR ? 'cache' : dir });
    }
  }
  return [...seen.values()];
}

// Find an installer already staged in the repo (cache/share) matching a product
// + OS (+ optional version). Industry-standard "is it in the repo already?" check.
const PRODUCT_KEYWORDS = {
  cinema4d: [/cinema\s*4?d/i, /\bc4d\b/i],
  redshift: [/redshift/i],
  redgiant: [/red\s*giant/i, /trapcode/i, /magic\s*bullet/i, /universe/i],
  aftereffects: [/after\s*effects/i, /\baep?\b/i, /aftereffects/i],
  maxonapp: [/maxon[\s_-]*app/i, /maxon[\s_-]*one/i],
  creativecloud: [/creative[\s_-]*cloud/i, /\baccc\b/i],
  blender: [/blender/i],
  ffmpeg: [/ffmpeg/i],
  notchlc: [/notch/i],
  nvidia: [/nvidia/i, /geforce/i, /nsd.*dch/i],
};
function findStagedInstaller(productKey, os, version, files) {
  const kws = PRODUCT_KEYWORDS[productKey] || [];
  const osOk = (name) => os === 'windows'
    ? /win|x64|\.exe$|\.msi$/i.test(name)
    : /mac|osx|darwin|\.dmg$|\.pkg$/i.test(name);
  const matches = (files || listInstallerFiles()).filter((f) =>
    kws.some((re) => re.test(f.name)) && osOk(f.name));
  if (!matches.length) return null;
  // Prefer an exact version match, else newest-looking by version digits in name.
  const verDigits = (s) => (String(s).match(/\d+/g) || []).map(Number);
  if (version) {
    const exact = matches.find((f) => f.name.includes(version) ||
      verDigits(f.name).join('.').includes(verDigits(version).join('.')));
    if (exact) return exact;
  }
  matches.sort((a, b) => {
    const va = verDigits(a.name), vb = verDigits(b.name);
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
      if ((va[i] || 0) !== (vb[i] || 0)) return (va[i] || 0) - (vb[i] || 0);
    }
    return 0;
  });
  return matches[matches.length - 1];
}

// ---------------------------------------------------------------- helpers --
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function agentAuthorized(req) {
  return req.headers['x-agent-key'] === config.agentKey;
}

function lanAddress() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}

// ---- Slack alerts --------------------------------------------------------
// Post a message to the configured Slack incoming webhook (no-op if none set).
function notifySlack(text) {
  if (!config.slackWebhook) return;
  try {
    const u = new URL(config.slackWebhook);
    const data = JSON.stringify({ text });
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 10000,
    }, (res) => res.resume());
    req.on('error', (e) => console.error('Slack notify failed:', e.message));
    req.on('timeout', () => req.destroy());
    req.write(data); req.end();
  } catch (e) { console.error('Slack notify error:', e.message); }
}

// Dedupe sets so Slack gets ONE alert per event, not one per timer tick.
const _haltAlerted = new Set();
// Alert (once) when a node stays offline a while, and once when it returns.
const _offlineAlerted = new Set();
function checkOfflineAlerts() {
  if (!config.slackWebhook) return;
  const offlineMs = (config.offlineAfterSeconds || 180) * 1000;
  const graceMs = 15 * 60 * 1000;
  const now = Date.now();
  for (const n of db.prepare('SELECT id, hostname, last_seen FROM nodes').all()) {
    const longOff = n.last_seen != null && now - n.last_seen > graceMs;
    const off = n.last_seen == null || now - n.last_seen > offlineMs;
    if (off && longOff) {
      if (!_offlineAlerted.has(n.id)) { _offlineAlerted.add(n.id); notifySlack(`⚠️ *${n.hostname}* has been offline for 15+ minutes.`); }
    } else if (!off && _offlineAlerted.delete(n.id)) {
      notifySlack(`✅ *${n.hostname}* is back online.`);
    }
  }
}
setInterval(checkOfflineAlerts, 5 * 60 * 1000);

// ---- Auto-deploy maintenance window -------------------------------------
// True when auto-deploy is allowed to run now (always true if no window is set).
function inMaintenanceWindow() {
  const mw = config.maintenanceWindow;
  if (!mw || !mw.enabled) return true;
  const toMin = (s) => { const [h, m] = String(s).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const s = toMin(mw.start), e = toMin(mw.end);
  if (s === e) return true;
  const d = new Date(), now = d.getHours() * 60 + d.getMinutes();
  return s < e ? (now >= s && now < e) : (now >= s || now < e);  // handles overnight windows
}

// Reboot a node through Deadline's RemoteControl (the Deadline Worker reboots the
// machine). This works even when the tracker AGENT is wedged, because it goes through
// the Worker, not the agent — exactly what's needed to recover a hung agent.
const DEADLINE_CMD = config.deadlineCommand ||
  (process.platform === 'darwin' ? '/Applications/Thinkbox/Deadline10/Resources/deadlinecommand'
    : process.platform === 'win32' ? 'C:\\Program Files\\Thinkbox\\Deadline10\\bin\\deadlinecommand.exe'
      : '/opt/Thinkbox/Deadline10/bin/deadlinecommand');
function rebootViaDeadline(hostname) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(DEADLINE_CMD)) {
      return reject(new Error(`deadlinecommand not found at ${DEADLINE_CMD} (set config.deadlineCommand)`));
    }
    execFile(DEADLINE_CMD, ['RemoteControl', hostname, 'RestartMachine'], { timeout: 15000 }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`.trim();
      // Check FAILURE first: deadlinecommand prints a generic "Sent remote command" line
      // even when it fails, alongside the real reason (e.g. "could not resolve Worker
      // name … may not exist on the network"). So a named error wins.
      if (/could not|cannot connect|may not exist|no .*(slave|worker)|unable|invalid|denied|exception|not found|failed to/i.test(out)) {
        return reject(new Error(out.replace(/\s+/g, ' ').slice(0, 300)));
      }
      // Clear success: the Worker accepted the command.
      if (/Connection Accepted/i.test(out)) return resolve({ confirmed: true });
      // Ambiguous (timeout / empty): the machine very often reboots before deadlinecommand
      // gets a reply, so it actually worked. Report SENT-unconfirmed, not a scary failure —
      // the node going offline then returning is the real confirmation.
      return resolve({ confirmed: false });
    });
  });
}

// IPv4 directed-broadcast address for an interface (addr | ~netmask).
function ipv4Broadcast(addr, mask) {
  const a = addr.split('.').map(Number), m = mask.split('.').map(Number);
  if (a.length !== 4 || m.length !== 4) return null;
  return a.map((o, i) => ((o & m[i]) | (~m[i] & 255))).join('.');
}

// Wake-on-LAN — power a machine on by broadcasting a "magic packet" to its NIC MAC(s).
// On a MULTI-HOMED server the limited broadcast 255.255.255.255 only egresses one NIC and
// is unreliable, so we send the packet out EVERY local IPv4 interface to its directed
// subnet broadcast (e.g. 10.10.10.255), plus the node's own /24 broadcast and the limited
// broadcast as belt-and-suspenders. Needs WoL enabled in the target's BIOS/NIC.
function wakeOnLan(macs, nodeIp) {
  const dgram = require('node:dgram');
  const os = require('node:os');
  const list = (Array.isArray(macs) ? macs : String(macs || '').split(','))
    .map((m) => m.replace(/[^0-9a-fA-F]/g, ''))
    .filter((m) => m.length === 12);
  if (!list.length) return 0;
  const packets = list.map((hex) => {
    const mac = Buffer.from(hex, 'hex');
    const pkt = Buffer.alloc(102, 0xff);                    // 6×0xFF preamble…
    for (let i = 0; i < 16; i++) mac.copy(pkt, 6 + i * 6);  // …then the MAC ×16
    return pkt;
  });
  // Targets: each local interface's directed broadcast (bound to that NIC) + 255.255.255.255.
  const targets = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of (ifaces[name] || [])) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      const b = ipv4Broadcast(ni.address, ni.netmask);
      if (b) targets.push({ addr: b, bind: ni.address });
      targets.push({ addr: '255.255.255.255', bind: ni.address });
    }
  }
  // The node's own /24 broadcast (handles a routed subnet or a missing interface match).
  const ip4 = String(nodeIp || '').replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip4)) targets.push({ addr: ip4.replace(/\.\d+$/, '.255'), bind: null });

  for (const t of targets) {
    const sock = dgram.createSocket('udp4');
    sock.once('error', () => { try { sock.close(); } catch { /* ignore */ } });
    const fire = () => {
      try { sock.setBroadcast(true); } catch { /* ignore */ }
      for (const pkt of packets) for (const port of [9, 7]) sock.send(pkt, 0, pkt.length, port, t.addr, () => {});
      setTimeout(() => { try { sock.close(); } catch { /* ignore */ } }, 400);
    };
    try { if (t.bind) sock.bind({ address: t.bind }, fire); else sock.bind(fire); }
    catch { try { sock.close(); } catch { /* ignore */ } }
  }
  return list.length;
}

// One-time ELEVATED setup (Windows): re-install the agent as a Scheduled Task
// running as the logged-on user with HIGHEST privileges — elevated (no UAC on
// installers) but still in the user's session (so mx1's Maxon login stays valid).
// Run once per node from an *elevated* PowerShell:  irm http://<server>/elevate.ps1 | iex
function winElevateScript(base) {
  return `$ErrorActionPreference = "Stop"
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this from an ELEVATED (Administrator) PowerShell."
}
$dir = "$env:ProgramData\\TrackerAgent"
$py = "C:\\Program Files\\Thinkbox\\Deadline10\\bin\\python3\\python.exe"
if (-not (Test-Path $py)) { $py = (Get-Command python.exe -ErrorAction SilentlyContinue).Source }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Invoke-WebRequest "${base}/agent" -OutFile "$dir\\render_agent.py" -UseBasicParsing
# Run elevated as SYSTEM so the agent works fully HEADLESS — no interactive login
# required (render nodes often run logged-off). $who is just for the status message.
$who = (Get-CimInstance Win32_ComputerSystem).UserName
if (-not $who) { $who = "$env:COMPUTERNAME\\trm" }
# Remove the old non-elevated agent (HKCU Run key + running process).
Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*render_agent.py*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" -Name "TrackerAgent" -ErrorAction SilentlyContinue
$arg = '"' + "$dir\\render_agent.py" + '" --server ${base} --key ${config.agentKey} --interval 60'
$act = New-ScheduledTaskAction -Execute $py -Argument $arg
# Two triggers: AtStartup AND an independent 5-min heartbeat. The heartbeat is a
# STANDALONE time trigger (not attached to AtStartup), so the agent relaunches every
# 5 min regardless of how the machine powered on -- even if AtStartup never fires
# (Windows Fast Startup resumes instead of cold-booting). The single-instance mutex
# makes a re-fire a harmless no-op while the agent is already running.
$boot = New-ScheduledTaskTrigger -AtStartup
$beat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(-1) \`
  -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$prin = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
$set = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Days 3650) \`
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable \`
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
# Disable Windows Fast Startup so a shutdown is a TRUE cold boot (AtStartup fires; WoL works).
Set-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power" \`
  -Name HiberbootEnabled -Value 0 -Type DWord -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName "TrackerAgentElevated" -Action $act -Trigger @($boot,$beat) \`
  -Principal $prin -Settings $set -Force | Out-Null
Start-ScheduledTask -TaskName "TrackerAgentElevated"
Write-Host "Elevated tracker agent installed as SYSTEM (headless, highest privileges) on $env:COMPUTERNAME — runs with no login required; installs run without UAC."
`;
}

// Staging batch (Windows): a node runs `mx1 package download <ident>` then
// uploads the installer to the tracker cache, so the whole farm reuses one copy.
// Usage on node:  trk_stage.bat <maxon-identifier>
function winStageScript(base) {
  return `@echo off
setlocal enabledelayedexpansion
set IDENT=%1
if "%IDENT%"=="" (echo no identifier & exit /b 1)
set D=%TEMP%\\trkstage_%RANDOM%
mkdir "%D%" 2>nul
pushd "%D%"
echo Downloading %IDENT% via mx1 ...
"C:\\Program Files\\Maxon\\Tools\\mx1.exe" package download %IDENT%
set FOUND=0
for %%F in ("%D%\\*.exe" "%D%\\*.dmg" "%D%\\*.pkg" "%D%\\*.msi") do (
  echo Uploading %%~nxF to tracker ...
  curl.exe -s -X POST -H "X-Agent-Key: ${config.agentKey}" --data-binary @"%%F" "${base}/api/agent/upload?filename=%%~nxF"
  set FOUND=1
)
popd
rmdir /s /q "%D%" 2>nul
if "!FOUND!"=="0" (echo no installer produced & exit /b 2)
echo staged OK
`;
}

// ------------------------------------------------- node bootstrap scripts ---
// One-line enrolment, served by this server with URL + key baked in:
//   macOS:   curl -fsSL http://<server>/setup.sh | sudo bash
//   Windows: irm http://<server>/setup.ps1 | iex     (elevated PowerShell)

function macSetupScript(base) {
  return `#!/bin/bash
# Tracker agent bootstrap (macOS). Run:  curl -fsSL ${base}/setup.sh | sudo bash
set -e
[ "$(id -u)" = 0 ] || { echo "Please run with sudo"; exit 1; }
mkdir -p /usr/local/tracker
curl -fsSL "${base}/agent" -o /usr/local/tracker/render_agent.py
cat > /Library/LaunchDaemons/com.tracker.agent.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.tracker.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>/usr/local/tracker/render_agent.py</string>
    <string>--server</string><string>${base}</string>
    <string>--key</string><string>${config.agentKey}</string>
    <string>--interval</string><string>60</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/var/log/tracker-agent.log</string>
  <key>StandardErrorPath</key><string>/var/log/tracker-agent.log</string>
</dict>
</plist>
PLIST
# Remove the unprivileged per-user agent first, so we don't run two agents.
CONSOLE_USER=$(stat -f%Su /dev/console 2>/dev/null)
if [ -n "$CONSOLE_USER" ] && [ "$CONSOLE_USER" != "root" ]; then
  CU_UID=$(id -u "$CONSOLE_USER" 2>/dev/null)
  [ -n "$CU_UID" ] && launchctl bootout gui/$CU_UID/com.tracker.agent 2>/dev/null || true
  rm -f "/Users/$CONSOLE_USER/Library/LaunchAgents/com.tracker.agent.plist" 2>/dev/null || true
fi
pkill -f "/Users/[^/]*/tracker/render_agent.py" 2>/dev/null || true
launchctl bootout system/com.tracker.agent 2>/dev/null || true
launchctl bootstrap system /Library/LaunchDaemons/com.tracker.agent.plist
echo "Tracker agent installed as root LaunchDaemon. Node updates as root (no prompts)."
echo "Log: /var/log/tracker-agent.log"
`;
}

// ---- Non-privileged variants: per-user service, no sudo/admin required.
// Used for push-enrolment via Deadline RemoteControl (runs as the worker's user).

function macEnrollUser(base) {
  return `#!/bin/bash
set -e
DIR="$HOME/tracker"
mkdir -p "$DIR" "$HOME/Library/LaunchAgents"
curl -fsSL "${base}/agent" -o "$DIR/render_agent.py"
PL="$HOME/Library/LaunchAgents/com.tracker.agent.plist"
cat > "$PL" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.tracker.agent</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/python3</string><string>$DIR/render_agent.py</string>
    <string>--server</string><string>${base}</string>
    <string>--key</string><string>${config.agentKey}</string>
    <string>--interval</string><string>60</string>
  </array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/agent.log</string>
  <key>StandardErrorPath</key><string>$DIR/agent.log</string>
</dict></plist>
PLIST
launchctl bootout gui/\$(id -u)/com.tracker.agent 2>/dev/null || true
launchctl bootstrap gui/\$(id -u) "$PL"
echo "tracker-agent installed on \$(hostname)"
`;
}

// PowerShell that uses Deadline's bundled Python (always present on a worker).
// No-admin persistence: an HKCU Run key (starts at user logon) plus an
// immediate detached launch so the node checks in right away.
function winEnrollUser(base) {
  return `$ErrorActionPreference = "Stop"
$dir = "$env:ProgramData\\TrackerAgent"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$py = "C:\\Program Files\\Thinkbox\\Deadline10\\bin\\python3\\python.exe"
if (-not (Test-Path $py)) { $py = (Get-Command python.exe -ErrorAction SilentlyContinue).Source }
Invoke-WebRequest "${base}/agent" -OutFile "$dir\\render_agent.py" -UseBasicParsing
$script = "$dir\\render_agent.py"
$cmd = '"' + $py + '" "' + $script + '" --server ${base} --key ${config.agentKey} --interval 60'
# If this node was elevated (TrackerAgentElevated scheduled task), DON'T clobber it —
# just refresh the agent script and restart the elevated task, preserving elevation.
$elev = Get-ScheduledTask -TaskName "TrackerAgentElevated" -ErrorAction SilentlyContinue
if ($elev) {
  Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*render_agent.py*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-ScheduledTask -TaskName "TrackerAgentElevated"
  Write-Host "tracker-agent (elevated) refreshed on $env:COMPUTERNAME"
  return
}
# Kill any already-running tracker agent so re-enrolment never stacks duplicates.
Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*render_agent.py*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
# Persist across reboots (runs at this user's logon) - no admin needed.
New-Item -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" \`
  -Name "TrackerAgent" -Value $cmd
# Start now, detached, hidden, so it survives this session ending.
Start-Process -FilePath $py \`
  -ArgumentList ('"' + $script + '"'), "--server", "${base}", "--key", "${config.agentKey}", "--interval", "60" \`
  -WindowStyle Hidden
Write-Host "tracker-agent installed on $env:COMPUTERNAME"
`;
}

function winSetupScript(base) {
  return `# Tracker agent bootstrap (Windows). Run from an ELEVATED PowerShell:
#   irm ${base}/setup.ps1 | iex
$ErrorActionPreference = "Stop"
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this from an elevated (Administrator) PowerShell."
}
$python = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
if (-not $python) {
  $py = (Get-Command py.exe -ErrorAction SilentlyContinue).Source
  if ($py) { $python = (& $py -3 -c "import sys; print(sys.executable)") }
}
if (-not $python) {
  Write-Host "Python 3 not found - attempting install via winget..."
  winget install -e --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements
  Write-Host "Python installed. Close this window, open a NEW elevated PowerShell, and run the command again."
  exit 1
}
$dest = "C:\\ProgramData\\TrackerAgent"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Invoke-WebRequest "${base}/agent" -OutFile "$dest\\render_agent.py" -UseBasicParsing
$action = New-ScheduledTaskAction -Execute $python \`
  -Argument "\`"$dest\\render_agent.py\`" --server \`"${base}\`" --key \`"${config.agentKey}\`" --interval 60"
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Days 3650) \`
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
Register-ScheduledTask -TaskName "TrackerAgent" -Action $action -Trigger $trigger \`
  -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "TrackerAgent"
Write-Host "Tracker agent installed. This node should appear on the dashboard within a minute."
`;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, relPath) {
  const file = path.join(PUBLIC_DIR, relPath);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    // No caching — the dashboard is updated in place, so every reload must get the latest
    // HTML/JS/CSS (no stale UI after a deploy).
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
  fs.createReadStream(file).pipe(res);
}

// ------------------------------------------------------------ API: state ---
function fullState() {
  const now = Date.now();
  const offlineMs = config.offlineAfterSeconds * 1000;

  const nodes = db.prepare('SELECT * FROM nodes ORDER BY hostname').all().map((n) => ({
    ...n,
    online: n.last_seen != null && now - n.last_seen < offlineMs,
    software: db
      .prepare('SELECT product_key, version, install_path, detected_at FROM software WHERE node_id = ?')
      .all(n.id),
  }));

  // Which products already have a staged installer in the repo (per OS) — drives
  // the wizard's "download once, reuse" default.
  const files = listInstallerFiles();
  const products = db.prepare('SELECT * FROM products ORDER BY name').all().map((p) => {
    const win = findStagedInstaller(p.key, 'windows', p.latest_version, files);
    const mac = findStagedInstaller(p.key, 'macos', p.latest_version, files);
    return { ...p, staged_win: win ? win.name : null, staged_mac: mac ? mac.name : null };
  });

  return {
    now,
    monitoring: { active: config.monitoringActive },
    latestAgentVersion: LATEST_AGENT_VERSION,   // newest Beacon the server serves — flags out-of-date agents
    maxConcurrentInstalls: config.maxConcurrentInstalls || 4,
    slackWebhook: config.slackWebhook || '',
    maintenanceWindow: config.maintenanceWindow || { enabled: false, start: '22:00', end: '06:00' },
    downloadDir: downloadDir(),
    installerSources: [...new Set([config.downloadDir, '/Volumes/THIS-server/INSTALLERS', INSTALLERS_DIR, ...config.installerSources].filter(Boolean))],
    nodes,
    products,
    packages: db.prepare('SELECT * FROM packages ORDER BY created_at DESC').all(),
    jobs: db
      .prepare(
        `SELECT j.*, n.hostname, p.product_key, p.version AS package_version, p.os AS package_os
           FROM jobs j
           JOIN nodes n ON n.id = j.node_id
           JOIN packages p ON p.id = j.package_id
          ORDER BY j.id DESC LIMIT 200`
      )
      .all()
      .map((j) => {
        // Live LAN-transfer progress for jobs currently downloading their installer.
        const dp = DL_PROGRESS.get(j.id);
        if (dp) return { ...j, dl_pct: Math.min(100, Math.floor((dp.sent / dp.total) * 100)) };
        // Install progress: elapsed vs the learned duration for this product/OS.
        if (j.status === 'installing') {
          const expected = INSTALL_EMA.get(`${j.product_key}|${j.package_os}`) || 5 * 60 * 1000;
          const elapsed = now - j.updated_at;
          // No progress for far longer than this product usually takes => the agent's
          // installer is probably stuck. Flag it so the UI shows "stalled" instead of a
          // bar frozen near 100% (which read as a phantom "active" job).
          const stalled = elapsed > Math.max(expected * 3, 20 * 60 * 1000);
          // Past the typical install time but not (yet) stalled: still legitimately running.
          // The UI shows an indeterminate "finishing…" bar for this instead of a frozen 97%.
          const overrun = !stalled && elapsed > expected;
          return {
            ...j,
            inst_pct: Math.min(97, Math.floor((elapsed / expected) * 100)),
            inst_eta_ms: Math.max(0, expected - elapsed),
            inst_overrun: overrun,
            stalled,
          };
        }
        return j;
      }),
    events: db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 100').all(),
  };
}

// ------------------------------------------------------ API: agent check-in -
function handleCheckin(body) {
  // Strip the DNS/mDNS suffix: macOS flips between "<name>.lan" (DHCP) and
  // "<name>.local" (Bonjour), which would register the same machine twice.
  // The short name is stable across both, so key on it.
  const hostname = String(body.hostname || '').trim().split('.')[0];
  const os = body.os === 'windows' || body.os === 'macos' ? body.os : null;
  if (!hostname || !os) throw new Error('hostname and os (windows|macos) are required');

  const now = Date.now();
  let node = db.prepare('SELECT * FROM nodes WHERE hostname = ?').get(hostname);
  if (!node) {
    db.prepare(
      'INSERT INTO nodes (hostname, os, ip, agent_version, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(hostname, os, body.ip || null, body.agentVersion || null, now, now);
    node = db.prepare('SELECT * FROM nodes WHERE hostname = ?').get(hostname);
    logEvent('node', `New node registered: ${hostname} (${os})`);
  } else {
    db.prepare('UPDATE nodes SET os = ?, ip = ?, agent_version = ?, last_seen = ? WHERE id = ?')
      .run(os, body.ip || node.ip, body.agentVersion || node.agent_version, now, node.id);
  }
  // Elevation status (only sent by full check-ins / newer agents).
  if (typeof body.elevated === 'boolean') {
    db.prepare('UPDATE nodes SET elevated = ? WHERE id = ?').run(body.elevated ? 1 : 0, node.id);
  }
  // Machine health / GPU telemetry (sent ~every 5 min by 2.15.0+ agents).
  if (body.health && typeof body.health === 'object') {
    const hh = body.health;
    // Stable identity fields (gpu, driver, OS) are COALESCEd: a single missed reading
    // must NOT wipe them. nvidia-smi briefly returns empty during a driver install
    // (especially -clean), which would otherwise null out a node's GPU and make a real
    // NVIDIA node look GPU-less. Keep the last known value until a good reading replaces
    // it. Disk + pending-reboot reflect current state, so they update every time.
    const macsCsv = Array.isArray(hh.macs) && hh.macs.length
      ? hh.macs.map(String).join(',') : null;   // for Wake-on-LAN; COALESCE so a miss keeps it
    // gpu_util is a LIVE metric (current render load), so it's written every time, not
    // COALESCEd — a node that stops rendering must drop back to idle, not keep a stale %.
    db.prepare(`UPDATE nodes SET gpu = COALESCE(?, gpu), gpu_driver = COALESCE(?, gpu_driver),
                  disk_free_gb = ?, disk_total_gb = ?,
                  os_version = COALESCE(?, os_version), pending_reboot = ?,
                  macs = COALESCE(?, macs), gpu_util = ? WHERE id = ?`).run(
      hh.gpu != null ? String(hh.gpu) : null,
      hh.gpuDriver != null ? String(hh.gpuDriver) : null,
      typeof hh.diskFreeGB === 'number' ? hh.diskFreeGB : null,
      typeof hh.diskTotalGB === 'number' ? hh.diskTotalGB : null,
      hh.osVersion != null ? String(hh.osVersion) : null,
      hh.pendingReboot ? 1 : 0,
      macsCsv,
      typeof hh.gpuUtil === 'number' ? hh.gpuUtil : null,
      node.id);
  }

  if (Array.isArray(body.software)) {
    const del = db.prepare('DELETE FROM software WHERE node_id = ?');
    const ins = db.prepare(
      'INSERT OR REPLACE INTO software (node_id, product_key, version, install_path, detected_at) VALUES (?, ?, ?, ?, ?)'
    );
    del.run(node.id);
    for (const s of body.software) {
      if (!s || !s.product) continue;
      let ver = s.version ? String(s.version) : null;
      // After Effects is reported inconsistently across nodes ("26.3" vs "26.3.0" for the
      // same build). Canonicalize to the trimmed marketing form (drop trailing ".0") so the
      // dashboard shows one consistent string. Don't touch a real patch (26.2.1 stays).
      if (ver && String(s.product) === 'aftereffects') {
        while (ver.split('.').length > 2 && ver.endsWith('.0')) ver = ver.slice(0, -2);
      }
      ins.run(node.id, String(s.product), ver, s.path ? String(s.path) : null, now);
    }
  }

  // Self-correct the catalog from reality: if a node actually RUNS a version newer than
  // the catalog's known latest, that version is plainly available — adopt it as the latest
  // so the rest of the fleet gets flagged as behind. This catches updates that arrive
  // outside our detection channel — e.g. After Effects updated via the Creative Cloud app
  // (RUM's `--action=list` never advertises it), or a node upgraded by hand.
  if (Array.isArray(body.software)) {
    const osCol = os === 'windows' ? 'latest_win' : 'latest_mac';
    for (const s of body.software) {
      if (!s || !s.product || !s.version) continue;
      const ver = String(s.version);
      if (!/^\d/.test(ver)) continue;                 // real version strings only (skip junk)
      // After Effects is RUM-as-source-of-truth: its "latest" is whatever Adobe's RUM feed
      // offers (we can only deploy that). Don't let a node updated out-of-band via the
      // Creative Cloud app (e.g. 26.3, which RUM can't deliver) override the RUM ceiling.
      if (String(s.product) === 'aftereffects') continue;
      const prod = db.prepare('SELECT * FROM products WHERE key = ?').get(String(s.product));
      if (!prod) continue;
      if (!prod.latest_version || cmpVersionServer(ver, prod.latest_version) > 0) {
        db.prepare('UPDATE products SET latest_version = ?, updated_at = ? WHERE key = ?').run(ver, now, prod.key);
        logEvent('catalog', `Auto-detected newer ${prod.name}: ${ver} is installed on ${hostname} — adopting as latest`);
      }
      if (prod[osCol] && cmpVersionServer(ver, prod[osCol]) > 0) {   // keep per-OS latest correct too
        db.prepare(`UPDATE products SET ${osCol} = ?, updated_at = ? WHERE key = ?`).run(ver, now, prod.key);
      }
    }
  }

  // Auto-track latest available versions reported by the agent (from mx1 package
  // query) — keeps the catalog's "latest" current with no manual entry.
  if (body.latest && typeof body.latest === 'object') {
    for (const [key, ver] of Object.entries(body.latest)) {
      if (!ver) continue;
      const prod = db.prepare('SELECT * FROM products WHERE key = ?').get(key);
      if (prod && (!prod.latest_version || cmpVersionServer(String(ver), prod.latest_version) > 0)) {
        db.prepare('UPDATE products SET latest_version = ?, updated_at = ? WHERE key = ?')
          .run(String(ver), now, key);
        logEvent('catalog', `Auto-detected newer ${prod.name}: latest is now ${ver} (mx1)`);
      }
    }
  }

  // Concurrency throttle: don't let the whole farm download from the vendor at
  // once (that overwhelms Maxon/Adobe and fails). Each node runs ONE job at a
  // time, and farm-wide only `maxConcurrentInstalls` run at once.
  const limit = config.maxConcurrentInstalls || 4;
  const jobCols = `j.id, j.status, p.id AS package_id, p.product_key, p.version, p.filename, p.install_command, p.kind`;
  // This node's already-running jobs always come back (so it keeps reporting).
  const jobs = db.prepare(
    `SELECT ${jobCols} FROM jobs j JOIN packages p ON p.id = j.package_id
      WHERE j.node_id = ? AND j.status IN ('downloading', 'installing') ORDER BY j.id`
  ).all(node.id);
  // Hand out one new pending job only if this node is idle AND a global slot is free.
  if (jobs.length === 0) {
    const activeGlobal = db.prepare(
      "SELECT COUNT(*) AS c FROM jobs WHERE status IN ('downloading','installing')"
    ).get().c;
    if (activeGlobal < limit) {
      const next = db.prepare(
        `SELECT ${jobCols} FROM jobs j JOIN packages p ON p.id = j.package_id
          WHERE j.node_id = ? AND j.status = 'pending' ORDER BY j.id LIMIT 1`
      ).get(node.id);
      // Circuit breaker: don't hand out a job whose rollout has failed enough to be halted —
      // leave it queued so a broken update can't sweep the fleet. (Retry/clear lifts it.)
      if (next && rolloutHalted(next.product_key, next.version)) flagRolloutHalt(next.product_key, next.version);
      else if (next) jobs.push(next);
    }
  }

  // Attach the installer's SHA256 so the agent can verify integrity before running.
  for (const j of jobs) {
    if (j.kind !== 'command' && j.filename) {
      const full = resolveInstaller(j.filename);
      if (full) j.sha256 = installerSha256(full);
    }
  }

  // Self-update gate: agents older than SAFE_SELFUPDATE_FROM shipped a broken
  // Windows relaunch (detached child killed by the scheduled-task job object on
  // exit → bricked until reboot). Don't ask them to self-update; they receive the
  // fixed agent the safe way (elevate.ps1 / direct push). Once on >= that version
  // their relaunch is fixed and self-update is re-enabled.
  const SAFE_SELFUPDATE_FROM = '2.1.0';
  const av = body.agentVersion || node.agent_version;
  const selfUpdateOk = av && cmpVersionServer(av, SAFE_SELFUPDATE_FROM) >= 0;

  return {
    nodeId: node.id,
    active: true, // monitoring is always on (no master toggle)
    // Only advertise a target to agents that can apply it safely.
    latestAgent: selfUpdateOk ? LATEST_AGENT_VERSION : av,
    pollSeconds: Math.max(15, Math.floor(config.offlineAfterSeconds / 3)),
    jobs,
    // Agent-side reboot fallback (set when Deadline RemoteControl couldn't reach the box).
    reboot: pendingAgentReboot.delete(node.id) ? true : undefined,
    // User-added (custom) products + their detection patterns, so the agent can detect them
    // without a code change. Built-ins are hardcoded in the agent; only customs are sent.
    products: db.prepare(
      "SELECT key, detect_pattern FROM products WHERE custom = 1 AND detect_pattern IS NOT NULL AND detect_pattern != ''"
    ).all().map((r) => ({ key: r.key, pattern: r.detect_pattern })),
  };
}

// ----------------------------------------------------------------- router --
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    // -------- node enrolment --------
    if (req.method === 'GET' && p === '/agent') {
      res.writeHead(200, { 'Content-Type': 'text/x-python; charset=utf-8' });
      fs.createReadStream(path.join(ROOT, 'agents', 'render_agent.py')).pipe(res);
      return;
    }
    if (req.method === 'GET' && (p === '/setup.sh' || p === '/setup.ps1' ||
        p === '/enroll.sh' || p === '/enroll.ps1' || p === '/elevate.ps1' || p === '/stage.bat')) {
      const base = `http://${req.headers.host || lanAddress() + ':' + config.port}`;
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      const fn = { '/setup.sh': macSetupScript, '/setup.ps1': winSetupScript,
                   '/enroll.sh': macEnrollUser, '/enroll.ps1': winEnrollUser,
                   '/elevate.ps1': winElevateScript, '/stage.bat': winStageScript }[p];
      res.end(fn(base));
      return;
    }

    // -------- static UI --------
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, 'index.html');
    if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(res, p.slice(1));

    // -------- agent endpoints (X-Agent-Key) --------
    if (p.startsWith('/api/agent/')) {
      if (!agentAuthorized(req)) return sendJson(res, 401, { error: 'bad agent key' });

      if (req.method === 'POST' && p === '/api/agent/checkin') {
        const body = await readBody(req);
        body.ip = body.ip || req.socket.remoteAddress;
        return sendJson(res, 200, handleCheckin(body));
      }

      // Stage-once: a node uploads an installer it fetched (e.g. via mx1) into
      // the server cache, so every other node pulls it over the LAN instead of
      // re-downloading from the vendor. Body is the raw file; ?filename=NAME.
      if (req.method === 'POST' && p === '/api/agent/upload') {
        const filename = path.basename(url.searchParams.get('filename') || '');
        if (!filename) return sendJson(res, 400, { error: 'filename required' });
        const dest = path.join(INSTALLERS_DIR, filename);
        const tmp = dest + '.uploading';
        const out = fs.createWriteStream(tmp);
        req.pipe(out);
        out.on('finish', () => out.close(() => {
          fs.renameSync(tmp, dest);
          const mb = (fs.statSync(dest).size / 1048576).toFixed(0);
          logEvent('package', `Installer staged to server by a node: ${filename} (${mb} MB)`);
          sendJson(res, 200, { ok: true, filename });
        }));
        out.on('error', (e) => { try { fs.unlinkSync(tmp); } catch {} sendJson(res, 500, { error: e.message }); });
        req.on('error', () => { try { fs.unlinkSync(tmp); } catch {} });
        return;
      }

      const jobStatus = p.match(/^\/api\/agent\/jobs\/(\d+)\/status$/);
      if (req.method === 'POST' && jobStatus) {
        const body = await readBody(req);
        const id = Number(jobStatus[1]);
        const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
        if (!job) return sendJson(res, 404, { error: 'no such job' });
        // 'pending' lets an agent defer its own job (node is rendering — retry next
        // check-in) without it counting as a failure.
        const ok = ['pending', 'downloading', 'installing', 'success', 'failed'];
        if (!ok.includes(body.status)) return sendJson(res, 400, { error: 'bad status' });
        // Stamp when the job first starts running (leaves the queue) — drives the timer.
        if (!job.started_at && (body.status === 'downloading' || body.status === 'installing')) {
          db.prepare('UPDATE jobs SET started_at = ? WHERE id = ?').run(Date.now(), id);
        }
        db.prepare('UPDATE jobs SET status = ?, log = ?, updated_at = ? WHERE id = ?')
          .run(body.status, body.log ? String(body.log).slice(0, 20000) : job.log, Date.now(), id);
        // Learn how long installs of this product/OS actually take (EMA) — this
        // drives the install progress bar for future jobs.
        if (body.status === 'success' && job.status === 'installing') {
          const dur = Date.now() - job.updated_at;
          // Persist the install duration so the UI can show how long it took.
          db.prepare('UPDATE jobs SET install_ms = ? WHERE id = ?').run(dur, id);
          if (dur > 5000 && dur < 3600000) {
            const pk = db.prepare('SELECT product_key, os FROM packages WHERE id = ?').get(job.package_id);
            if (pk) {
              const key = `${pk.product_key}|${pk.os}`;
              const cur = INSTALL_EMA.get(key);
              INSTALL_EMA.set(key, cur ? Math.round(cur * 0.5 + dur * 0.5) : dur);
            }
          }
          // Keep the (hidden) Maxon App current as a ride-along on Maxon updates.
          const donePkg = db.prepare('SELECT product_key FROM packages WHERE id = ?').get(job.package_id);
          if (donePkg) maybeRideAlongMaxonApp(job.node_id, donePkg.product_key);
        }
        if (body.status === 'success' || body.status === 'failed') {
          const info = db.prepare(
            `SELECT n.hostname, pk.product_key, pk.version FROM jobs j
               JOIN nodes n ON n.id = j.node_id JOIN packages pk ON pk.id = j.package_id WHERE j.id = ?`
          ).get(id);
          logEvent('job', `Job #${id} ${body.status}: ${info.product_key} ${info.version} on ${info.hostname}`);
          if (body.status === 'success') clearRolloutHaltFlag(info.product_key, info.version); // a win re-arms the breaker
          if (body.status === 'failed') {
            const tail = (body.log ? String(body.log) : '').replace(/\s+/g, ' ').trim().slice(-160);
            notifySlack(`❌ Install failed: *${info.product_key} ${info.version}* on *${info.hostname}*${tail ? `\n> ${tail}` : ''}`);
          }
        }
        return sendJson(res, 200, { ok: true });
      }

      const dl = p.match(/^\/api\/agent\/download\/(\d+)$/);
      if (req.method === 'GET' && dl) {
        const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(Number(dl[1]));
        if (!pkg) return sendJson(res, 404, { error: 'no such package' });
        const file = resolveInstaller(pkg.filename);
        if (!file) return sendJson(res, 404, { error: 'installer file missing on server' });
        const stat = fs.statSync(file);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': stat.size,
          'Content-Disposition': `attachment; filename="${path.basename(file)}"`,
        });
        // Identify which job this transfer belongs to (by requester IP + package),
        // so the dashboard can show a REAL download progress bar — no agent change.
        const node = db.prepare('SELECT id FROM nodes WHERE ip = ?').get(req.socket.remoteAddress);
        const job = node && db.prepare(
          "SELECT id FROM jobs WHERE node_id = ? AND package_id = ? AND status = 'downloading' ORDER BY id DESC"
        ).get(node.id, pkg.id);
        const stream = fs.createReadStream(file);
        if (job) {
          let sent = 0;
          stream.on('data', (c) => { sent += c.length; DL_PROGRESS.set(job.id, { sent, total: stat.size }); });
          res.on('close', () => setTimeout(() => DL_PROGRESS.delete(job.id), 20000));
        }
        stream.pipe(res);
        return;
      }

      return sendJson(res, 404, { error: 'unknown agent endpoint' });
    }

    // -------- dashboard endpoints --------
    if (req.method === 'GET' && p === '/api/state') return sendJson(res, 200, fullState());

    // Master monitoring switch.
    if (req.method === 'POST' && p === '/api/monitoring') {
      const b = await readBody(req);
      config.monitoringActive = !!b.active;
      saveConfig();
      logEvent('monitoring', `Monitoring turned ${config.monitoringActive ? 'ON' : 'OFF'}`);
      return sendJson(res, 200, { ok: true, active: config.monitoringActive });
    }

    // Rollout concurrency: how many machines download/install at the same time.
    // Manual "Check now": run the Maxon release-notes detect + installer auto-fetch on demand.
    if (req.method === 'POST' && p === '/api/check-maxon') {
      try {
        const bumped = await checkMaxonVersions(db, logEvent, config);
        const fetched = await autoFetchMaxonInstallers();
        const extra = await checkExtraVersions();
        const cust = await checkCustomVersions();
        return sendJson(res, 200, { ok: true,
          bumped: [...bumped, ...extra.bumped, ...cust.bumped],
          fetched: [...fetched, ...extra.fetched, ...cust.fetched] });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    if (req.method === 'POST' && p === '/api/settings') {
      const b = await readBody(req);
      const n = Number(b.maxConcurrentInstalls);
      if (Number.isFinite(n) && n >= 1 && n <= 50) {
        config.maxConcurrentInstalls = Math.floor(n);
        saveConfig();
        logEvent('monitoring', `Rollout concurrency set to ${config.maxConcurrentInstalls} at a time`);
      }
      if (typeof b.downloadDir === 'string' && b.downloadDir.trim()) {
        const dir = b.downloadDir.trim();
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.accessSync(dir, fs.constants.W_OK);
        } catch (e) {
          return sendJson(res, 400, { error: `download folder not writable: ${e.message}` });
        }
        config.downloadDir = dir;
        if (!config.installerSources.includes(dir)) config.installerSources.push(dir);
        saveConfig();
        logEvent('monitoring', `Download folder set to ${dir}`);
      }
      if (typeof b.slackWebhook === 'string') {
        config.slackWebhook = b.slackWebhook.trim() || null;
        saveConfig();
        logEvent('monitoring', config.slackWebhook ? 'Slack alerts enabled' : 'Slack alerts disabled');
      }
      if (b.maintenanceWindow && typeof b.maintenanceWindow === 'object') {
        const mw = b.maintenanceWindow;
        config.maintenanceWindow = { enabled: !!mw.enabled, start: String(mw.start || '00:00'), end: String(mw.end || '06:00') };
        saveConfig();
        logEvent('monitoring', config.maintenanceWindow.enabled
          ? `Auto-deploy maintenance window set to ${config.maintenanceWindow.start}–${config.maintenanceWindow.end}`
          : 'Auto-deploy maintenance window turned off');
      }
      return sendJson(res, 200, { ok: true });
    }

    // Send a test Slack message so the user can confirm the webhook works.
    if (req.method === 'POST' && p === '/api/slack-test') {
      if (!config.slackWebhook) return sendJson(res, 400, { error: 'No Slack webhook set — save one first.' });
      notifySlack(`✅ Render Farm Tracker — Slack alerts are connected (${lanAddress()}).`);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/installer-files') {
      return sendJson(res, 200, { files: listInstallerFiles(), sources: config.installerSources });
    }

    // Start a server-side download of an installer from an online/vendor URL
    // into the cache. The farm nodes then pull it over the LAN from the server.
    if (req.method === 'POST' && p === '/api/download-url') {
      const b = await readBody(req);
      let parsed;
      try { parsed = new URL(b.url); } catch { return sendJson(res, 400, { error: 'invalid URL' }); }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return sendJson(res, 400, { error: 'only http/https URLs are supported' });
      }
      const filename = path.basename(b.filename || '') ||
        filenameFromUrl(b.url, `installer-${Date.now()}`);
      const dlId = crypto.randomBytes(6).toString('hex');
      downloads.set(dlId, { url: b.url, filename, status: 'downloading', received: 0, total: 0, error: null });
      fetchToInstallers(dlId, b.url, filename);
      logEvent('package', `Started download from URL: ${filename}`);
      return sendJson(res, 200, { dlId, filename });
    }

    if (req.method === 'GET' && p === '/api/downloads') {
      return sendJson(res, 200, {
        downloads: [...downloads.entries()].map(([id, d]) => ({ id, ...d })),
      });
    }

    // Auto-fetcher for the "Add custom product" form: given a URL, fill in what we can
    // (icon from the site's favicon; latest version + installer/check URL). The form asks
    // the user only for what this can't determine.
    if (req.method === 'POST' && p === '/api/products/inspect') {
      const b = await readBody(req);
      const url = String(b.url || '').trim();
      let domain = '';
      try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { return sendJson(res, 400, { error: 'enter a valid URL (https://…)' }); }
      const out = { icon_url: domain ? `https://icons.duckduckgo.com/ip3/${domain}.ico` : null,
        source_url_win: null, source_url_mac: null, check_url: null, version: null };
      const fn = filenameFromUrl(url);
      if (/\.(exe|msi|dmg|pkg|zip|7z)$/i.test(fn)) {                 // URL is a direct installer
        if (/\.(dmg|pkg)$/i.test(fn)) out.source_url_mac = url; else out.source_url_win = url;
        out.version = versionFromFilename(fn);
      } else {                                                       // URL is a page → version-check source
        out.check_url = url;
        try {
          const txt = await httpGetText(url);
          out.version = (txt.match(/\d+(?:\.\d+){1,3}/g) || []).sort((a, b) => cmpVersionServer(a, b)).pop() || null;
        } catch { /* leave version null — user fills it */ }
      }
      return sendJson(res, 200, out);
    }

    // Uninstall a custom product from machines — runs its uninstall command (command-kind job).
    if (req.method === 'POST' && p === '/api/uninstall') {
      const b = await readBody(req);
      const prod = db.prepare('SELECT * FROM products WHERE key = ?').get(b.product_key);
      if (!prod) return sendJson(res, 404, { error: 'no such product' });
      if (!Array.isArray(b.node_ids) || !b.node_ids.length) return sendJson(res, 400, { error: 'node_ids required' });
      const now = Date.now();
      const queued = [], noCmd = [];
      for (const nid of b.node_ids) {
        const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(Number(nid));
        if (!node) continue;
        const cmd = node.os === 'windows' ? prod.uninstall_cmd_win : prod.uninstall_cmd_mac;
        if (!cmd) { noCmd.push(node.hostname); continue; }
        if (activeJobForProduct(node.id, prod.key)) continue;
        const pkgId = Number(db.prepare(
          'INSERT INTO packages (product_key, version, os, filename, install_command, kind, created_at) VALUES (?,?,?,?,?,?,?)'
        ).run(prod.key, 'uninstall', node.os, '', cmd, 'command', now).lastInsertRowid);
        db.prepare('INSERT INTO jobs (package_id, node_id, status, created_at, updated_at) VALUES (?,?,?,?,?)')
          .run(pkgId, node.id, 'pending', now, now);
        queued.push(node.hostname);
      }
      if (queued.length) logEvent('deploy', `Uninstall queued: ${prod.name} → ${queued.join(', ')}`);
      return sendJson(res, 200, { ok: true, queued, noCmd });
    }

    // Register a NEW custom product to track (no code change) — e.g. a plugin like X-Particles.
    if (req.method === 'POST' && p === '/api/products') {
      const b = await readBody(req);
      const name = String(b.name || '').trim();
      if (!name) return sendJson(res, 400, { error: 'name is required' });
      // Slug the name into a unique key matching the route charset ([a-z0-9_-]).
      let base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'product';
      let key = base, i = 2;
      while (db.prepare('SELECT 1 FROM products WHERE key = ?').get(key)) key = `${base}-${i++}`;
      db.prepare(`INSERT INTO products (key, name, latest_version, latest_win, latest_mac, notes,
                    detect_pattern, check_url, check_regex, source_url_win, source_url_mac,
                    install_cmd_win, install_cmd_mac, icon_url, uninstall_cmd_win, uninstall_cmd_mac,
                    custom, updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`)
        .run(key, name, b.latest_version || null, b.latest_win || null, b.latest_mac || null,
          b.notes || null, (b.detect_pattern || '').trim() || null,
          b.check_url || null, b.check_regex || null, b.source_url_win || null, b.source_url_mac || null,
          b.install_cmd_win || null, b.install_cmd_mac || null, b.icon_url || null,
          b.uninstall_cmd_win || null, b.uninstall_cmd_mac || null, Date.now());
      logEvent('catalog', `Custom product added: ${name}`);
      return sendJson(res, 200, { ok: true, key });
    }

    // Delete a product — ONLY user-added custom ones (built-ins are protected).
    const productDel = p.match(/^\/api\/products\/([a-z0-9_-]+)$/);
    if (req.method === 'DELETE' && productDel) {
      const prod = db.prepare('SELECT * FROM products WHERE key = ?').get(productDel[1]);
      if (!prod) return sendJson(res, 404, { error: 'no such product' });
      if (!prod.custom) return sendJson(res, 400, { error: 'built-in products cannot be deleted' });
      const pkgIds = db.prepare('SELECT id FROM packages WHERE product_key = ?').all(prod.key).map((r) => r.id);
      for (const pid of pkgIds) db.prepare('DELETE FROM jobs WHERE package_id = ?').run(pid);
      db.prepare('DELETE FROM packages WHERE product_key = ?').run(prod.key);
      db.prepare('DELETE FROM software WHERE product_key = ?').run(prod.key);
      db.prepare('DELETE FROM products WHERE key = ?').run(prod.key);
      logEvent('catalog', `Custom product removed: ${prod.name}`);
      return sendJson(res, 200, { ok: true });
    }

    const productPut = p.match(/^\/api\/products\/([a-z0-9_-]+)$/);
    if (req.method === 'PUT' && productPut) {
      const body = await readBody(req);
      const prod = db.prepare('SELECT * FROM products WHERE key = ?').get(productPut[1]);
      if (!prod) return sendJson(res, 404, { error: 'no such product' });
      const pick = (k) => body[k] !== undefined ? (body[k] || null) : prod[k];   // partial update
      const newAuto = body.autodeploy !== undefined ? (body.autodeploy ? 1 : 0) : prod.autodeploy;
      const newHidden = body.dashboard_hidden !== undefined ? (body.dashboard_hidden ? 1 : 0) : prod.dashboard_hidden;
      db.prepare(`UPDATE products SET latest_version = ?, notes = ?,
                    source_url_win = ?, source_url_mac = ?, autodeploy = ?, dashboard_hidden = ?,
                    detect_pattern = ?, latest_win = ?, latest_mac = ?,
                    check_url = ?, check_regex = ?, install_cmd_win = ?, install_cmd_mac = ?,
                    icon_url = ?, uninstall_cmd_win = ?, uninstall_cmd_mac = ?,
                    updated_at = ? WHERE key = ?`)
        .run(pick('latest_version'), pick('notes'), pick('source_url_win'), pick('source_url_mac'),
          newAuto, newHidden, pick('detect_pattern'), pick('latest_win'), pick('latest_mac'),
          pick('check_url'), pick('check_regex'), pick('install_cmd_win'), pick('install_cmd_mac'),
          pick('icon_url'), pick('uninstall_cmd_win'), pick('uninstall_cmd_mac'),
          Date.now(), prod.key);
      if (body.dashboard_hidden !== undefined && newHidden !== prod.dashboard_hidden) {
        logEvent('catalog', `${prod.name}: ${newHidden ? 'hidden from' : 'shown on'} the dashboard`);
      }
      if (body.autodeploy !== undefined && newAuto !== prod.autodeploy) {
        logEvent('catalog', `${prod.name}: auto-deploy ${newAuto ? 'ENABLED' : 'disabled'}`);
        if (newAuto) setTimeout(runAutoDeploy, 200);   // act now instead of waiting for the timer
      } else if (body.latest_version !== undefined && body.latest_version !== prod.latest_version) {
        logEvent('catalog', `${prod.name}: latest version set to ${body.latest_version || '(none)'}`);
      }
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/packages') {
      const b = await readBody(req);
      const kind = b.kind === 'command' ? 'command' : 'installer';
      if (!b.product_key || !b.version || !b.install_command || !['windows', 'macos'].includes(b.os)) {
        return sendJson(res, 400, { error: 'product_key, version, os, install_command required' });
      }
      let filename = '';
      if (kind === 'installer') {
        if (!b.filename) return sendJson(res, 400, { error: 'filename required for installer packages' });
        filename = path.basename(b.filename);
        if (!resolveInstaller(filename)) {
          return sendJson(res, 400, { error: `installer not found in any source: ${b.filename}` });
        }
        const mism = installerVersionMismatch({ kind, filename, version: b.version });
        if (mism) return sendJson(res, 400, { error: mism });
      }
      const info = db.prepare(
        'INSERT INTO packages (product_key, version, os, filename, install_command, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(b.product_key, b.version, b.os, filename, b.install_command, kind, Date.now());
      logEvent('package', `Package added: ${b.product_key} ${b.version} (${b.os}, ${kind})`);
      return sendJson(res, 200, { ok: true, id: Number(info.lastInsertRowid) });
    }

    const pkgDel = p.match(/^\/api\/packages\/(\d+)$/);
    if (req.method === 'DELETE' && pkgDel) {
      const id = Number(pkgDel[1]);
      const open = db.prepare(
        "SELECT COUNT(*) AS c FROM jobs WHERE package_id = ? AND status IN ('pending','downloading','installing')"
      ).get(id);
      if (open.c > 0) return sendJson(res, 400, { error: 'package has active jobs' });
      db.prepare('DELETE FROM jobs WHERE package_id = ?').run(id);
      db.prepare('DELETE FROM packages WHERE id = ?').run(id);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/deployments') {
      const b = await readBody(req);
      const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(Number(b.package_id));
      if (!pkg) return sendJson(res, 400, { error: 'no such package' });
      const dmism = installerVersionMismatch(pkg);
      if (dmism) return sendJson(res, 400, { error: dmism });
      if (!Array.isArray(b.node_ids) || !b.node_ids.length) {
        return sendJson(res, 400, { error: 'node_ids required' });
      }
      const created = [], skippedNoDriver = [];
      for (const nid of b.node_ids) {
        const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(Number(nid));
        if (!node || node.os !== pkg.os) continue; // never send a package to the wrong OS
        // NVIDIA: deploy the driver track this GPU supports (Pascal → 581.x, not 610.x).
        const usePkg = packageForNode(node, pkg);
        if (!usePkg || node.os !== usePkg.os) { skippedNoDriver.push(node.hostname); continue; }
        if (activeJobForProduct(node.id, usePkg.product_key)) continue;
        const now = Date.now();
        db.prepare(
          'INSERT INTO jobs (package_id, node_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
        ).run(usePkg.id, node.id, 'pending', now, now);
        created.push(node.hostname);
      }
      logEvent('deploy', `Deployment queued: ${pkg.product_key} ${pkg.version} → ${created.length ? created.join(', ') : '(no eligible nodes)'}`);
      return sendJson(res, 200, { ok: true, queued: created, skippedNoDriver });
    }

    // Update ONE node to a specific package (individual update button).
    if (req.method === 'POST' && p === '/api/quick-update') {
      const b = await readBody(req);
      const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(Number(b.package_id));
      const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(Number(b.node_id));
      if (!pkg || !node) return sendJson(res, 400, { error: 'bad node or package' });
      const usePkg = packageForNode(node, pkg);   // NVIDIA: swap to this GPU's driver track
      if (!usePkg) return sendJson(res, 400, { error: `no supported NVIDIA driver is staged for ${node.hostname}'s GPU` });
      if (node.os !== usePkg.os) return sendJson(res, 400, { error: 'package OS does not match node OS' });
      const qmism = installerVersionMismatch(usePkg);
      if (qmism) return sendJson(res, 400, { error: qmism });
      if (activeJobForProduct(node.id, usePkg.product_key)) {
        return sendJson(res, 200, { ok: true, queued: [], note: `an update for ${usePkg.product_key} is already in progress on ${node.hostname}` });
      }
      const now = Date.now();
      db.prepare('INSERT INTO jobs (package_id, node_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(usePkg.id, node.id, 'pending', now, now);
      logEvent('deploy', `Update queued: ${usePkg.product_key} ${usePkg.version} → ${node.hostname}`);
      return sendJson(res, 200, { ok: true, queued: [node.hostname] });
    }

    // Batch: queue a package to every OS-matching node that is outdated/missing it.
    if (req.method === 'POST' && p === '/api/update-outdated') {
      const b = await readBody(req);
      const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(Number(b.package_id));
      if (!pkg) return sendJson(res, 400, { error: 'no such package' });
      const bmism = installerVersionMismatch(pkg);
      if (bmism) return sendJson(res, 400, { error: bmism });
      const onlyOnline = b.onlyOnline !== false;
      // Default = safe in-place patches only (same major). Major-behind or
      // not-installed nodes are opt-in side-by-side installs (includeMajor).
      const includeMajor = b.includeMajor === true;
      const offlineMs = config.offlineAfterSeconds * 1000;
      const now = Date.now();
      const nodes = db.prepare('SELECT * FROM nodes WHERE os = ?').all(pkg.os);
      const queued = [];
      for (const node of nodes) {
        if (onlyOnline && !(node.last_seen != null && now - node.last_seen < offlineMs)) continue;
        const usePkg = packageForNode(node, pkg);   // NVIDIA: this GPU's driver track
        if (!usePkg) continue;
        const sw = db.prepare('SELECT version FROM software WHERE node_id = ? AND product_key = ?')
          .get(node.id, usePkg.product_key);
        const installed = sw && sw.version ? sw.version : null;
        if (installed && cmpVersionServer(installed, usePkg.version) >= 0) continue; // already current
        if (!includeMajor && usePkg.product_key !== 'nvidia') {  // driver updates are always in-place
          if (!installed) continue; // not installed = fresh install, opt-in
          if (verMajorServer(installed) !== verMajorServer(usePkg.version)) continue; // major behind = opt-in
        }
        if (activeJobForProduct(node.id, usePkg.product_key)) continue;
        db.prepare('INSERT INTO jobs (package_id, node_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(usePkg.id, node.id, 'pending', now, now);
        queued.push(node.hostname);
      }
      logEvent('deploy', `Batch update: ${pkg.product_key} ${pkg.version} → ${queued.length} node(s)`);
      return sendJson(res, 200, { ok: true, queued });
    }

    // Best-effort nudge: restart the Adobe updater on idle machines so the CC desktop
    // app self-updates. Render-gated agent-side; never bumps a version we control.
    // Stop/kill a job — works for pending OR in-flight (downloading/installing).
    // Marks it cancelled so the dashboard clears it and the node can be re-targeted.
    // (The node-side installer, if mid-run, is also asked to abort on next checkin.)
    const jobKill = p.match(/^\/api\/jobs\/(\d+)\/(cancel|kill)$/);
    if (req.method === 'POST' && jobKill) {
      const id = Number(jobKill[1]);
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
      if (!job) return sendJson(res, 404, { error: 'no such job' });
      if (!['pending', 'downloading', 'installing'].includes(job.status)) {
        return sendJson(res, 400, { error: `job is already ${job.status}` });
      }
      db.prepare("UPDATE jobs SET status = 'cancelled', log = COALESCE(log,'')||?, updated_at = ? WHERE id = ?")
        .run('\n[stopped by user]', Date.now(), id);
      return sendJson(res, 200, { ok: true });
    }

    // Stop everything — cancels every queued and in-flight job at once.
    if (req.method === 'POST' && p === '/api/jobs/kill-all') {
      const n = db.prepare(
        "UPDATE jobs SET status = 'cancelled', log = COALESCE(log,'')||?, updated_at = ? WHERE status IN ('pending','downloading','installing')"
      ).run('\n[stopped by user — stop all]', Date.now()).changes;
      if (n) logEvent('deploy', `Stop all: ${n} job(s) cancelled`);
      return sendJson(res, 200, { ok: true, stopped: n });
    }

    // Clear finished activity — remove done/failed/stopped jobs, leaving only in-progress.
    if (req.method === 'POST' && p === '/api/jobs/clear-finished') {
      const n = db.prepare(
        "DELETE FROM jobs WHERE status IN ('success','failed','cancelled')"
      ).run().changes;
      if (n) logEvent('deploy', `Cleared ${n} finished job(s) from activity`);
      return sendJson(res, 200, { ok: true, cleared: n });
    }

    // Retry a finished job — re-queues the same package on the same node.
    const jobRetry = p.match(/^\/api\/jobs\/(\d+)\/retry$/);
    if (req.method === 'POST' && jobRetry) {
      const id = Number(jobRetry[1]);
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
      if (!job) return sendJson(res, 404, { error: 'no such job' });
      if (!['failed', 'cancelled'].includes(job.status)) {
        return sendJson(res, 400, { error: `only failed/stopped jobs can retry (this one is ${job.status})` });
      }
      db.prepare("UPDATE jobs SET status = 'pending', log = NULL, updated_at = ? WHERE id = ?")
        .run(Date.now(), id);
      logEvent('deploy', `Job #${id} retried by user`);
      return sendJson(res, 200, { ok: true });
    }

    // Reboot a machine. Two paths, each covering the other's blind spot:
    //   • agent — reliable when the box is ONLINE (its agent checks in); the agent runs
    //     the OS reboot itself. Can't help if the agent is dead/offline.
    //   • Deadline RemoteControl — works even when the tracker agent is dead, but needs
    //     Deadline's Launcher reachable (port 17000), which is flaky on this farm.
    // So: prefer the AGENT for online+capable machines, and fall back to Deadline for
    // anything the agent can't reach (offline, or an agent too old to handle the flag).
    const nodeReboot = p.match(/^\/api\/nodes\/(\d+)\/reboot$/);
    if (req.method === 'POST' && nodeReboot) {
      const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(Number(nodeReboot[1]));
      if (!node) return sendJson(res, 404, { error: 'no such node' });
      const online = node.last_seen != null && Date.now() - node.last_seen < (config.offlineAfterSeconds || 180) * 1000;
      const agentCapable = online && node.agent_version && cmpVersionServer(node.agent_version, '2.17.3') >= 0;
      if (agentCapable) {
        pendingAgentReboot.add(node.id);
        logEvent('node', `Reboot requested for ${node.hostname} via the tracker agent`);
        return sendJson(res, 200, { ok: true, hostname: node.hostname, confirmed: false, via: 'agent' });
      }
      // Agent can't do it (offline, or too old) — try Deadline if it's present.
      try {
        const r = await rebootViaDeadline(node.hostname);
        logEvent('node', `Reboot ${r.confirmed ? 'sent' : 'sent (unconfirmed)'} to ${node.hostname} (via Deadline RemoteControl)`);
        return sendJson(res, 200, { ok: true, hostname: node.hostname, confirmed: r.confirmed, via: 'deadline' });
      } catch (e) {
        const hint = node.macs
          ? ` It's offline, so use Wake to power it on instead.`
          : ` It's offline and we have no Wake-on-LAN address for it yet.`;
        return sendJson(res, 502, { error: `Can't reach ${node.hostname} to reboot.${hint} (${e.message})` });
      }
    }

    // Wake-on-LAN — power on a machine that's off/asleep (Deadline-free). Uses the MAC(s)
    // the agent reported on its last check-in.
    const nodeWake = p.match(/^\/api\/nodes\/(\d+)\/wake$/);
    if (req.method === 'POST' && nodeWake) {
      const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(Number(nodeWake[1]));
      if (!node) return sendJson(res, 404, { error: 'no such node' });
      if (!node.macs) return sendJson(res, 400, { error: `No Wake-on-LAN address for ${node.hostname} yet — it must check in once on agent 2.18.0+ first.` });
      const n = wakeOnLan(node.macs, node.ip);
      logEvent('node', `Wake-on-LAN sent to ${node.hostname} (${n} MAC${n === 1 ? '' : 's'})`);
      return sendJson(res, 200, { ok: true, hostname: node.hostname, sent: n });
    }

    const nodeDel = p.match(/^\/api\/nodes\/(\d+)$/);
    if (req.method === 'DELETE' && nodeDel) {
      const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(Number(nodeDel[1]));
      if (!node) return sendJson(res, 404, { error: 'no such node' });
      db.prepare('DELETE FROM jobs WHERE node_id = ?').run(node.id);
      db.prepare('DELETE FROM software WHERE node_id = ?').run(node.id);
      db.prepare('DELETE FROM nodes WHERE id = ?').run(node.id);
      logEvent('node', `Node removed: ${node.hostname}`);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/agent-setup') {
      // Convenience: everything an admin needs to enrol a node.
      return sendJson(res, 200, {
        agentKey: config.agentKey,
        port: config.port,
        lanUrl: `http://${lanAddress()}:${config.port}`,
      });
    }

    // Quick-access "places" for the folder picker sidebar (Finder-style).
    if (req.method === 'GET' && p === '/api/places') {
      const home = os.homedir();
      const favorites = [];
      const addFav = (name, pth, icon) => { try { if (pth && fs.existsSync(pth)) favorites.push({ name, path: pth, icon }); } catch { /* skip */ } };
      addFav('Home', home, 'folder');
      addFav('Desktop', path.join(home, 'Desktop'), 'folder');
      addFav('Documents', path.join(home, 'Documents'), 'folder');
      addFav('Downloads', path.join(home, 'Downloads'), 'download');
      const locations = [];
      if (process.platform === 'darwin') {
        try {
          for (const v of fs.readdirSync('/Volumes')) {
            const pth = path.join('/Volumes', v);
            try { if (fs.statSync(pth).isDirectory()) locations.push({ name: v, path: pth, icon: 'server' }); } catch { /* skip */ }
          }
        } catch { /* skip */ }
      } else if (process.platform === 'win32') {
        for (const d of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
          const pth = d + ':\\';
          try { if (fs.existsSync(pth)) locations.push({ name: 'Drive ' + d + ':', path: pth, icon: 'server' }); } catch { /* skip */ }
        }
      } else {
        locations.push({ name: 'Root', path: '/', icon: 'server' });
      }
      return sendJson(res, 200, { favorites, locations });
    }

    // Server-side folder browser for the "Installer download folder" picker.
    if (req.method === 'GET' && p === '/api/list-dirs') {
      let dir = url.searchParams.get('path') || '';
      if (!dir) {
        dir = (config.downloadDir && fs.existsSync(config.downloadDir)) ? config.downloadDir
          : (process.platform === 'darwin' && fs.existsSync('/Volumes')) ? '/Volumes'
            : (process.platform === 'win32') ? 'C:\\' : '/';
      }
      try {
        dir = path.resolve(dir);
        const dirs = [], files = [];
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.name.startsWith('.')) continue;
          let st = null;
          try { st = fs.statSync(path.join(dir, e.name)); } catch { /* unreadable */ }
          let isDir = false;
          try { isDir = e.isDirectory() || (st && st.isDirectory()); } catch { isDir = false; }
          if (isDir) dirs.push({ name: e.name, mtime: st ? st.mtimeMs : 0 });
          else files.push({ name: e.name, mtime: st ? st.mtimeMs : 0, size: st ? st.size : 0 });
        }
        const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        dirs.sort(byName); files.sort(byName);
        const parent = path.dirname(dir);
        let writable = true;
        try { fs.accessSync(dir, fs.constants.W_OK); } catch { writable = false; }
        return sendJson(res, 200, { path: dir, parent: parent === dir ? null : parent, dirs, files, writable });
      } catch (e) {
        return sendJson(res, 400, { error: `Cannot open ${dir}: ${e.code || e.message}` });
      }
    }

    // Create a folder from the picker's "New Folder" action.
    if (req.method === 'POST' && p === '/api/mkdir') {
      const b = await readBody(req);
      const dir = (b.path || '').trim();
      if (!dir) return sendJson(res, 400, { error: 'path required' });
      try {
        const full = path.resolve(dir);
        fs.mkdirSync(full, { recursive: true });
        return sendJson(res, 200, { ok: true, path: full });
      } catch (e) {
        return sendJson(res, 400, { error: `Cannot create ${dir}: ${e.code || e.message}` });
      }
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

// PORT env overrides config.json — lets a second instance (e.g. UI preview)
// run beside the production server without stealing its port.
const LISTEN_PORT = Number(process.env.PORT) || config.port;
server.listen(LISTEN_PORT, () => {
  console.log(`Render Farm Update Tracker`);
  console.log(`  Dashboard : http://localhost:${LISTEN_PORT}`);
  console.log(`  Agent key : ${config.agentKey}`);
  console.log(`  Installers: ${INSTALLERS_DIR}`);
});
