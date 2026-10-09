'use strict';
// node --test test/   — the admin token, the reason /api/run needs, and where the server listens.
// The pure decisions (lib/admin_auth.js) first, then a real server.js on a scratch copy of its own
// (temporary folder, own config.json and database, a free port on 127.0.0.1): never the live tracker.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const auth = require('../lib/admin_auth');

// ------------------------------------------------------------------ pure --
test('a token is made once: 32 random bytes, base64url; a good one is never replaced', () => {
  const c = {};
  assert.equal(auth.ensureToken(c), true);
  assert.match(c.adminToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(c.adminToken, 'base64url').length, 32);
  const first = c.adminToken;
  assert.equal(auth.ensureToken(c), false, 'kept: Farmly holds a copy');
  assert.equal(c.adminToken, first);
  for (const bad of ['', 'short', 42, null, 'x'.repeat(31), 'has spaces in it but is long enough!!']) {
    const d = { adminToken: bad };
    assert.equal(auth.ensureToken(d), true, `replaced: ${JSON.stringify(bad)}`);
    assert.match(d.adminToken, /^[A-Za-z0-9_-]{43}$/);
  }
  assert.notEqual(auth.newToken(), auth.newToken());
});

test('the token compare: right one only, and always through timingSafeEqual on equal-length digests', () => {
  const token = auth.newToken();
  const calls = [];
  const real = crypto.timingSafeEqual;
  crypto.timingSafeEqual = (a, b) => { calls.push([a.length, b.length]); return real(a, b); };
  try {
    assert.equal(auth.tokenMatches(token, token), true);
    assert.equal(auth.tokenMatches([token], token), true, 'a repeated header arrives as an array');
    assert.equal(auth.tokenMatches(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'), token), false);
    assert.equal(auth.tokenMatches('x', token), false, 'much shorter');
    assert.equal(auth.tokenMatches(token + token, token), false, 'longer');
    assert.equal(auth.tokenMatches('', token), false);
    assert.equal(auth.tokenMatches(undefined, token), false);
  } finally {
    crypto.timingSafeEqual = real;
  }
  assert.equal(calls.length, 7, 'every compare, right or wrong, short or long, goes through timingSafeEqual');
  assert.ok(calls.every(([a, b]) => a === 32 && b === 32), 'on SHA-256 digests: the length of a guess shows nothing');
  // No token configured matches nothing, not even an empty header.
  assert.equal(auth.tokenMatches('', ''), false);
  assert.equal(auth.tokenMatches(undefined, undefined), false);
});

test('which requests need the token', () => {
  const free = [
    ['POST', '/api/agent/checkin'], ['POST', '/api/agent/run-result'], ['POST', '/api/agent/upload'],
    ['POST', '/api/agent/jobs/5/status'], ['GET', '/api/agent/download/3'], ['GET', '/agent'],
    ['GET', '/setup.sh'], ['GET', '/enroll.ps1'], ['GET', '/elevate.ps1'],
    ['GET', '/'], ['GET', '/index.html'], ['GET', '/classic'], ['GET', '/ui/'], ['GET', '/ui/app.js'], ['HEAD', '/ui/app.css'],
  ];
  const locked = [
    ['GET', '/api/state'], ['GET', '/api/live'], ['GET', '/api/run'], ['POST', '/api/run'], ['GET', '/api/farm-gate'],
    ['POST', '/api/farm-gate'], ['POST', '/api/deployments'], ['POST', '/api/uninstall'], ['POST', '/api/nodes/3/reboot'],
    ['POST', '/api/nodes/3/shutdown'], ['POST', '/api/settings'], ['POST', '/api/hidden-nodes'], ['POST', '/api/mkdir'],
    ['POST', '/api/download-url'], ['GET', '/api/list-dirs'], ['DELETE', '/api/nodes/3'], ['POST', '/api/rotate-agent-key'],
    ['GET', '/api'], ['POST', '/ui/'], ['PUT', '/anything'], ['GET', '/api/agentx'], ['GET', '/api/agent-setup'],
  ];
  for (const [m, p] of free) assert.equal(auth.needsToken(m, p), false, `${m} ${p} is open`);
  for (const [m, p] of locked) assert.equal(auth.needsToken(m, p), true, `${m} ${p} needs the token`);
});

test('check(): 401 in words when enforced, answered with a warning when not yet', () => {
  const token = auth.newToken();
  const req = (method, h = {}) => ({ method, headers: h });
  const on = { adminToken: token, requireAdminToken: true };
  const off = { adminToken: token };
  assert.deepEqual(auth.check(req('GET', { 'x-tracker-admin': token }), '/api/state', on), { ok: true });
  const none = auth.check(req('GET'), '/api/state', on);
  assert.equal(none.ok, false);
  assert.equal(none.status, 401);
  assert.equal(none.body.code, 'admin_token');
  assert.match(none.body.error, /admin token/);
  assert.match(none.body.error, /X-Tracker-Admin/);
  const wrong = auth.check(req('POST', { 'x-tracker-admin': 'nope' }), '/api/run', on);
  assert.equal(wrong.status, 401);
  assert.match(wrong.body.error, /wrong/);
  assert.deepEqual(auth.check(req('POST'), '/api/agent/checkin', on), { ok: true }, 'the agent API is not the token\'s business');
  assert.deepEqual(auth.check(req('GET'), '/ui/app.js', on), { ok: true });
  // Not enforced: answered, and the caller is told to log it.
  assert.deepEqual(auth.check(req('GET'), '/api/state', off), { ok: true, warn: 'missing' });
  assert.deepEqual(auth.check(req('GET', { 'x-tracker-admin': 'nope' }), '/api/state', off), { ok: true, warn: 'wrong' });
  assert.deepEqual(auth.check(req('GET', { 'x-tracker-admin': token }), '/api/state', off), { ok: true });
  assert.equal(auth.check(req('GET'), '/api/state', { adminToken: token, requireAdminToken: 'yes' }).ok, true, 'only true enforces');
});

test('report-only warnings: once per method and path per window', () => {
  let t = 0;
  const due = auth.createWarnLimiter(1000, () => t);
  assert.equal(due('GET /api/state'), true);
  assert.equal(due('GET /api/state'), false);
  assert.equal(due('POST /api/farm-gate'), true);
  t = 1000;
  assert.equal(due('GET /api/state'), true);
});

test('/api/run needs a reason: non-empty, up to 300 characters', () => {
  assert.match(auth.runReason({}).error, /reason required/);
  assert.match(auth.runReason({ reason: '   ' }).error, /reason required/);
  assert.match(auth.runReason({ reason: 42 }).error, /reason required/);
  assert.match(auth.runReason(null).error, /reason required/);
  assert.deepEqual(auth.runReason({ reason: '  assign C4D licence after reimage  ' }), { reason: 'assign C4D licence after reimage' });
  assert.deepEqual(auth.runReason({ reason: 'x'.repeat(300) }), { reason: 'x'.repeat(300) });
  assert.match(auth.runReason({ reason: 'x'.repeat(301) }).error, /301 characters: keep it to 300/);
});

test('listen host: 127.0.0.1 unless told otherwise', () => {
  assert.equal(auth.listenHost({}, {}), '127.0.0.1');
  assert.equal(auth.listenHost({ listenHost: '' }, {}), '127.0.0.1');
  assert.equal(auth.listenHost({ listenHost: '0.0.0.0' }, {}), '0.0.0.0');
  assert.equal(auth.listenHost({ directAgents: true }, {}), '0.0.0.0', 'machines reporting here directly need the LAN');
  assert.equal(auth.listenHost({ directAgents: true, listenHost: '127.0.0.1' }, {}), '127.0.0.1');
  assert.equal(auth.listenHost({ listenHost: '0.0.0.0' }, { HOST: '127.0.0.1' }), '127.0.0.1', 'HOST env wins');
});

// ------------------------------------------------- a real server, scratch --
const REPO = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

// A copy of the tracker in a temporary folder (server.js resolves config.json, installers/ and
// public/ next to itself), with its own database (TRACKER_DB) and backups folder.
async function scratch(extraConfig = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rft-admin-'));
  fs.copyFileSync(path.join(REPO, 'server.js'), path.join(dir, 'server.js'));
  for (const d of ['lib', 'public', 'agents']) fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  const port = await freePort();
  const shares = path.join(dir, 'share');
  fs.mkdirSync(shares);
  const config = {
    port, agentKey: crypto.randomBytes(16).toString('hex'), offlineAfterSeconds: 180,
    sharedInstallers: shares, downloadDir: shares, installerSources: [shares],
    // A scratch tracker otherwise starts fetching vendor installers (1.5 GB within a minute, 2026-10-09).
    backupDir: path.join(dir, 'backups'), autoFetchMaxonInstallers: false, ...extraConfig,
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
  const env = { ...process.env, TRACKER_DB: path.join(dir, 'tracker.db'), PORT: String(port), OLLAMA_URL: 'http://127.0.0.1:9' };
  delete env.HOST;
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  const deadline = Date.now() + 15000;
  while (!/Render Farm Update Tracker/.test(out)) {
    if (child.exitCode != null) throw new Error('scratch tracker exited:\n' + out);
    if (Date.now() > deadline) { child.kill(); throw new Error('scratch tracker did not start:\n' + out); }
    await new Promise((r) => setTimeout(r, 50));
  }
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, p, { token, body, headers = {} } = {}) => {
    const h = { ...headers };
    if (token) h['X-Tracker-Admin'] = token;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  const readConfig = () => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  const stop = () => new Promise((resolve) => {
    if (child.exitCode != null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGTERM');   // by its own handle (PID), never by pattern
  });
  return { dir, port, base, call, readConfig, stop, log: () => out };
}

test('a real tracker requiring the token: refuses without it, answers with it, agents unaffected', async (t) => {
  const s = await scratch({ requireAdminToken: true });
  t.after(async () => { await s.stop(); fs.rmSync(s.dir, { recursive: true, force: true }); });

  // The token was made at start and saved, config.json still 0600.
  const cfg = s.readConfig();
  assert.match(cfg.adminToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(fs.statSync(path.join(s.dir, 'config.json')).mode & 0o777, 0o600);
  assert.ok(!s.log().includes(cfg.adminToken), 'the token is never printed');
  assert.match(s.log(), /Admin API : X-Tracker-Admin token required/);
  const token = cfg.adminToken;

  // No token / wrong token: 401 in words, marked as the tracker's own refusal.
  for (const [m, p, body] of [['GET', '/api/state'], ['GET', '/api/run?ids=1'], ['POST', '/api/settings', {}],
    ['POST', '/api/run', { hostnames: ['X'], command: 'whoami', reason: 'test' }], ['POST', '/api/hidden-nodes', { hostname: 'X' }],
    ['POST', '/api/nodes/1/reboot', {}], ['POST', '/api/mkdir', { path: path.join(s.dir, 'made') }]]) {
    const r = await s.call(m, p, { body });
    assert.equal(r.status, 401, `${m} ${p} without the token`);
    assert.equal(r.json.code, 'admin_token');
    assert.match(r.json.error, /X-Tracker-Admin/);
    assert.equal(r.headers.get('x-tracker-auth'), 'admin_token');
    const w = await s.call(m, p, { body, token: 'not-the-token' });
    assert.equal(w.status, 401, `${m} ${p} with a wrong token`);
    assert.match(w.json.error, /wrong/);
  }
  assert.equal(fs.existsSync(path.join(s.dir, 'made')), false, 'nothing refused was done');

  // With the token.
  const st = await s.call('GET', '/api/state', { token });
  assert.equal(st.status, 200);
  assert.ok(Array.isArray(st.json.nodes));
  assert.equal((await s.call('GET', '/api/farm-gate', { token })).status, 200);

  // Static UI without it.
  assert.equal((await s.call('GET', '/ui/')).status, 200);
  assert.equal((await s.call('GET', '/ui/lib/api.js')).status, 200);
  assert.equal((await s.call('GET', '/')).status, 302);
  assert.equal((await s.call('GET', '/agent')).status, 200, 'the agent source is the agent surface');

  // The agent API: no admin token needed. Farmly's relay (from this computer, naming the machine) gets in;
  // anything else gets the agent API's own "bad agent key", not the admin token's refusal.
  const ci = await s.call('POST', '/api/agent/checkin', {
    headers: { 'X-Farmly-Relay-Host': 'TEST-PC', 'X-Farmly-Relay-Ip': '10.10.10.200' },
    body: { hostname: 'TEST-PC', os: 'windows', agentVersion: '2.49.0', software: [] },
  });
  assert.equal(ci.status, 200, ci.text);
  assert.ok(ci.json.nodeId > 0);
  const bad = await s.call('POST', '/api/agent/checkin', { headers: { 'X-Agent-Key': 'wrong' }, body: { hostname: 'TEST-PC' } });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error, 'bad agent key');
  assert.equal(bad.headers.get('x-tracker-auth'), null);

  // /api/run: the token is not enough, it needs a reason; the reason is kept and logged.
  const noWhy = await s.call('POST', '/api/run', { token, body: { hostnames: ['TEST-PC'], command: 'whoami' } });
  assert.equal(noWhy.status, 400);
  assert.match(noWhy.json.error, /reason required/);
  const long = await s.call('POST', '/api/run', { token, body: { hostnames: ['TEST-PC'], command: 'whoami', reason: 'x'.repeat(301) } });
  assert.equal(long.status, 400);
  const ok = await s.call('POST', '/api/run', { token, body: { hostnames: ['TEST-PC'], command: 'whoami', reason: 'check who is signed in' } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.runs.length, 1);
  const got = await s.call('GET', `/api/run?ids=${ok.json.runs[0].id}`, { token });
  assert.equal(got.json.runs[0].reason, 'check who is signed in');
  const events = (await s.call('GET', '/api/state', { token })).json.events.map((e) => e.message);
  assert.ok(events.some((m) => m.includes('because: check who is signed in') && m.includes('whoami')), events.join('\n'));
  // The machine gets the command on its next check-in, without the reason (the agent has no use for it).
  const next = await s.call('POST', '/api/agent/checkin', {
    headers: { 'X-Farmly-Relay-Host': 'TEST-PC' }, body: { hostname: 'TEST-PC', os: 'windows', agentVersion: '2.49.0', software: [] },
  });
  assert.equal(next.json.run.length, 1);
  assert.equal(next.json.run[0].command, 'whoami');

  // Settings still save config.json 0600 and keep the token.
  const set = await s.call('POST', '/api/settings', { token, body: { maxConcurrentInstalls: 3 } });
  assert.equal(set.status, 200, set.text);
  assert.equal(s.readConfig().adminToken, token);
  assert.equal(s.readConfig().maxConcurrentInstalls, 3);
  assert.equal(fs.statSync(path.join(s.dir, 'config.json')).mode & 0o777, 0o600);
});

test('a real tracker listens on 127.0.0.1 only by default', async (t) => {
  const s = await scratch({ requireAdminToken: true });
  t.after(async () => { await s.stop(); fs.rmSync(s.dir, { recursive: true, force: true }); });
  assert.match(s.log(), /listening on 127\.0\.0\.1/);
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  if (!lan) return t.skip('no LAN address on this computer');
  const refused = await new Promise((resolve) => {
    const c = net.connect({ host: lan.address, port: s.port });
    c.on('connect', () => { c.destroy(); resolve(false); });
    c.on('error', (e) => resolve(e.code));
  });
  assert.equal(refused, 'ECONNREFUSED', `nothing answers on ${lan.address}:${s.port}`);
});

test('a real tracker not yet requiring the token answers and logs, and generates the token', async (t) => {
  const s = await scratch({});   // an existing config.json with no requireAdminToken: the upgrade case
  t.after(async () => { await s.stop(); fs.rmSync(s.dir, { recursive: true, force: true }); });
  const cfg = s.readConfig();
  assert.match(cfg.adminToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(cfg.requireAdminToken, undefined, 'not switched on by itself');
  assert.match(s.log(), /token NOT required yet/);
  const r = await s.call('GET', '/api/state');
  assert.equal(r.status, 200);
  await s.call('GET', '/api/state');   // a second one is not logged again
  await new Promise((res) => setTimeout(res, 100));
  const lines = s.log().split('\n').filter((l) => l.includes('Admin token missing on GET /api/state'));
  assert.equal(lines.length, 1, s.log());
  assert.equal((await s.call('GET', '/api/state', { token: cfg.adminToken })).status, 200);
});
