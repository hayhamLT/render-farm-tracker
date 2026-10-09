'use strict';
// Decisions about install jobs that the reaper, auto-deploy, the check-in correction and the database
// migration share. Pure functions over plain rows (no database, no clock of their own), so
// test/job_rules.test.js can check them directly.
//
// What went wrong on 2026-10-06/07 (NVIDIA 617.42 on AVA-01), and the rule each part now follows:
//  • The reaper failed job #586 after 45 quiet minutes while the agent was still running it (the agent
//    allows an install 60 min, reports "installing" once, and lists the job as running at every
//    check-in). Now: the reaper waits longer than the agent's own limit (REAP_DEFAULT_MS) and never
//    reaps a job its agent listed as running a moment ago (SEEN_RUNNING_MS).
//  • Auto-deploy then queued a new job for AVA-01 every 3 minutes until 06:00 (134 jobs, each failing
//    "No space left on device", each a Slack alert), because a version proven elsewhere made a machine
//    whose install just failed eligible again on the next tick. Now: a machine with a real failure (or
//    RETRY_CAP lost-contact failures) of that version in the last HOLD_MS is left alone (machineHold).
//  • The check-in correction credited one more of those failed jobs every minute once a later install
//    worked (136 false "Verified on check-in" successes). Now: only a machine's newest job for an app,
//    one that really ran there, can be credited, once (creditable).

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// agents/render_agent.py INSTALL_TIMEOUT: an install command may run this long before the agent stops it
// and reports. The reaper must wait longer than that, or it fails installs that are still running.
const AGENT_INSTALL_LIMIT_MS = 60 * MIN;
const REAP_MARGIN_MS = 15 * MIN;
const REAP_DEFAULT_MS = AGENT_INSTALL_LIMIT_MS + REAP_MARGIN_MS;      // 75 min
const PENDING_EXPIRE_MS = 24 * HOUR;                                   // queued this long and never started
// Agents name the job they are running on every check-in (about once a minute). A job named this recently
// is alive, whatever its last status report says.
const SEEN_RUNNING_MS = 5 * MIN;
// A machine whose install of a version failed is not given that version again by auto-deploy for this long.
const HOLD_MS = 24 * HOUR;
// How many "not really a failure" tries (lost contact, refused before running) count as one real failure.
const RETRY_CAP = 3;
// The check-in correction only looks this far back.
const CREDIT_WINDOW_MS = 24 * HOUR;

// Compare dotted versions numerically: -1 | 0 | 1.
function cmpVersion(a, b) {
  const pa = String(a).split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b).split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// The reaper's limit for a job in flight: config.jobStaleMinutes when it is longer, never shorter than
// the agent's own install limit plus a margin.
function reapLimitMs(jobStaleMinutes) {
  const asked = Number(jobStaleMinutes) > 0 ? Number(jobStaleMinutes) * MIN : 0;
  return Math.max(asked, REAP_DEFAULT_MS);
}

const firstLine = (log) => String(log || '').split('\n').map((l) => l.trim()).find(Boolean) || '';

// Texts the tracker itself appends when it gives up on a job that may well have been fine, and the
// agent's refusal to start (a vendor checksum not verified yet). None of them says the install is broken.
const SOFT_FAILURE = [
  /likely agent restart/,                                    // the reaper (both wordings)
  /\[expired: /,                                             // the reaper: queued a day, never started
  /no longer running this job and no result ever arrived/,   // reconcileRunning: the agent dropped it
  /^Refused:/m,                                              // the agent refused before running anything
];
// What the agent reports when the installer never ran on the machine.
const NEVER_RAN = /^(Download failed:|SHA256 mismatch|Refused:)/;

// 'real' = the install failed; 'soft' = see SOFT_FAILURE; 'stopped' = someone stopped it; null = not a failure.
function classifyFailure(job) {
  if (!job) return null;
  if (job.status === 'cancelled') return 'stopped';
  if (job.status !== 'failed') return null;
  const log = String(job.log || '');
  return SOFT_FAILURE.some((re) => re.test(log)) ? 'soft' : 'real';
}

const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Should auto-deploy leave this machine alone for this version? `jobs` = the machine's jobs for that
// product@version@os. Returns null, or {job, since, until, reason}.
function machineHold(jobs, now, { holdMs = HOLD_MS, retryCap = RETRY_CAP } = {}) {
  const recent = (jobs || []).filter((j) => j.updated_at > now - holdMs).sort((a, b) => b.updated_at - a.updated_at || b.id - a.id);
  const blocking = recent.find((j) => ['real', 'stopped'].includes(classifyFailure(j)));
  if (blocking) {
    const what = classifyFailure(blocking) === 'stopped'
      ? `install #${blocking.id} was stopped`
      : `install #${blocking.id} failed: ${clip(firstLine(blocking.log)) || 'no report'}`;
    return { job: blocking.id, since: blocking.updated_at, until: blocking.updated_at + holdMs, reason: what };
  }
  const soft = recent.filter((j) => classifyFailure(j) === 'soft');
  if (soft.length >= retryCap) {
    return { job: soft[0].id, since: soft[0].updated_at, until: soft[0].updated_at + holdMs,
      reason: `${soft.length} tries ended without a result from its agent (last: #${soft[0].id})` };
  }
  return null;
}

// What the reaper does with a job: null (leave it), 'stale' (in flight, quiet past the limit) or
// 'expired' (queued past PENDING_EXPIRE_MS and never started). A job its agent named as running within
// SEEN_RUNNING_MS is always left alone.
function reapDecision(job, now, { staleMs = REAP_DEFAULT_MS, pendingMs = PENDING_EXPIRE_MS, seenMs = SEEN_RUNNING_MS } = {}) {
  if (job.agent_seen_at && now - job.agent_seen_at < seenMs) return null;
  if ((job.status === 'downloading' || job.status === 'installing') && job.updated_at < now - staleMs) return 'stale';
  if (job.status === 'pending' && job.updated_at < now - pendingMs) return 'expired';
  return null;
}

// The check-in correction. `newest` = this machine's NEWEST job for each app (by id), `installed` = Map of
// app -> the version the machine reports now. A failed job is credited only when it is that newest job,
// it really ran on the machine (started, and its own report is not a download/refusal), it ended within
// CREDIT_WINDOW_MS, and the machine now reports its target version or newer. Once credited it is a
// success, so it is never credited twice, and an older try never qualifies while a newer job exists.
function creditable(newest, installed, now, { windowMs = CREDIT_WINDOW_MS } = {}) {
  const out = [];
  for (const j of newest || []) {
    if (j.status !== 'failed' || !j.started_at) continue;
    if (!(j.updated_at > now - windowMs)) continue;
    if (!j.version || j.version === 'uninstall') continue;
    if (NEVER_RAN.test(firstLine(j.log))) continue;
    const have = installed.get(j.product_key);
    if (!have || cmpVersion(have, j.version) < 0) continue;
    out.push({ job: j, have });
  }
  return out;
}

// For the one-time migration: of the jobs the old correction marked "Verified on check-in", the ones the
// rule above would not have credited. Each row needs id, newest_id (the newest job id for the same
// machine and app) and started_at.
const VERIFIED_PREFIX = 'Verified on check-in:';
function miscredited(rows) {
  return (rows || []).filter((r) => String(r.log || '').startsWith(VERIFIED_PREFIX)
    && (r.id !== r.newest_id || !r.started_at));
}
// The line put in front of such a job's log (its status and the rest of its log stay as they were).
function miscreditNote(r, day) {
  const host = r.hostname || 'the machine';
  const app = `${r.product_key || 'the app'} ${r.version || ''}`.trim();
  return r.started_at
    ? `[Not this attempt (noted ${day}): job #${r.newest_id} is the latest try of ${r.product_key || 'this app'} on ${host}. `
      + `This earlier try was marked a success by mistake: the check-in correction used to credit earlier failed tries `
      + `too, once ${host} reported ${app}. Its own report, below, says what it really did.]\n`
    : `[Not this attempt (noted ${day}): this job never started on ${host}, so it installed nothing. It was marked a `
      + `success by mistake because ${host} reported ${app} from another install.]\n`;
}

module.exports = {
  MIN, HOUR, AGENT_INSTALL_LIMIT_MS, REAP_DEFAULT_MS, PENDING_EXPIRE_MS, SEEN_RUNNING_MS, HOLD_MS, RETRY_CAP,
  CREDIT_WINDOW_MS, VERIFIED_PREFIX,
  cmpVersion, reapLimitMs, firstLine, classifyFailure, machineHold, reapDecision, creditable, miscredited, miscreditNote,
};
