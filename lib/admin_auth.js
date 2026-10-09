'use strict';
// Who may use the tracker's admin API (2026-10-09).
//
// Until now everything outside the agent surface answered any process on the farm server with no
// credential at all, and that surface includes POST /api/run (a command as SYSTEM/root on every
// machine), deployments, uninstall, restart/shut-down, settings and the hidden-machines list. Now every
// such request must carry the header
//
//     X-Tracker-Admin: <config.adminToken>
//
// Farmly's /tracker relay (farmly/tracker_proxy.py) reads adminToken from this tracker's config.json
// (0600, this account only) and adds the header to everything it forwards. A script on the server
// either goes through Farmly or reads the token from config.json itself (HANDOFF.md section 0c).
//
// Open without it: the agent surface (authenticated by Farmly's relay / the agent keys, see
// agentAuthorized in server.js) and plain GETs of the static UI files (no data in them: the pages
// fetch their data from /api/*, which needs the token).
//
// config.requireAdminToken: true enforces it. Until then (absent or false) a request without a good
// token is still answered and logged, so the order "Farmly sends the token, then the tracker requires
// it" can be checked in logs/tracker.log before anything is refused.
const crypto = require('node:crypto');

const HEADER = 'x-tracker-admin';
// Told apart from a Farmly sign-in 401 by the dashboards (public/ui/lib/api.js): this one must not
// send the window to /login, because signing in again would not fix it.
const CODE = 'admin_token';

// What machines may still reach without the token: the agent API and the scripts that enrol one
// (which only say "Farmly installs the agent now", unless config.directAgents).
const AGENT_SURFACE = /^\/(agent|setup\.(sh|ps1)|enroll\.(sh|ps1)|elevate\.ps1)$|^\/api\/agent\//;

const TOKEN_RE = /^[A-Za-z0-9_-]{32,}$/;

function newToken() {
  return crypto.randomBytes(32).toString('base64url');   // 43 characters
}

// Give config an admin token if it has none (or one too short to be a secret). True when it changed,
// so the caller saves config.json. An existing good token is never replaced: Farmly holds a copy.
function ensureToken(config) {
  if (typeof config.adminToken === 'string' && TOKEN_RE.test(config.adminToken)) return false;
  config.adminToken = newToken();
  return true;
}

// Constant time: both sides are hashed to 32 bytes first, so neither the content nor the length of
// the real token shows in how long a wrong guess takes.
function tokenMatches(given, token) {
  if (typeof token !== 'string' || !token) return false;
  const g = Array.isArray(given) ? given[0] : given;
  const a = crypto.createHash('sha256').update(String(g == null ? '' : g)).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  const same = crypto.timingSafeEqual(a, b);
  return same && g != null && g !== '';
}

// Does this request need the token? Everything but the agent surface and GET/HEAD of a non-/api/
// path (the static UI and its redirects).
function needsToken(method, pathname) {
  const p = String(pathname || '');
  if (AGENT_SURFACE.test(p)) return false;
  if ((method === 'GET' || method === 'HEAD') && !p.startsWith('/api/') && p !== '/api') return false;
  return true;
}

const enforced = (config) => config.requireAdminToken === true;

// The verdict on one request: { ok: true } or { ok: false, status: 401, body }.
// `warn` is set when the token is missing or wrong but not enforced yet (the caller logs it).
function check(req, pathname, config) {
  if (!needsToken(req.method, pathname)) return { ok: true };
  const given = req.headers[HEADER];
  if (tokenMatches(given, config.adminToken)) return { ok: true };
  const missing = given == null || given === '';
  const error = missing
    ? "The tracker's admin API needs its admin token: send it as the X-Tracker-Admin header (adminToken in the tracker's config.json), or use the tracker through Farmly (Apps), which adds it."
    : 'The X-Tracker-Admin token is wrong: it must be adminToken from the tracker\'s config.json, or use the tracker through Farmly (Apps).';
  if (!enforced(config)) return { ok: true, warn: missing ? 'missing' : 'wrong' };
  return { ok: false, status: 401, body: { error, code: CODE } };
}

// Report-only mode logs each method + path at most once per `everyMs`, so a 10-second poll does not
// fill logs/tracker.log.
function createWarnLimiter(everyMs = 10 * 60 * 1000, now = Date.now) {
  const last = new Map();
  return (key) => {
    const t = now();
    if (last.has(key) && t - last.get(key) < everyMs) return false;
    last.set(key, t);
    if (last.size > 500) last.clear();
    return true;
  };
}

// Where the server listens. HOST env, else config.listenHost, else 127.0.0.1: every agent reports
// through Farmly's /beacon, which relays from this computer, so nothing on the LAN needs :4400.
// Only config.directAgents (machines reporting here directly again) makes the default all interfaces.
// "0.0.0.0" can still be set by hand, but then the admin API is one stolen token away from the whole
// LAN instead of from this computer only (the fromThisComputer guard in server.js still refuses LAN
// requests, but it is one check instead of two).
function listenHost(config, env = process.env) {
  if (env.HOST) return env.HOST;
  if (typeof config.listenHost === 'string' && config.listenHost.trim()) return config.listenHost.trim();
  return config.directAgents === true ? '0.0.0.0' : '127.0.0.1';
}

// POST /api/run must say why. Returns { reason } or { error }.
const REASON_MAX = 300;
function runReason(body) {
  const r = body && typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!r) return { error: 'reason required: say why this command is being run (it goes to the activity log with it)' };
  if (r.length > REASON_MAX) return { error: `reason is ${r.length} characters: keep it to ${REASON_MAX}` };
  return { reason: r };
}

module.exports = {
  HEADER, CODE, AGENT_SURFACE, REASON_MAX,
  newToken, ensureToken, tokenMatches, needsToken, enforced, check, createWarnLimiter, listenHost, runReason,
};
