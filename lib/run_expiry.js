'use strict';
// "Run a command" (POST /api/run) results that will never come: before this, such a run said "pending"
// for ever (#442 MINIPC-01 2026-09-24, #1295 AVA-02 2026-10-08). runVerdict() decides, for one pending
// run, whether to give up on it now and with what words; lib/commands.js applies it on a sweep.
//
//  • expired: the machine never picked the command up. Commands wait RUN_TTL_MS for the machine's
//    next check-in (lib/commands.js TTL.run), then are dropped.
//  • lost: the machine picked it up but no result came back within the command's own timeout and a
//    margin (an asUser run needs up to ~2 min more than its timeout, and the agent retries the report).
//  • Runs from before the tracker noted when a command was picked up (no timeout_s) are judged against
//    the longest timeout a run can have.

const MIN = 60 * 1000;
const RUN_TTL_MS = 30 * MIN;
const PICKUP_MARGIN_MS = 2 * MIN;
const RESULT_MARGIN_MS = 10 * MIN;
const MAX_TIMEOUT_S = 3600;

const when = (ms) => new Date(ms).toLocaleString();

// run: {status, created_at, delivered_at, timeout_s, hostname}. Returns null or {status, output}.
function runVerdict(run, now, { ttlMs = RUN_TTL_MS } = {}) {
  if (!run || run.status !== 'pending') return null;
  const host = run.hostname || 'the machine';
  if (run.delivered_at) {
    const secs = Number(run.timeout_s) > 0 ? Number(run.timeout_s) : MAX_TIMEOUT_S;
    if (now <= run.delivered_at + secs * 1000 + RESULT_MARGIN_MS) return null;
    return { status: 'lost', output: `[No result: ${host} picked this command up at ${when(run.delivered_at)} but no result came back `
      + `within its ${secs} s limit and ${RESULT_MARGIN_MS / MIN} min more. Marked lost by the tracker at ${when(now)}.]` };
  }
  if (run.timeout_s == null) {
    if (now <= run.created_at + ttlMs + MAX_TIMEOUT_S * 1000 + RESULT_MARGIN_MS) return null;
    return { status: 'lost', output: `[No result ever came back from ${host} (sent ${when(run.created_at)}). `
      + `Marked lost by the tracker at ${when(now)}.]` };
  }
  if (now <= run.created_at + ttlMs + PICKUP_MARGIN_MS) return null;
  return { status: 'expired', output: `[Not run: ${host} did not check in within ${ttlMs / MIN} min of the command being sent `
    + `(${when(run.created_at)}), so it never picked it up. Marked expired by the tracker at ${when(now)}.]` };
}

module.exports = { runVerdict, RUN_TTL_MS, RESULT_MARGIN_MS, MAX_TIMEOUT_S };
