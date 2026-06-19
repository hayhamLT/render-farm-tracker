'use strict';
// Latest version + direct installer URLs for non-Maxon/non-Adobe apps from PUBLIC sources.
//   Blender — blender.org download page (official .msi / .dmg, no login).
//   FFmpeg  — the static builds ffmpeg.org itself recommends: gyan.dev (Windows) and
//             evermeet.cx (macOS). Distributed as a zip with the binary inside; we save
//             it under a versioned, OS-tagged name so the normal staging pipeline matches.
const https = require('node:https');

function cmp(a, b) {
  const pa = String(a).split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b).split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
function getText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': 'render-farm-tracker' }, timeout: 25000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(getText(new URL(res.headers.location, url).href, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; if (d.length > 30_000_000) req.destroy(new Error('too large')); });
      res.on('end', () => resolve(d));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
const base = (u) => u.split('/').pop();

async function blenderLatest() {
  const html = await getText('https://www.blender.org/download/');
  const all = html.match(/https:\/\/[^"'\s]*blender-\d[^"'\s]*\.(?:msi|dmg)/gi) || [];
  const pickHighest = (re) => {
    let best = null, bestV = null;
    for (const u of all.filter((x) => re.test(x))) {
      const m = u.match(/blender-(\d+\.\d+(?:\.\d+)?)/i);
      if (m && (!bestV || cmp(m[1], bestV) > 0)) { bestV = m[1]; best = u; }
    }
    if (!best) return null;
    // www.blender.org/.../release/... is an HTML landing page — the real binary is the
    // same path on the download.blender.org mirror.
    const url = best.replace(/https:\/\/www\.blender\.org\/download\/release\//i, 'https://download.blender.org/release/');
    return { url, version: bestV, filename: base(url) };
  };
  const windows = pickHighest(/windows-x64\.msi/i);
  const macos = pickHighest(/macos-arm64\.dmg/i);   // farm Macs are Apple Silicon
  const version = [windows, macos].filter(Boolean).map((x) => x.version).sort(cmp).slice(-1)[0] || null;
  return { version, windows, macos };
}

async function ffmpegLatest() {
  let winV = null, macV = null, macUrl = null;
  try { winV = (await getText('https://www.gyan.dev/ffmpeg/builds/release-version')).trim(); } catch { /* skip */ }
  try { const j = JSON.parse(await getText('https://evermeet.cx/ffmpeg/info/ffmpeg/release')); macV = j.version; macUrl = j.download && j.download.zip && j.download.zip.url; } catch { /* skip */ }
  const version = [winV, macV].filter(Boolean).sort(cmp).slice(-1)[0] || null;
  return {
    version,
    windows: winV ? { url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip', version: winV, filename: `ffmpeg-${winV}-windows-x64.zip` } : null,
    macos: (macV && macUrl) ? { url: macUrl, version: macV, filename: `ffmpeg-${macV}-macos.zip` } : null,
  };
}

// NotchLC Adobe CC Plugin — has SEPARATE per-OS versions. Windows: a direct CDN .exe
// (NotchLC_AdobeCC_Plugin_<ver>_win64.exe, NSIS). macOS: a go.notch.one short link whose
// slug carries the version (notchlc-1-4-3-macos) → the .pkg on the same CDN.
async function notchlcLatest() {
  const html = await getText('https://notchlc.notch.one/');
  let win = null, winV = null;
  for (const u of (html.match(/https:\/\/[^"'\s]*NotchLC_AdobeCC_Plugin_[\d.]+_win64\.exe/gi) || [])) {
    const m = u.match(/Plugin_(\d+\.\d+(?:\.\d+)?)_win64/i);
    if (m && (!winV || cmp(m[1], winV) > 0)) { winV = m[1]; win = u; }
  }
  // macOS: pick the highest-versioned go.notch.one short link, then FOLLOW it to its real
  // direct download URL (the page is an HTML meta-refresh to the CDN .pkg).
  let mac = null, macV = null, macLink = null;
  for (const l of (html.match(/https:\/\/go\.notch\.one\/notchlc-\d+-\d+-\d+-macos/gi) || [])) {
    const m = l.match(/notchlc-(\d+)-(\d+)-(\d+)-macos/i);
    if (!m) continue;
    const v = `${m[1]}.${m[2]}.${m[3]}`;
    if (!macV || cmp(v, macV) > 0) { macV = v; macLink = l; }
  }
  if (macLink) {
    try {
      const page = await getText(macLink);
      const mm = page.match(/url=(https?:\/\/[^"'\s>]+\.(?:pkg|dmg|zip))/i);
      if (mm) mac = mm[1];
    } catch { /* fall back below */ }
    if (!mac) mac = `https://cloudreleases.notch.one/NotchLC_AdobePlugin/NotchLC_AdobeCC_Plugin_${macV}_macOS.pkg`;
  }
  if (!win && !mac) return null;
  const out = { version: [winV, macV].filter(Boolean).sort(cmp).slice(-1)[0] || null };
  if (win) out.windows = { url: win, version: winV, filename: base(win) };
  if (mac) out.macos = { url: mac, version: macV, filename: base(mac) };
  return out;
}

// { blender: {...}, ffmpeg: {...}, notchlc: {...} } — each { version, windows, macos }.
async function fetchExtraLatest() {
  const out = {};
  try { out.blender = await blenderLatest(); } catch { /* skip */ }
  try { out.ffmpeg = await ffmpegLatest(); } catch { /* skip */ }
  try { out.notchlc = await notchlcLatest(); } catch { /* skip */ }
  return out;
}

module.exports = { fetchExtraLatest, cmp };
