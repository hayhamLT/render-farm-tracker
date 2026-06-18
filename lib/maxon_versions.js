'use strict';
// Maxon "latest available" auto-detector (web-based).
//
// mx1 can't report latest-available headlessly (its `hasUpdates` reads a cache only the
// Maxon App GUI refreshes), so instead we read Maxon's PUBLIC release notes. Maxon's
// support site is a Zendesk Help Center with a public JSON API; each product has a
// "Release Notes" section whose article titles carry the version, e.g.
//   "Redshift 2026.7.1 (2026.06) - June 17, 2026"
// We pull recent titles and take the HIGHEST version (don't trust the API's sort).
// Section IDs are overridable via config.json -> maxonVersionSections.
const https = require('node:https');

const DEFAULT_SECTIONS = {
  redshift: '4405730592274',
  cinema4d: '4405723907986',
  redgiant: '13336955539228',
  maxonapp: '4405723902226', // hidden in UI, but keep its catalog latest current for the ride-along
};
const HC = 'https://support.maxon.net/api/v2/help_center/en-us/sections';

function cmpVersion(a, b) {
  const pa = String(a).split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b).split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function getJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, {
      headers: { 'User-Agent': 'render-farm-tracker', Accept: 'application/json' },
      timeout: 20000,
    }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(getJson(new URL(res.headers.location, url).href, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; if (data.length > 5_000_000) req.destroy(new Error('response too large')); });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function latestForSection(sectionId) {
  const j = await getJson(`${HC}/${sectionId}/articles.json?per_page=30`);
  const versions = (j.articles || [])
    .map((a) => String(a.title || '').match(/(\d{4}\.\d+(?:\.\d+)?)/))
    .filter(Boolean)
    .map((m) => m[1]);
  if (!versions.length) return null;
  return versions.sort(cmpVersion).slice(-1)[0]; // highest
}

// Check Maxon public release notes and bump the catalog's latest_version UPWARD only.
// Best-effort: a failed product (or no network) is skipped, never throws.
async function checkMaxonVersions(db, logEvent, config) {
  const sections = { ...DEFAULT_SECTIONS, ...((config && config.maxonVersionSections) || {}) };
  const bumped = [];
  for (const [key, sectionId] of Object.entries(sections)) {
    let latest = null;
    try { latest = await latestForSection(sectionId); } catch { continue; }
    if (!latest) continue;
    const prod = db.prepare('SELECT * FROM products WHERE key = ?').get(key);
    if (!prod) continue;
    // Skip apps the user toggled off in the Catalog (maxonapp is self-managed → always checked).
    if (prod.dashboard_hidden && key !== 'maxonapp') continue;
    if (!prod.latest_version || cmpVersion(latest, prod.latest_version) > 0) {
      db.prepare('UPDATE products SET latest_version = ?, updated_at = ? WHERE key = ?')
        .run(latest, Date.now(), key);
      logEvent('catalog', `Auto-detected newer ${prod.name}: latest is now ${latest} (Maxon release notes)`);
      bumped.push(`${key} ${prod.latest_version || '—'}→${latest}`);
    }
  }
  return bumped;
}

// ---- installer auto-fetch: scrape Maxon's PUBLIC downloads page for direct CDN URLs ----
// The page (no login) links straight to .exe/.dmg installers, e.g.
//   https://installer.maxon.net/installer/rs/redshift_2026.7.1_<build>_win_x64.exe
// We extract them so the server can download the matching installer automatically when a
// new version is detected. (Cinema 4D isn't on this page — its installer stays manual.)
// Cinema 4D lives on its own per-major page; the rest are on the main downloads page.
// Overridable via config.maxonDownloadsPages (update the C4D page on a new major year).
const DOWNLOADS_PAGES = [
  'https://www.maxon.net/en/downloads',
  'https://www.maxon.net/en/downloads/cinema-4d-2026-downloads',
];
const INSTALLER_KEYWORDS = {
  cinema4d: /cinema4d|c4d/i,
  redshift: /redshift/i,
  redgiant: /redgiant/i,
  maxonapp: /maxon[_-]?app/i,
};

function getText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': 'render-farm-tracker' }, timeout: 25000 }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(getText(new URL(res.headers.location, url).href, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; if (data.length > 30_000_000) req.destroy(new Error('page too large')); });
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// All Maxon installer URLs across the public downloads pages.
async function fetchInstallerUrls(config) {
  const pages = (config && config.maxonDownloadsPages) || DOWNLOADS_PAGES;
  const all = [];
  for (const page of pages) {
    try {
      const html = await getText(page);
      all.push(...(html.match(/https:\/\/[a-z0-9.-]*maxon\.net\/[^"'\s)]+\.(?:exe|dmg)/gi) || []));
    } catch { /* skip a page that fails — best-effort */ }
  }
  return [...new Set(all)];
}

// Pick the best FULL installer URL for a product/version/OS — avoid the "_min" online
// installers and arm builds; prefer x64 on Windows.
function pickInstallerUrl(urls, keywordRe, version, os) {
  let pool = urls.filter((u) => keywordRe.test(u) && version && u.includes(version)
    && (os === 'windows' ? /\.exe$/i.test(u) : /\.dmg$/i.test(u))
    && !/_min\./i.test(u) && !/arm/i.test(u));
  if (os === 'windows') { const x64 = pool.filter((u) => /x64|x86_64|_win[_.]/i.test(u)); if (x64.length) pool = x64; }
  return pool[0] || null;
}

module.exports = { checkMaxonVersions, DEFAULT_SECTIONS, fetchInstallerUrls, pickInstallerUrl, INSTALLER_KEYWORDS };
