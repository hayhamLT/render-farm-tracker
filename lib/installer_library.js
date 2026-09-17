'use strict';
// The installer library on the share: which files belong to which app, one folder per app,
// and which old installers are safe to delete.
//
//   INSTALLERS/
//     Redshift/                 redshift_2026.9.0_…_win_x64.exe, redshift_2026.9.0_…_macos.dmg
//     NVIDIA Studio Driver/     616.92-desktop-…exe, 581.57-desktop-…exe
//     3DSMAX_2027_2/  Element…  ← anything the tracker doesn't recognise is never touched
//
// "Unused" is decided here, on the server, every time (never trusted from the browser): an
// installer the tracker recognises, with a readable version that is OLDER than what that app
// targets on that OS (both NVIDIA driver lines count), and not used by any queued or running
// install. Nothing is deleted automatically.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function createLibrary({ db, bases, keywordsFor, isBuiltin, cmpVersion, versionFromFilename, activeFilenames, logEvent }) {
  // Filenames the tracker has actually deployed (packages) — a custom app's name keywords alone
  // are too loose to claim a file on a shared folder.
  const knownFilenames = () => new Set(db.prepare("SELECT DISTINCT filename FROM packages WHERE filename != ''").all().map((r) => r.filename));
  const products = () => db.prepare('SELECT * FROM products').all();

  // A folder name that's safe on SMB/Windows/macOS.
  const folderName = (prod) => String(prod.name || prod.key).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || prod.key;

  const osOf = (name) => {
    if (/mac|osx|darwin|\.dmg$|\.pkg$/i.test(name)) return 'macos';
    if (/win|x64|\.exe$|\.msi$/i.test(name)) return 'windows';
    return null;
  };
  const stem = (n) => n.replace(/\.[a-z0-9]{1,6}$/i, '');

  // Which catalog app a filename is an installer for (built-in keywords first, then custom apps).
  function productFor(name, list = products()) {
    const s = stem(name);
    const ordered = [...list].sort((a, b) => (a.custom ? 1 : 0) - (b.custom ? 1 : 0));
    for (const p of ordered) {
      const kws = keywordsFor(p);
      if (kws.length && kws.some((re) => re.test(s))) return p;
    }
    return null;
  }

  function productDir(base, prod) { return path.join(base, folderName(prod)); }

  // Where a new download of this file should go: its app's folder inside `base`.
  function destinationFor(base, filename) {
    const prod = productFor(filename);
    if (!prod) return base;
    const dir = productDir(base, prod);
    try { fs.mkdirSync(dir, { recursive: true }); return dir; } catch { return base; }
  }

  // Folder names that count as app folders (for listing / resolving).
  const appFolderNames = () => products().map(folderName);

  // The versions each app/OS needs right now.
  function targetsFor(prod, os) {
    const t = [];
    if (prod.key === 'nvidia') { if (prod.latest_win) t.push(prod.latest_win); if (prod.latest_legacy) t.push(prod.latest_legacy); }
    const v = (os === 'windows' ? prod.latest_win : os === 'macos' ? prod.latest_mac : null) || prod.latest_version;
    if (v) t.push(v);
    return [...new Set(t)];
  }

  // Every file in the base folders and their app folders, classified.
  async function inventory() {
    const list = products();
    const byKey = new Map(list.map((p) => [p.key, p]));
    const folderToProduct = new Map(list.map((p) => [folderName(p), p]));
    const active = activeFilenames();
    const known = knownFilenames();
    const files = [];
    const seenDirs = new Set();
    const scanDir = async (dir, folderProd) => {
      if (seenDirs.has(dir)) return;
      seenDirs.add(dir);
      let entries = [];
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name.endsWith('.part') || e.name.endsWith('.uploading')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!folderProd && folderToProduct.has(e.name)) await scanDir(full, folderToProduct.get(e.name));
          continue;
        }
        let st; try { st = await fsp.stat(full); } catch { continue; }
        if (!st.isFile()) continue;
        let prod = folderProd || productFor(e.name, list);
        if (prod && !folderProd && !isBuiltin(prod.key) && !known.has(e.name)) prod = null;
        files.push({ name: e.name, path: full, dir, size: st.size, mtime: st.mtimeMs, product: prod ? prod.key : null, os: osOf(e.name), version: versionFromFilename(e.name), organized: !!folderProd });
      }
    };
    for (const b of bases()) await scanDir(b, null);

    // Newest version per app/OS actually present (so an app with no catalog version keeps its newest).
    const newest = new Map();
    for (const f of files) {
      if (!f.product || !f.version) continue;
      const k = `${f.product}|${f.os}`;
      if (!newest.has(k) || cmpVersion(f.version, newest.get(k)) > 0) newest.set(k, f.version);
    }
    for (const f of files) {
      const prod = f.product && byKey.get(f.product);
      if (!prod) { f.status = 'other'; f.reason = 'Not an installer the tracker manages'; continue; }
      f.productName = prod.name;
      if (active.has(f.name)) { f.status = 'keep'; f.reason = 'Used by a queued or running install'; continue; }
      if (!f.version) { f.status = 'keep'; f.reason = 'No version in the file name'; continue; }
      const targets = targetsFor(prod, f.os);
      if (targets.some((t) => cmpVersion(f.version, t) === 0)) { f.status = 'keep'; f.reason = 'Current version'; continue; }
      if (targets.length && targets.every((t) => cmpVersion(f.version, t) > 0)) { f.status = 'keep'; f.reason = 'Newer than the catalog version'; continue; }
      if (!targets.length) {
        if (f.version === newest.get(`${f.product}|${f.os}`)) { f.status = 'keep'; f.reason = 'Newest one on the share'; continue; }
      }
      // For NVIDIA, anything between the legacy and current lines that isn't a target is old.
      const below = targets.length ? targets.filter((t) => cmpVersion(f.version, t) < 0) : [newest.get(`${f.product}|${f.os}`)];
      f.status = 'unused';
      f.reason = `Older than ${below.sort((a, b) => cmpVersion(a, b))[0] || 'the current version'}`;
    }
    return files;
  }

  // Recognised installers sitting loose in a base folder → move into their app folder.
  async function organizePlan() {
    const files = await inventory();
    const active = activeFilenames();
    const list = products();
    const byKey = new Map(list.map((p) => [p.key, p]));
    return files
      .filter((f) => f.product && !f.organized && !active.has(f.name) && bases().includes(f.dir))
      .map((f) => ({ ...f, to: path.join(productDir(f.dir, byKey.get(f.product)), f.name), folder: folderName(byKey.get(f.product)) }));
  }

  async function organize() {
    const plan = await organizePlan();
    const moved = []; const skipped = [];
    for (const f of plan) {
      try {
        await fsp.mkdir(path.dirname(f.to), { recursive: true });
        if (fs.existsSync(f.to)) { skipped.push({ name: f.name, why: 'a file with that name is already in the folder' }); continue; }
        await fsp.rename(f.path, f.to);   // same share → instant, no copy
        db.prepare('UPDATE installer_hashes SET path = ? WHERE path = ?').run(f.to, f.path);
        moved.push({ name: f.name, folder: f.folder });
      } catch (e) { skipped.push({ name: f.name, why: e.message }); }
    }
    if (moved.length) logEvent('package', `Organized ${moved.length} installer${moved.length === 1 ? '' : 's'} into app folders`);
    return { moved, skipped };
  }

  // Delete the requested files — only those the server itself classifies as unused right now.
  async function removeUnused(paths) {
    const wanted = new Set((paths || []).map(String));
    const files = await inventory();
    const removed = []; const refused = [];
    let freed = 0;
    for (const p of wanted) {
      const f = files.find((x) => x.path === p);
      if (!f) { refused.push({ path: p, why: 'not found in the installer folders' }); continue; }
      if (f.status !== 'unused') { refused.push({ path: p, why: f.reason }); continue; }
      try { await fsp.unlink(f.path); db.prepare('DELETE FROM installer_hashes WHERE path = ?').run(f.path); removed.push(f.name); freed += f.size; } catch (e) { refused.push({ path: p, why: e.message }); }
    }
    if (removed.length) logEvent('package', `Deleted ${removed.length} unused installer${removed.length === 1 ? '' : 's'} (${(freed / 1073741824).toFixed(1)} GB): ${removed.join(', ')}`);
    return { removed, refused, freed };
  }

  return { inventory, organizePlan, organize, removeUnused, destinationFor, appFolderNames, productFor, folderName };
}

module.exports = { createLibrary };
