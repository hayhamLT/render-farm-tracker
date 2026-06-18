'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const DB_PATH = path.join(__dirname, '..', 'tracker.db');

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

// Machine health / GPU telemetry reported by the agent each check-in.
addColumn('nodes', 'gpu', 'TEXT');             // GPU model (e.g. "NVIDIA RTX 4090")
addColumn('nodes', 'gpu_driver', 'TEXT');      // GPU driver version (NVIDIA)
addColumn('nodes', 'disk_free_gb', 'REAL');    // free space on the system/install drive
addColumn('nodes', 'disk_total_gb', 'REAL');
addColumn('nodes', 'os_version', 'TEXT');      // OS name + build
addColumn('nodes', 'pending_reboot', 'INTEGER'); // 1 = Windows reports a reboot is pending
addColumn('nodes', 'macs', 'TEXT');            // comma-separated MAC addresses (Wake-on-LAN)
addColumn('nodes', 'gpu_util', 'INTEGER');     // live GPU utilization % (drives "Rendering" in Fleet)

function logEvent(kind, message) {
  db.prepare('INSERT INTO events (ts, kind, message) VALUES (?, ?, ?)')
    .run(Date.now(), kind, message);
  // Keep the activity log bounded.
  db.prepare(
    'DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 500)'
  ).run();
}

module.exports = { db, logEvent };
