// Rollouts: the "When" picker in the update sheet (now / tonight / a chosen time, finish-by,
// idle-only, wake, Slack report) and the list of scheduled, running and finished rollouts.
import { html } from '../lib/html.js';
import { useEffect, useState } from 'preact/hooks';
import { signal } from '@preact/signals-core';
import { post } from '../lib/api.js';
import { pref, toast, confirm } from '../lib/ui.js';
import { plural } from '../lib/format.js';
import { go } from '../lib/router.js';
import { Icon, Badge } from './common.js';
import { StackBar } from './viz.js';

const MIN = 60000;
const DAY = 24 * 60 * MIN;

// ---------------------------------------------------------------- time helpers
const at = (hhmm, base = new Date()) => {
  const [h, m] = String(hhmm || '02:00').split(':').map(Number);
  const d = new Date(base); d.setHours(h || 0, m || 0, 0, 0);
  return d.getTime();
};
// Next occurrence of a time of day (today if still ahead, else tomorrow).
const nextAt = (hhmm, now = Date.now()) => { const t = at(hhmm); return t > now + MIN ? t : t + DAY; };

export function whenLabel(ts, now = Date.now()) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date(now).toDateString();
  const tomorrow = new Date(now + DAY).toDateString();
  if (d.toDateString() === today) return d.getHours() >= 17 ? `tonight ${time}` : `today ${time}`;
  if (d.toDateString() === tomorrow) return d.getHours() < 7 ? `tonight ${time}` : `tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
}
const pastLabel = (ts, now = Date.now()) => {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date(now).toDateString()) return `today ${time}`;
  if (d.toDateString() === new Date(now - DAY).toDateString()) return `yesterday ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
};
const inText = (ms) => {
  if (ms <= 0) return 'now';
  const m = Math.round(ms / MIN);
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  return `in ${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
};

// ---------------------------------------------------------------- the picker
export const when = signal('now');            // now | tonight | custom
const custom = signal('');                    // datetime-local value
export const startTime = pref('rollout.start', '02:00');
export const finishTime = pref('rollout.finish', '06:00');
export const useFinish = pref('rollout.useFinish', true);
export const idleOnly = pref('rollout.idleOnly', true);
export const wakeFirst = pref('rollout.wake', true);
export const nextNight = pref('rollout.nextNight', true);
export const report = pref('rollout.report', true);

// The request body for POST /api/rollouts, from the picker's state.
export function rolloutPlan(name, s) {
  const now = Date.now();
  let runAt = now;
  if (when.value === 'tonight') runAt = nextAt(startTime.value, now);
  if (when.value === 'custom' && custom.value) runAt = Math.max(now, new Date(custom.value).getTime());
  const later = runAt > now + MIN;
  const finish = later && useFinish.value ? at(finishTime.value, new Date(runAt)) : null;
  return {
    name, run_at: runAt, finish_by: finish, idle_only: idleOnly.value,
    wake: later && wakeFirst.value, next_night: nextNight.value, report: !!(s && s.slackWebhook) && report.value, later,
  };
}

export function resetWhen() { when.value = 'now'; }

export function WhenPicker({ s }) {
  const slack = !!(s && s.slackWebhook);
  const plan = rolloutPlan('', s);
  // Seed the custom field with the next start so the input isn't empty.
  useEffect(() => {
    if (when.value === 'custom' && !custom.value) {
      const d = new Date(nextAt(startTime.value));
      custom.value = new Date(d.getTime() - d.getTimezoneOffset() * MIN).toISOString().slice(0, 16);
    }
  }, [when.value]);
  const later = when.value !== 'now';
  return html`<div class="when">
    <div class="deploy-field"><span class="label">When</span>
      <div class="seg">${[['now', 'Now', 'play'], ['tonight', 'Tonight', 'moon'], ['custom', 'Pick a time', 'clock']].map(([k, l, i]) => html`<button key=${k} class=${when.value === k ? 'on' : ''} onClick=${() => { when.value = k; }}><${Icon} name=${i} />${l}</button>`)}</div>
    </div>
    ${later && html`<div class="when-times">
      ${when.value === 'tonight'
        ? html`<label class="when-t">Start<input class="field" type="time" value=${startTime.value} onInput=${(e) => { startTime.value = e.currentTarget.value; }} /></label>`
        : html`<label class="when-t">Start<input class="field" type="datetime-local" value=${custom.value} onInput=${(e) => { custom.value = e.currentTarget.value; }} /></label>`}
      <label class="when-t"><span class="row" style="gap:6px"><input type="checkbox" checked=${useFinish.value} onChange=${(e) => { useFinish.value = e.currentTarget.checked; }} />Finish by</span>
        <input class="field" type="time" disabled=${!useFinish.value} value=${finishTime.value} onInput=${(e) => { finishTime.value = e.currentTarget.value; }} /></label>
      <span class="when-summary"><${Icon} name="clock" />Starts <b>${whenLabel(plan.run_at)}</b> (${inText(plan.run_at - Date.now())})${plan.finish_by ? html`, no new installs after <b>${whenLabel(plan.finish_by)}</b>` : ''}</span>
    </div>`}
    <div class="when-opts">
      <label class="check" title="A machine whose GPU is busy (rendering) waits until it's idle before its install starts"><input type="checkbox" checked=${idleOnly.value} onChange=${(e) => { idleOnly.value = e.currentTarget.checked; }} />Only on idle machines</label>
      ${later && html`<label class="check" title="Machines that are off or asleep at the start get a Wake-on-LAN, then install"><input type="checkbox" checked=${wakeFirst.value} onChange=${(e) => { wakeFirst.value = e.currentTarget.checked; }} />Wake sleeping machines first</label>`}
      ${later && useFinish.value && html`<label class="check" title="Machines that didn't get their turn continue at the same time the next night (up to a week)"><input type="checkbox" checked=${nextNight.value} onChange=${(e) => { nextNight.value = e.currentTarget.checked; }} />Unfinished machines continue next night</label>`}
      <label class=${'check' + (slack ? '' : ' dim')} title=${slack ? 'Posts a summary to Slack when the rollout finishes' : 'Add a Slack webhook in Settings to get reports'}>
        <input type="checkbox" disabled=${!slack} checked=${slack && report.value} onChange=${(e) => { report.value = e.currentTarget.checked; }} />Slack report when done${slack ? '' : html` <button class="linkish" onClick=${() => go('settings')}>(set up)</button>`}</label>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- list
async function cancelRollout(r) {
  const queued = r.counts.pending;
  const ok = await confirm(`${queued ? `${plural(queued, 'queued install')} will be removed. ` : ''}Installs already running finish normally.`,
    { title: `Cancel “${r.name}”?`, confirmLabel: 'Cancel rollout', cancelLabel: 'Keep it', danger: true });
  if (!ok) return;
  try { await post(`/api/rollouts/${r.id}/cancel`); toast('Rollout cancelled.', 'success'); } catch (e) { toast(e.message, 'error'); }
}
async function startRollout(r) {
  try { await post(`/api/rollouts/${r.id}/start`); toast(`${r.name} started.`, 'success'); } catch (e) { toast(e.message, 'error'); }
}

function useNow(ms = 30000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

function RolloutCard({ r, now, slack }) {
  const c = r.counts;
  const scheduled = r.status === 'scheduled';
  const running = r.status === 'running';
  const open = scheduled || running;
  const tags = [
    r.idle_only ? 'idle machines only' : null,
    r.wake ? 'wakes sleeping machines' : null,
    r.finish_by ? `finish by ${new Date(r.finish_by).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${r.next_night ? ', continues next night' : ''}` : null,
    r.report && slack ? 'Slack report' : null,
  ].filter(Boolean);
  const failedHosts = r.summary ? r.summary.failed.map((f) => f.host) : [];
  return html`<article class=${'rcard ' + r.status}>
    <header class="row" style="flex-wrap:nowrap;gap:10px">
      <span class=${'rcard-icon ' + r.status}><${Icon} name=${scheduled ? 'clock' : running ? 'spinner' : r.status === 'cancelled' ? 'stop' : c.failed ? 'alert' : 'check'} cls=${running ? 'spin' : ''} /></span>
      <div class="grow" style="min-width:0">
        <b class="rcard-name">${r.name}</b>
        <span class="rcard-when">${scheduled ? html`${r.nights ? `Paused — night ${r.nights + 1} ` : 'Starts '}<b>${whenLabel(r.run_at, now)}</b> · ${inText(r.run_at - now)}`
          : running ? html`Running since ${new Date(r.started_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
          : r.status === 'cancelled' ? `Cancelled ${pastLabel(r.finished_at, now)}`
          : `Finished ${pastLabel(r.finished_at, now)}`} · ${plural(c.machines, 'machine')}</span>
      </div>
      ${scheduled && html`<button class="btn sm" onClick=${() => startRollout(r)}><${Icon} name="play" />Start now</button>`}
      ${open && html`<button class="btn sm ghost" onClick=${() => cancelRollout(r)} title="Cancel the rollout">Cancel</button>`}
    </header>
    ${running || c.success || c.failed ? html`<${StackBar} height=${7} total=${c.total} parts=${[
      { value: c.success, color: 'var(--ok)', label: 'installed' },
      { value: c.running, color: 'var(--accent)', label: 'installing' },
      { value: c.pending, color: scheduled ? 'var(--surface-3)' : 'var(--info)', label: scheduled ? 'waiting' : 'queued' },
      { value: c.failed, color: 'var(--bad)', label: 'failed' },
      { value: c.cancelled, color: 'var(--text-3)', label: 'stopped' },
    ]} />` : null}
    <div class="legend" style="font-size:.76rem">
      ${c.success ? html`<span><i style="background:var(--ok)"></i>${c.success} installed</span>` : null}
      ${c.running ? html`<span><i style="background:var(--accent)"></i>${c.running} installing</span>` : null}
      ${c.pending ? html`<span><i style=${`background:${scheduled ? 'var(--text-3)' : 'var(--info)'}`}></i>${c.pending} ${scheduled ? 'waiting' : 'queued'}</span>` : null}
      ${c.failed ? html`<span style="color:var(--bad-text)" title=${failedHosts.join(', ')}><i style="background:var(--bad)"></i>${c.failed} failed${failedHosts.length ? ` (${failedHosts.slice(0, 3).join(', ')}${failedHosts.length > 3 ? '…' : ''})` : ''}</span>` : null}
      ${c.cancelled ? html`<span><i style="background:var(--text-3)"></i>${c.cancelled} stopped</span>` : null}
    </div>
    ${open && tags.length ? html`<div class="rcard-tags">${tags.map((t) => html`<${Badge} key=${t}>${t}<//>`)}</div>` : null}
  </article>`;
}

export function RolloutList({ s, limitDone = 4 }) {
  const now = useNow();
  const list = (s && s.rollouts) || [];
  const open = list.filter((r) => ['scheduled', 'running'].includes(r.status))
    .sort((a, b) => (a.status === b.status ? a.run_at - b.run_at : a.status === 'running' ? -1 : 1));
  const done = list.filter((r) => !['scheduled', 'running'].includes(r.status)).slice(0, limitDone);
  if (!open.length && !done.length) return null;
  return html`<div class="rlist">
    ${open.map((r) => html`<${RolloutCard} key=${r.id} r=${r} now=${now} slack=${!!s.slackWebhook} />`)}
    ${done.length ? html`<details class="rdone" open=${!open.length}>
      <summary>Recently finished <span class="dim">(${done.length})</span></summary>
      <div class="rlist">${done.map((r) => html`<${RolloutCard} key=${r.id} r=${r} now=${now} slack=${!!s.slackWebhook} />`)}</div>
    </details>` : null}
  </div>`;
}

// For job/machine badges: the scheduled rollout a pending job is waiting for, if any.
export function waitingRollout(s, job) {
  if (!job || job.status !== 'pending' || !job.rollout_id || !s || !s.rollouts) return null;
  const r = s.rollouts.find((x) => x.id === job.rollout_id);
  return r && r.status === 'scheduled' ? r : null;
}
