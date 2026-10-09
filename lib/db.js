'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const { miscredited, miscreditNote, VERIFIED_PREFIX } = require('./job_rules');

// TRACKER_DB points the tests (and nothing else) at a database of their own.
const DB_PATH = process.env.TRACKER_DB || path.join(__dirname, '..', 'tracker.db');

const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS nodes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    hostname      TEXT NOT NULL UNIQUE,
    os            TEXT NOT NULL,            -- 'windows' | 'macos'
    ip            TEXT,
    agent_version TEXT,
    last_seen     INTEGER,                  -- unix ms
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS software (
    node_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    product_key TEXT NOT NULL,
    version     TEXT,
    install_path TEXT,
    detected_at INTEGER NOT NULL,
    PRIMARY KEY (node_id, product_key)
  );

  CREATE TABLE IF NOT EXISTS products (
    key            TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    latest_version TEXT,
    notes          TEXT,
    updated_at     INTEGER
  );

  CREATE TABLE IF NOT EXISTS packages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    product_key     TEXT NOT NULL REFERENCES products(key),
    version         TEXT NOT NULL,
    os              TEXT NOT NULL,          -- 'windows' | 'macos'
    filename        TEXT NOT NULL,          -- file inside installers/
    install_command TEXT NOT NULL,          -- template, {file} = downloaded path
    created_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id INTEGER NOT NULL REFERENCES packages(id),
    node_id    INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    status     TEXT NOT NULL DEFAULT 'pending', -- pending|downloading|installing|success|failed|cancelled
    log        TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL,
    kind    TEXT NOT NULL,
    message TEXT NOT NULL
  );
`);

// Seed the four tracked products.
const seed = db.prepare(
  'INSERT OR IGNORE INTO products (key, name) VALUES (?, ?)'
);
seed.run('cinema4d', 'Maxon Cinema 4D');
seed.run('redshift', 'Redshift');
seed.run('redgiant', 'Red Giant');
seed.run('aftereffects', 'Adobe After Effects');
// The two manager apps — updatable like any other product.
seed.run('maxonapp', 'Maxon App (Maxon One)');
seed.run('creativecloud', 'Adobe Creative Cloud');
seed.run('blender', 'Blender');
seed.run('ffmpeg', 'FFmpeg');
seed.run('notchlc', 'NotchLC');
seed.run('nvidia', 'NVIDIA Studio Driver');

// ---- migrations (safe to run every boot) ----
function addColumn(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}
// Package update method: 'installer' (download+run a file) or 'command'
// (run a tool already on the node, e.g. Adobe RUM / Maxon App CLI).
addColumn('packages', 'kind', "TEXT NOT NULL DEFAULT 'installer'");

// Remembered per-product install sources, so "fetch online" needs no re-typing.
// A download URL (authenticated link / NAS / internal mirror) per OS.
addColumn('products', 'source_url_win', 'TEXT');
addColumn('products', 'source_url_mac', 'TEXT');

// Whether each node's agent runs elevated (installs without prompts).
addColumn('nodes', 'elevated', 'INTEGER');

// Per-product auto-deploy: when on, new versions roll out automatically (canary first).
addColumn('products', 'autodeploy', 'INTEGER DEFAULT 0');

// How long the install phase took (ms), recorded when a job finishes — shown in the UI.
addColumn('jobs', 'install_ms', 'INTEGER');
// When the job left the queue and started running (first downloading/installing) — drives
// the live count-up timer in the Activity table.
addColumn('jobs', 'started_at', 'INTEGER');

// Per-product tracking toggle (1 = NOT tracked: hidden from dashboard/count/wizard AND
// excluded from version checks, installer fetches, and auto-deploy). Normal apps default
// ON (tracked); the self-managed managers (CC + Maxon App) are always handled specially.
addColumn('products', 'dashboard_hidden', 'INTEGER');
db.prepare("UPDATE products SET dashboard_hidden = 1 WHERE key IN ('creativecloud','maxonapp') AND dashboard_hidden IS NULL").run();

// Per-OS latest versions, for apps that ship different versions on Windows vs macOS
// (e.g. NotchLC: win 1.3.1, mac 1.4.3). Null = same as latest_version for both.
addColumn('products', 'latest_win', 'TEXT');
addColumn('products', 'latest_mac', 'TEXT');
// Legacy-GPU driver track for NVIDIA: the newest driver still supported on Maxwell/Pascal
// (GTX 9xx/10xx), which NVIDIA dropped from the current branch. Per-GPU targeting uses
// this for those cards and latest_win/latest_version for everything else.
addColumn('products', 'latest_legacy', 'TEXT');

// User-added (custom) products: a regex/substring the agent matches against installed-app
// names (Windows uninstall DisplayName / macOS app bundle / folder) to detect the version,
// and a flag marking the row as user-created (so it can be deleted; built-ins can't).
addColumn('products', 'detect_pattern', 'TEXT');
addColumn('products', 'custom', 'INTEGER DEFAULT 0');
// Automation for custom products (makes them behave like the built-ins, no code change):
//  check_url + check_regex  → fetch a page and extract the latest version (group 1, else
//                             the highest version-looking token) on the 6-hourly / "Check now".
//  source_url_win/mac (already exist) → auto-download the installer into the download folder.
//  install_cmd_win/mac      → silent-install command used by deploy / auto-deploy ({file} = path).
addColumn('products', 'check_url', 'TEXT');
addColumn('products', 'check_regex', 'TEXT');
addColumn('products', 'install_cmd_win', 'TEXT');
addColumn('products', 'install_cmd_mac', 'TEXT');
// A proper icon (favicon of the app's site, auto-derived) + uninstall commands so a custom
// product can also be removed from machines, not just installed.
addColumn('products', 'icon_url', 'TEXT');
addColumn('products', 'uninstall_cmd_win', 'TEXT');
addColumn('products', 'uninstall_cmd_mac', 'TEXT');
// Path-glob detection for apps NOT in the uninstall registry / Applications — e.g. host
// plug-ins (After Effects .aex, C4D plugins). The agent globs this and reads the version
// from the matched file/bundle. Per OS (Windows/macOS plug-in folders differ).
addColumn('products', 'detect_path_win', 'TEXT');
addColumn('products', 'detect_path_mac', 'TEXT');
// Catalog grouping: 'app' (default, incl. all built-ins) | 'plugin' | 'script'. Keeps the
// Catalog uncrowded by splitting custom plug-ins and scripts into their own tabs.
addColumn('products', 'category', "TEXT NOT NULL DEFAULT 'app'");

// Machine health / GPU telemetry reported by the agent each check-in.
addColumn('nodes', 'gpu', 'TEXT');             // GPU model (e.g. "NVIDIA RTX 4090")
addColumn('nodes', 'gpu_driver', 'TEXT');      // GPU driver version (NVIDIA)
addColumn('nodes', 'disk_free_gb', 'REAL');    // free space on the system/install drive
addColumn('nodes', 'disk_total_gb', 'REAL');
addColumn('nodes', 'os_version', 'TEXT');      // OS name + build
addColumn('nodes', 'pending_reboot', 'INTEGER'); // 1 = Windows reports a reboot is pending
addColumn('nodes', 'macs', 'TEXT');            // comma-separated MAC addresses (Wake-on-LAN)
addColumn('nodes', 'gpu_util', 'INTEGER');     // live GPU utilization % (drives "Rendering" in Fleet)
addColumn('nodes', 'wol_ready', 'INTEGER');    // 1 = agent reports its wired NIC is set up to wake (BIOS not checkable)
addColumn('nodes', 'wol_info', 'TEXT');        // JSON {note, nics:[{name,mac,up,magic,armed,changed,bad}]} from agent 2.29.0+
// Stop requested for a running job; the job stays downloading/installing ("stopping…") until
// the machine's agent confirms it killed the installer (agents 2.30.0+).
addColumn('jobs', 'cancel_requested_at', 'INTEGER');
// When the machine's agent last named this job as the one it is running (every check-in does). The
// reaper never fails a job named a moment ago, and auto-deploy never queues another install of that app
// on that machine meanwhile (lib/job_rules.js).
addColumn('jobs', 'agent_seen_at', 'INTEGER');

function logEvent(kind, message) {
  db.prepare('INSERT INTO events (ts, kind, message) VALUES (?, ?, ?)')
    .run(Date.now(), kind, message);
  // Keep the activity log bounded.
  db.prepare(
    'DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 500)'
  ).run();
}

const tableExists = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const columnsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

// ---- one-time clean-ups (safe to run every boot: each does nothing once done) ----

// The old check-in correction credited one more failed try of an app every minute once a machine reported
// the app's target version (2026-10-07: 135 NVIDIA 617.42 jobs on AVA-01, and #725 on Node-04, which never
// ran). Those jobs keep their status and their history; a line in front of their log says they were not
// what installed it. (Their status is left alone because Farmly announces every status change of the
// tracker's newest 200 jobs as a new install result.) Only rows the rule in lib/job_rules.js would not
// credit are touched, and a noted row no longer starts with the "Verified" text, so this runs once.
function noteMiscredited(now = Date.now()) {
  const rows = db.prepare(`
    SELECT j.id, j.started_at, j.log, p.product_key, p.version, n.hostname,
           (SELECT MAX(j2.id) FROM jobs j2 JOIN packages p2 ON p2.id = j2.package_id
             WHERE j2.node_id = j.node_id AND p2.product_key = p.product_key) AS newest_id
      FROM jobs j JOIN packages p ON p.id = j.package_id LEFT JOIN nodes n ON n.id = j.node_id
     WHERE j.status = 'success' AND j.log LIKE ?`).all(`${VERIFIED_PREFIX}%`);
  const bad = miscredited(rows);
  if (!bad.length) return [];
  const day = new Date(now).toISOString().slice(0, 10);
  const upd = db.prepare('UPDATE jobs SET log = ? WHERE id = ? AND status = ? AND log LIKE ?');
  db.exec('BEGIN');
  try {
    for (const r of bad) upd.run((miscreditNote(r, day) + r.log).slice(0, 20000), r.id, 'success', `${VERIFIED_PREFIX}%`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const groups = new Map();
  for (const r of bad) {
    const k = `${r.hostname || '?'} ${r.product_key} ${r.version}`;
    groups.set(k, (groups.get(k) || 0) + 1);
  }
  logEvent('job', `Job history: ${bad.length} job(s) the old check-in correction had marked a success by mistake now say so `
    + `at the top of their log (status unchanged): ${[...groups].map(([k, n]) => `${k} ×${n}`).join(', ')}`);
  return bad.map((r) => r.id);
}

for (const [name, fn] of [['check-in correction notes', noteMiscredited]]) {
  try { fn(); } catch (e) { console.error(`database migration (${name}) failed: ${e.message}`); }
}

module.exports = { db, logEvent, addColumn, tableExists, columnsOf, _migrations: { noteMiscredited } };
