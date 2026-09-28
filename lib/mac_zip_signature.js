'use strict';
// Is the program inside a macOS .zip signed by the expected Apple developer, notarized, and built
// for Apple Silicon? An archive carries no signature of its own, so the agents install one only on
// the server's word (signaturePolicy). The tracker server is a Mac, so it unpacks the zip and asks
// codesign and Gatekeeper (spctl) about the binary itself, once per file version.
// Used for FFmpeg's Mac build (Martin Riedl's build server, team KU3N25YGLU): the evermeet.cx build
// it replaced was Intel only and could not start on a farm Mac without Rosetta ("Bad CPU type in
// executable", MACSTUDIO-N03, 2026-09-28).
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function run(cmd, args, timeout = 120000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout || ''}${stderr || ''}` });
    });
  });
}

function findFile(dir, name, depth) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return full;
    if (e.isDirectory() && depth > 0 && !e.name.startsWith('__MACOSX')) {
      const found = findFile(full, name, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

// { ok: true, label } or { ok: false, why }. `name` is the program's file name inside the zip
// (at most two folders down, like the install command looks), `team` the Apple Team ID it must carry.
async function checkZippedBinary(zipPath, name, team) {
  if (process.platform !== 'darwin') return { ok: false, why: 'only a Mac can check a Mac signature' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker_zipsig_'));
  try {
    const unz = await run('/usr/bin/unzip', ['-o', '-q', zipPath, '-d', dir], 300000);
    if (unz.code !== 0) return { ok: false, why: `could not unpack the zip (${unz.out.trim().slice(0, 200)})` };
    const bin = findFile(dir, name, 2);
    if (!bin) return { ok: false, why: `no ${name} inside the zip` };
    const kind = await run('/usr/bin/file', ['-b', bin]);
    if (!/Mach-O/.test(kind.out) || !/arm64/.test(kind.out)) {
      return { ok: false, why: `${name} is not built for Apple Silicon (${kind.out.trim().slice(0, 120)})` };
    }
    const verify = await run('/usr/bin/codesign', ['--verify', '--strict', bin]);
    if (verify.code !== 0) return { ok: false, why: `${name} is not validly signed (${verify.out.trim().slice(0, 200) || 'codesign refused it'})` };
    const info = (await run('/usr/bin/codesign', ['-dv', '--verbose=2', bin])).out;
    const got = (info.match(/TeamIdentifier=([A-Z0-9]{10})/) || [])[1] || '';
    const who = (info.match(/^Authority=(Developer ID Application: .+)$/m) || [])[1] || '';
    if (got !== team || !who) {
      return { ok: false, why: `${name} is signed by ${who || got || 'someone else'}, not by team ${team}` };
    }
    const gk = await run('/usr/sbin/spctl', ['-a', '-t', 'install', '-vv', bin]);
    if (gk.code !== 0 || !/Notarized Developer ID/.test(gk.out)) {
      return { ok: false, why: `Gatekeeper does not accept ${name} as notarized (${gk.out.trim().slice(0, 200)})` };
    }
    return { ok: true, label: `${who}, notarized` };
  } catch (e) {
    return { ok: false, why: `check failed: ${e.message}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { checkZippedBinary };
