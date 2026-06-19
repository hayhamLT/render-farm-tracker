'use strict';
// Automated, dependency-free DB + config backups.
//
// Uses SQLite's `VACUUM INTO`, which writes a single, fully-consistent snapshot of the live
// database (WAL included) to a new file — the safe way to back up a running SQLite DB without
// stopping the server or any external tools. Backups default to a directory OUTSIDE the repo
// (the repo may live in Dropbox, which is what corrupted the DB in the first place).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { db, logEvent } = require('./db');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'tracker.db');
const CONFIG_PATH = path.join(ROOT, 'config.json');

function backupDir(config) {
  // A backup inside the (possibly Dropbox-synced) repo defeats the purpose — default outside it.
  return (config && config.backupDir) || path.join(os.homedir(), 'tracker-backups');
}

const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// Keep only the newest `keep` snapshots (and their paired config files).
function pruneOld(dir, keep) {
  const dbs = fs.readdirSync(dir).filter((f) => /^tracker-\d{8}-\d{6}\.db$/.test(f)).sort();
  for (const f of dbs.slice(0, Math.max(0, dbs.length - keep))) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
    const cfg = f.replace(/^tracker-/, 'config-').replace(/\.db$/, '.json');
    try { fs.unlinkSync(path.join(dir, cfg)); } catch { /* ignore */ }
  }
}

let _last = null;   // { db, config, size, at } of the most recent successful backup

function backupNow(config) {
  const dir = backupDir(config);
  fs.mkdirSync(dir, { recursive: true });
  const ts = stamp();
  const dbOut = path.join(dir, `tracker-${ts}.db`);
  // VACUUM INTO refuses to overwrite, so the timestamped name must be unique (it is, to the second).
  db.exec(`VACUUM INTO '${dbOut.replace(/'/g, "''")}'`);
  let cfgOut = null;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      cfgOut = path.join(dir, `config-${ts}.json`);
      fs.copyFileSync(CONFIG_PATH, cfgOut);
    }
  } catch { /* config copy is best-effort */ }
  pruneOld(dir, (config && config.backupKeep) || 14);
  const size = fs.statSync(dbOut).size;
  _last = { db: dbOut, config: cfgOut, size, at: Date.now() };
  logEvent('backup', `Backup saved → ${path.basename(dbOut)} (${(size / 1024).toFixed(0)} KB) in ${dir}`);
  return _last;
}

function lastBackup() { return _last; }

function listBackups(config) {
  const dir = backupDir(config);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^tracker-\d{8}-\d{6}\.db$/.test(f))
    .sort().reverse()
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, size: st.size, at: st.mtimeMs };
    });
}

// One backup at startup (always have a fresh restore point) + one every 24h.
function scheduleBackups(config) {
  const run = () => {
    try { backupNow(config); }
    catch (e) { logEvent('backup', `Backup FAILED: ${e && e.message}`); }
  };
  run();
  const timer = setInterval(run, 24 * 60 * 60 * 1000);
  if (timer.unref) timer.unref();   // don't keep the process alive just for backups
  return timer;
}

module.exports = { backupNow, scheduleBackups, lastBackup, listBackups, backupDir };
