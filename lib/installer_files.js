'use strict';
// Installer files on disk, without ever blocking the server.
//
// Installers are multi-GB files on an SMB share. Reading them synchronously on Node's main
// thread froze the whole tracker — every dashboard request and machine check-in — for as long
// as the read took (hashing a 3 GB Redshift installer over SMB: over a minute, Sep 2026).
//
//  • SHA-256 checksums are computed in the background, one file at a time, and saved in
//    installer_hashes keyed by path + size + mtime, so a restart doesn't recompute them.
//    sha256(path) returns the checksum if it's known, else starts computing it and returns null.
//  • The installer listing (readdir + stat of every source folder) refreshes in the background;
//    list() returns the last result immediately.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { db } = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS installer_hashes (
    path  TEXT PRIMARY KEY,
    size  INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    sha   TEXT NOT NULL,
    at    INTEGER NOT NULL
  );
`);

const queue = [];          // paths waiting to be hashed
const pending = new Set(); // queued or hashing
let hashing = false;

function statQuick(full) {
  try { const st = fs.statSync(full); return { size: st.size, mtime: Math.round(st.mtimeMs) }; } catch { return null; }
}

function sha256(full) {
  const st = statQuick(full);
  if (!st) return null;
  const row = db.prepare('SELECT size, mtime, sha FROM installer_hashes WHERE path = ?').get(full);
  if (row && row.size === st.size && row.mtime === st.mtime) return row.sha;
  if (!pending.has(full)) { pending.add(full); queue.push(full); pump(); }
  return null;
}

function hashing_() { return hashing ? [...pending] : []; }

async function pump() {
  if (hashing || !queue.length) return;
  hashing = true;
  const full = queue.shift();
  const started = Date.now();
  try {
    const st = await fsp.stat(full);
    const h = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(full, { highWaterMark: 8 * 1024 * 1024 });
      rs.on('data', (c) => h.update(c));
      rs.on('end', resolve);
      rs.on('error', reject);
    });
    const sha = h.digest('hex');
    db.prepare('INSERT OR REPLACE INTO installer_hashes (path, size, mtime, sha, at) VALUES (?, ?, ?, ?, ?)')
      .run(full, st.size, Math.round(st.mtimeMs), sha, Date.now());
    console.log(`installer checksum ready: ${path.basename(full)} (${Math.round(st.size / 1048576)} MB in ${Math.round((Date.now() - started) / 1000)} s)`);
  } catch (e) {
    console.error(`installer checksum failed: ${path.basename(full)}: ${e.message}`);
  } finally {
    pending.delete(full);
    hashing = false;
    setImmediate(pump);
  }
}

// ---- background listing
function createLister({ dirs, localDir }) {
  let cache = { at: 0, files: [] };
  let refreshing = null;

  async function scan() {
    const seen = new Map();
    for (const dir of dirs()) {
      let entries = [];
      try { entries = await fsp.readdir(dir); } catch { continue; }
      for (const f of entries) {
        if (f.startsWith('.') || f.endsWith('.part') || seen.has(f)) continue;
        let st; try { st = await fsp.stat(path.join(dir, f)); } catch { continue; }
        if (!st.isFile()) continue;
        seen.set(f, { name: f, size: st.size, source: dir === localDir ? 'cache' : dir, mtime: st.mtimeMs, dir });
      }
    }
    return [...seen.values()];
  }

  function refresh() {
    if (!refreshing) {
      refreshing = scan()
        .then((files) => { cache = { at: Date.now(), files }; })
        .catch((e) => console.error('installer listing failed:', e.message))
        .finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  // Last known listing, refreshed in the background when older than maxAgeMs.
  function list(maxAgeMs = 30000) {
    if (Date.now() - cache.at > maxAgeMs) refresh();
    return cache.files;
  }

  return { list, refresh, ready: () => cache.at > 0 };
}

module.exports = { sha256, hashingNow: hashing_, createLister };
