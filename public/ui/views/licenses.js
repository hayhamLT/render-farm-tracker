// Licenses — who is signed in where, what each machine holds, and what's about to run out.
//
// Everything here is read by the agent in the signed-in user's own session (Maxon and Adobe
// sign-ins belong to the user, not the machine) and refreshed every 10 minutes, or straight
// after an action. Assigning Adobe seats to people stays in Adobe's Admin Console — that's
// where Adobe manages licensing by design — so this page shows the state and links there.
//
// The tracker never stores or sends passwords. Maxon sign-in uses a login token, which is held
// in the server's memory only until the machine collects it.
import { html } from '../lib/html.js';
import { useState } from 'preact/hooks';
import { signal } from '@preact/signals-core';
import { farm, refresh } from '../lib/store.js';
import { post } from '../lib/api.js';
import { go } from '../lib/router.js';
import { openMenu, openSheet, confirm, toast, pref } from '../lib/ui.js';
import { ago, plural, parseJSON } from '../lib/format.js';
import { Icon, OsStatus, Empty } from '../components/common.js';
import { PageHeader } from '../components/page.js';

const DAY = 24 * 3600 * 1000;
const SOON_DAYS = 45;                                  // "expiring soon" horizon
const filter = pref('licenses.filter', 'all');
const search = signal('');
const selected = signal(new Set());

const ACTION_LABEL = {
  maxon_refresh: 'Refresh Maxon account',
  maxon_logout: 'Sign out of Maxon',
  maxon_login_token: 'Sign in to Maxon with a token',
  ae_render_only_on: 'Make a render-only node',
  ae_render_only_off: 'Turn off render-only mode',
  win_logoff_disconnected: 'Log off disconnected sessions',
};

const daysLeft = (end, now) => Math.ceil((new Date(end + 'T23:59:59').getTime() - now) / DAY);
const fmtDate = (d) => new Date(d + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

// One row per machine: the parsed report plus the bits the page filters on.
function model(s) {
  const now = s.now || Date.now();
  return s.nodes.map((n) => {
    const li = parseJSON(n.license_info) || null;
    const last = parseJSON(n.license_action) || [];
    const lic = (li && li.maxon && li.maxon.licenses) || [];
    const soonest = lic.filter((l) => !l.expired).map((l) => ({ ...l, days: daysLeft(l.end, now) })).sort((a, b) => a.days - b.days)[0] || null;
    const sessions = (li && li.sessions) || [];
    return {
      n, li, last, lic, soonest,
      maxonAccount: li && li.maxon && li.maxon.user && li.maxon.user.account,
      aeRenderOnly: li && li.adobe ? li.adobe.renderOnly : null,
      adobeIds: (li && li.adobe && li.adobe.accounts) || [],
      sessions,
      signedIn: sessions.length > 0,
      disconnected: sessions.filter((x) => x.state === 'disconnected'),
      autologin: li && li.autologin,
      supported: n.agent_version && n.agent_version.localeCompare('2.37.0', undefined, { numeric: true }) >= 0,
    };
  });
}

const FILTERS = [
  ['all', 'All', () => true],
  ['expiring', 'Expiring soon', (m) => m.soonest && m.soonest.days <= SOON_DAYS],
  ['seat', 'Uses an Adobe seat', (m) => m.aeRenderOnly === false],
  ['nomaxon', 'No Maxon sign-in', (m) => m.li && m.li.maxon && !m.maxonAccount],
  ['nobody', 'Nobody signed in', (m) => m.li && !m.signedIn],
  ['noauto', 'Auto-login off', (m) => m.autologin && m.autologin.enabled === false],
];

async function run(rows, action, extra = {}) {
  const targets = rows.filter((m) => m.n.online && m.supported);
  const skipped = rows.length - targets.length;
  let ok = 0;
  for (const m of targets) {
    try { await post(`/api/nodes/${m.n.id}/license`, { action, ...extra }); ok++; } catch (e) { toast(`${m.n.hostname}: ${e.message}`, 'error', 7000); }
  }
  if (ok) toast(`${ACTION_LABEL[action]}: sent to ${plural(ok, 'machine')} — results appear here within a minute.`, 'success', 6000);
  if (skipped) toast(`${plural(skipped, 'machine')} skipped — offline, or its agent hasn't updated yet.`, 'info', 6000);
  refresh();
}

async function confirmThen(rows, action) {
  const names = rows.map((m) => m.n.hostname);
  const text = {
    maxon_logout: `Sign ${names.length === 1 ? names[0] : plural(names.length, 'machine')} out of Maxon? Cinema 4D and Redshift there won't render until someone signs back in.`,
    ae_render_only_off: `Turn off render-only mode on ${names.length === 1 ? names[0] : plural(names.length, 'machine')}? After Effects there will need a signed-in Adobe seat again.`,
    win_logoff_disconnected: `Log off disconnected Windows sessions on ${names.length === 1 ? names[0] : plural(names.length, 'machine')}? Only sessions nobody is connected to are touched — anything left open in them is closed.`,
  }[action];
  if (text && !await confirm(text, { title: ACTION_LABEL[action], confirmLabel: ACTION_LABEL[action], danger: action !== 'ae_render_only_on' })) return;
  run(rows, action);
}

function TokenSheet({ m, close }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await post(`/api/nodes/${m.n.id}/license`, { action: 'maxon_login_token', token: token.trim() });
      toast(`Sign-in sent to ${m.n.hostname}.`, 'success');
      refresh(); close(true);
    } catch (e) { toast(e.message, 'error', 7000); setBusy(false); }
  };
  return html`<div class="form">
    <p style="margin:0">Paste the Maxon login token for <b>${m.n.hostname}</b>. It signs this machine's user in to Maxon without a password.</p>
    <label>Login token<input class="field mono" type="password" autocomplete="off" value=${token} onInput=${(e) => setToken(e.currentTarget.value)} placeholder="token" /></label>
    <p class="dim" style="margin:0;font-size:.82rem">The tracker never stores it: it's held in memory until ${m.n.hostname} collects it (within a minute), then forgotten. It isn't written to the database or the log.</p>
    <div class="row" style="justify-content:flex-end;gap:8px">
      <button class="btn ghost" onClick=${() => close(null)}>Cancel</button>
      <button class="btn primary" disabled=${busy || token.trim().length < 8} onClick=${send}><${Icon} name=${busy ? 'spinner' : 'key'} cls=${busy ? 'spin' : ''} />Sign in</button>
    </div>
  </div>`;
}

function rowMenu(e, m) {
  const off = !m.n.online || !m.supported;
  openMenu(e.currentTarget, [
    { label: 'Refresh Maxon account', icon: 'refresh', disabled: off, onSelect: () => run([m], 'maxon_refresh') },
    { label: 'Sign in to Maxon with a token…', icon: 'key', disabled: off, onSelect: () => openSheet((close) => html`<${TokenSheet} m=${m} close=${close} />`, { title: 'Sign in to Maxon', width: 480 }) },
    { label: 'Sign out of Maxon', icon: 'x', danger: true, disabled: off || !m.maxonAccount, onSelect: () => confirmThen([m], 'maxon_logout') },
    '-',
    m.aeRenderOnly
      ? { label: 'Turn off render-only mode', icon: 'eyeOff', disabled: off, onSelect: () => confirmThen([m], 'ae_render_only_off') }
      : { label: 'Make a render-only node', icon: 'film', disabled: off, onSelect: () => run([m], 'ae_render_only_on') },
    m.n.os === 'windows' ? { label: 'Log off disconnected sessions', icon: 'power', disabled: off || !m.disconnected.length, onSelect: () => confirmThen([m], 'win_logoff_disconnected') } : null,
    '-',
    { label: 'Open machine', icon: 'server', onSelect: () => go('machines', m.n.hostname) },
  ].filter(Boolean));
}

function Summary({ rows, now }) {
  const reported = rows.filter((m) => m.li);
  const accounts = new Map();
  for (const m of reported) if (m.maxonAccount) accounts.set(m.maxonAccount, (accounts.get(m.maxonAccount) || 0) + 1);
  const expiring = new Map();   // license end → { desc, end, days, machines }
  for (const m of reported) for (const l of m.lic) {
    if (l.expired) continue;
    const d = daysLeft(l.end, now);
    if (d > SOON_DAYS) continue;
    const k = `${l.description}|${l.end}`;
    const e = expiring.get(k) || { desc: l.description, end: l.end, days: d, machines: 0 };
    e.machines++; expiring.set(k, e);
  }
  const ae = reported.filter((m) => m.aeRenderOnly != null);
  const aeOnly = ae.filter((m) => m.aeRenderOnly).length;
  const adobeAccounts = new Set(reported.flatMap((m) => m.adobeIds));
  const signedIn = reported.filter((m) => m.signedIn).length;
  const autoOff = reported.filter((m) => m.autologin && m.autologin.enabled === false);
  const disc = reported.filter((m) => m.disconnected.length).length;
  const soon = [...expiring.values()].sort((a, b) => a.days - b.days);
  return html`<div class="lic-cards">
    <section class="card card-pad lic-card">
      <span class="l"><${Icon} name="key" />Maxon</span>
      ${accounts.size ? [...accounts].map(([acct, c]) => html`<div key=${acct}><b class="mono" style="font-size:.9rem">${acct}</b><span class="dim"> on ${plural(c, 'machine')}</span></div>`)
        : html`<div class="dim">No Maxon sign-ins reported yet</div>`}
      <span class="s">${reported.reduce((c, m) => c + m.lic.length, 0)} licenses · ${reported.reduce((c, m) => c + m.lic.filter((l) => l.activated).length, 0)} in use right now</span>
    </section>
    <section class=${'card card-pad lic-card' + (soon.length ? ' warn' : '')}>
      <span class="l"><${Icon} name="clock" />Expiring within ${SOON_DAYS} days</span>
      ${soon.length ? soon.slice(0, 3).map((e) => html`<div key=${e.desc + e.end}><b>${e.desc}</b><span class="dim"> — ${fmtDate(e.end)}</span><div class=${e.days <= 14 ? 'bad-text' : 'warn-text'}>${e.days <= 0 ? 'today' : `in ${plural(e.days, 'day')}`} · ${plural(e.machines, 'machine')}</div></div>`)
        : html`<div class="dim">Nothing runs out in the next ${SOON_DAYS} days</div>`}
    </section>
    <section class="card card-pad lic-card">
      <span class="l"><${Icon} name="film" />After Effects</span>
      <div><b>${aeOnly}</b><span class="dim">/${ae.length} render-only</span></div>
      <span class="s">${ae.length - aeOnly ? `${plural(ae.length - aeOnly, 'machine')} use${ae.length - aeOnly === 1 ? 's' : ''} an Adobe seat` : 'none use an Adobe seat'} · ${plural(adobeAccounts.size, 'Adobe account')} seen</span>
    </section>
    <section class=${'card card-pad lic-card' + (autoOff.length ? ' warn' : '')}>
      <span class="l"><${Icon} name="user" />Sign-in</span>
      <div><b>${signedIn}</b><span class="dim">/${reported.length} signed in</span>${disc ? html`<span class="dim"> · ${disc} disconnected</span>` : null}</div>
      <span class="s">${autoOff.length ? html`<span class="warn-text">Auto-login off: ${autoOff.map((m) => m.n.hostname).join(', ')}</span> — they won't render after a reboot until someone signs in` : 'Auto-login on everywhere'}</span>
    </section>
  </div>`;
}

function LicenseCell({ m, now }) {
  if (!m.li) return html`<span class="dim">${m.supported ? 'waiting for first report' : 'agent updating…'}</span>`;
  if (!m.li.maxon) return html`<span class="dim">Maxon not installed</span>`;
  if (!m.lic.length) return html`<span class="dim">no licenses</span>`;
  const active = m.lic.filter((l) => l.activated).length;
  return html`<span class="lic-list" title=${m.lic.map((l) => `${l.description} — ${l.method}, ${l.state}, ${l.start} → ${l.end}${l.includes.length ? ` (+ ${l.includes.map((i) => i.split('.').pop()).join(', ')})` : ''}`).join('\n')}>
    ${plural(m.lic.length, 'license')}${active ? html` · <span class="ok-text">${active} in use</span>` : ''}
    ${m.soonest ? html`<span class=${m.soonest.days <= 14 ? 'tag bad' : m.soonest.days <= SOON_DAYS ? 'tag warn' : 'dim'}>${m.soonest.days <= SOON_DAYS ? `expires ${fmtDate(m.soonest.end)}` : `to ${fmtDate(m.soonest.end)}`}</span>` : null}
  </span>`;
}

function SessionCell({ m }) {
  if (!m.li) return html`<span class="dim">—</span>`;
  const s0 = m.sessions[0];
  const auto = m.autologin && m.autologin.enabled;
  return html`<span>${s0 ? html`<b>${s0.user}</b> <span class=${s0.state === 'active' ? 'ok-text' : 'dim'}>${s0.state}</span>` : html`<span class="warn-text">nobody signed in</span>`}
    <span class="dim"> · auto-login ${auto ? 'on' : html`<span class="warn-text">off</span>`}</span></span>`;
}

function LastResult({ m, now }) {
  const r = m.last[m.last.length - 1];
  if (!r || now - r.at > 30 * 60 * 1000) return null;
  return html`<div class=${'lic-result ' + (r.ok ? 'ok' : 'bad')}><${Icon} name=${r.ok ? 'check' : 'alert'} />${ACTION_LABEL[r.action] || r.action}: ${r.message} <span class="dim">· ${ago(r.at, now)}</span></div>`;
}

export function LicensesView() {
  const s = farm.value;
  if (!s) return html`<div class="page"><${Empty}>Loading…<//></div>`;
  const now = s.now || Date.now();
  const all = model(s);
  const q = search.value.trim().toLowerCase();
  const f = FILTERS.find(([k]) => k === filter.value) || FILTERS[0];
  const rows = all.filter(f[2]).filter((m) => !q || m.n.hostname.toLowerCase().includes(q) || String(m.maxonAccount || '').toLowerCase().includes(q));
  const sel = all.filter((m) => selected.value.has(m.n.id));
  const toggle = (id) => { const n = new Set(selected.value); if (n.has(id)) n.delete(id); else n.add(id); selected.value = n; };
  const pending = all.filter((m) => !m.supported).length;

  return html`<div class="page stack licenses-page">
    <${PageHeader} title="Licenses" subtitle="Who is signed in where, what each machine holds, and what's about to run out.">
      <label class="search"><${Icon} name="search" /><input class="field" placeholder="Machine or account" value=${search.value} onInput=${(e) => { search.value = e.currentTarget.value; }} style="width:200px" /></label>
      <a class="btn" href="https://adminconsole.adobe.com" target="_blank" rel="noopener"><${Icon} name="external" />Adobe Admin Console</a>
      <a class="btn" href="https://my.maxon.net" target="_blank" rel="noopener"><${Icon} name="external" />Maxon account</a>
    </${PageHeader}>

    ${pending ? html`<div class="banner info"><${Icon} name="spinner" cls="spin" /><span class="grow">${plural(pending, 'machine')} ${pending === 1 ? "hasn't" : "haven't"} reported licenses yet — their agents update themselves to 2.37 within a few minutes.</span></div>` : null}

    <${Summary} rows=${all} now=${now} />

    <div class="filterbar">
      <div class="pills" role="tablist" aria-label="Filter machines">
        ${FILTERS.map(([k, label, fn]) => { const c = all.filter(fn).length; return html`<button key=${k} role="tab" aria-selected=${filter.value === k} class=${'pill' + (filter.value === k ? ' on' : '')} disabled=${k !== 'all' && !c} onClick=${() => { filter.value = filter.value === k ? 'all' : k; }}>${label}<span class="n">${c}</span></button>`; })}
      </div>
    </div>

    ${!rows.length ? html`<${Empty}>No machines match.<//>` : html`<div class="card table-wrap"><table class="table lic-table">
      <thead><tr>
        <th style="width:34px"><input type="checkbox" aria-label="Select all" checked=${rows.length && rows.every((m) => selected.value.has(m.n.id))}
          onChange=${(e) => { const n = new Set(selected.value); rows.forEach((m) => (e.currentTarget.checked ? n.add(m.n.id) : n.delete(m.n.id))); selected.value = n; }} /></th>
        <th>Machine</th><th>Signed in</th><th>Maxon account</th><th>Maxon licenses</th><th>After Effects</th><th></th>
      </tr></thead>
      <tbody>${rows.map((m) => html`<tr key=${m.n.id} class=${selected.value.has(m.n.id) ? 'selected' : ''}>
        <td><input type="checkbox" aria-label=${`Select ${m.n.hostname}`} checked=${selected.value.has(m.n.id)} onChange=${() => toggle(m.n.id)} /></td>
        <td class="nowrap"><span class="row" style="gap:8px;flex-wrap:nowrap"><${OsStatus} node=${m.n} /><b>${m.n.hostname}</b></span><${LastResult} m=${m} now=${now} /></td>
        <td><${SessionCell} m=${m} /></td>
        <td class="mono" style="font-size:.84rem">${m.maxonAccount || html`<span class="dim">${m.li && m.li.maxon ? 'not signed in' : '—'}</span>`}</td>
        <td><${LicenseCell} m=${m} now=${now} /></td>
        <td>${m.aeRenderOnly == null ? html`<span class="dim">—</span>` : m.aeRenderOnly
          ? html`<span class="ok-text" title="ae_render_only_node.txt is in this user's Documents — After Effects renders here without using a seat"><${Icon} name="check" /> render-only</span>`
          : html`<span class="warn-text" title="After Effects here needs a signed-in Adobe seat">uses a seat</span>`}</td>
        <td class="right"><button class="btn sm ghost icon" aria-label=${`Actions for ${m.n.hostname}`} onClick=${(e) => rowMenu(e, m)}><${Icon} name="more" /></button></td>
      </tr>`)}</tbody>
    </table></div>`}

    ${sel.length ? html`<div class="bulkbar" role="toolbar" aria-label="Actions for selected machines">
      <b>${plural(sel.length, 'machine')}</b>
      <button class="btn sm" onClick=${() => run(sel, 'maxon_refresh')}><${Icon} name="refresh" />Refresh Maxon</button>
      <button class="btn sm" onClick=${() => run(sel, 'ae_render_only_on')}><${Icon} name="film" />Render-only on</button>
      <button class="btn sm" onClick=${(e) => openMenu(e.currentTarget, [
        { label: 'Turn off render-only mode', icon: 'eyeOff', onSelect: () => confirmThen(sel, 'ae_render_only_off') },
        { label: 'Sign out of Maxon', icon: 'x', danger: true, onSelect: () => confirmThen(sel, 'maxon_logout') },
        { label: 'Log off disconnected sessions', icon: 'power', onSelect: () => confirmThen(sel.filter((m) => m.n.os === 'windows'), 'win_logoff_disconnected') },
      ])}><${Icon} name="more" />More</button>
      <button class="btn ghost sm icon" aria-label="Clear selection" onClick=${() => { selected.value = new Set(); }}><${Icon} name="close" /></button>
    </div>` : null}
  </div>`;
}
