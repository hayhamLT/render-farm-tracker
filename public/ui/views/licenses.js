// Licenses — your Maxon seats and who holds them, who is signed in where, and what needs you.
//
// Organised around how licensing actually works on this farm: a Maxon account owns a POOL of
// seats (Maxon One, Redshift, Team Render, Commandline…) that every signed-in machine can see;
// a machine "holds" a seat while it's activated there. So seats are shown once, grouped by
// product, with who holds each — and machines are one line each, coloured only where something
// is off. Moving a seat is release-then-assign, done by the server in that order.
//
// Everything is read by the agent inside the signed-in user's own session (Maxon and Adobe
// sign-ins belong to the user) every 10 minutes, and straight after an action. The tracker
// never stores or sends passwords; a Maxon login token lives in server memory only until the
// machine collects it. Adobe seats for people are assigned in Adobe's Admin Console — linked.
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
const SOON = 45;                                   // days: "ends soon"
const view = pref('licenses.view', 'seats');       // seats | machines
const search = signal('');

const ACTION = {
  maxon_refresh: 'Refresh Maxon account', maxon_logout: 'Sign out of Maxon', maxon_login_token: 'Sign in to Maxon',
  maxon_release: 'Release seat', maxon_assign: 'Take seat', maxon_lock: 'Lock seat here', maxon_unlock: 'Unlock seat',
  maxon_block: 'Stop auto-activating here', maxon_unblock: 'Allow auto-activating here',
  ae_render_only_on: 'Make render-only', ae_render_only_off: 'Turn off render-only', win_logoff_disconnected: 'Log off disconnected sessions',
};

const daysLeft = (end, now) => Math.ceil((new Date(end + 'T23:59:59').getTime() - now) / DAY);
const fmtDate = (d) => new Date(d + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const atLeast = (v, min) => !!v && v.localeCompare(min, undefined, { numeric: true }) >= 0;

// ------------------------------------------------------------------ model
function build(s) {
  const now = s.now || Date.now();
  const machines = s.nodes.map((n) => {
    const li = parseJSON(n.license_info) || null;
    const mx = li && li.maxon;
    const lic = (mx && mx.licenses) || [];
    const sessions = (li && li.sessions) || [];
    return {
      n, li, lic, now,
      last: (parseJSON(n.license_action) || []).slice(-1)[0] || null,
      account: (mx && mx.user && mx.user.account) || null,
      hasMaxon: !!mx,
      held: lic.filter((l) => l.activated),
      renderOnly: li && li.adobe ? li.adobe.renderOnly : null,
      adobeIds: (li && li.adobe && li.adobe.accounts) || [],
      session: sessions[0] || null,
      disconnected: sessions.filter((x) => x.state === 'disconnected'),
      autologin: li && li.autologin ? li.autologin.enabled : null,
      canAct: n.online && atLeast(n.agent_version, '2.37.0'),
      canSeat: n.online && atLeast(n.agent_version, '2.38.0'),
    };
  });
  // The company account = the one most machines use; anything else is worth a look.
  const counts = new Map();
  for (const m of machines) if (m.account) counts.set(m.account, (counts.get(m.account) || 0) + 1);
  const company = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  // The account's license pools, as the farm's machines report them. Each entry (Maxon's rowId)
  // is one POOL — Maxon One "2/2", Redshift "4/4", Team Render Client "0/10" — and every tracked
  // machine that has it activated is one of its holders. Pool SIZES and devices without the
  // tracker exist only on Maxon's servers, so nothing here invents a "free" seat.
  const entries = new Map();
  for (const m of machines.filter((x) => x.account === company)) {
    for (const l of m.lic) {
      const k = l.rowId != null ? `r${l.rowId}` : `${l.id}|${l.start}|${l.end}`;
      const e = entries.get(k) || { key: k, ...l, holders: [] };
      if (l.activated && !e.holders.includes(m)) e.holders.push(m);
      entries.set(k, e);
    }
  }
  // Floating = checked out on demand, not assigned: the Maxon App files "Red Giant Complete
  // (render only)" under Floating Licenses even though mx1 calls its method "subscription".
  const pool = [...entries.values()].map((e) => ({ ...e, floating: /float/i.test(e.method || '') || /renderonly/i.test(e.id || ''), days: e.end && !e.end.startsWith('2099') ? daysLeft(e.end, now) : null }));
  const groups = new Map();
  for (const e of pool) {
    const g = groups.get(e.name) || { name: e.name, entries: [] };
    g.entries.push(e); groups.set(e.name, g);
  }
  for (const g of groups.values()) g.entries.sort((a, b) => (a.end || '').localeCompare(b.end || ''));
  const held = (g) => g.entries.reduce((c, e) => c + e.holders.length, 0);
  return { machines, company, pool, groups: [...groups.values()].sort((a, b) => held(b) - held(a) || a.name.localeCompare(b.name)), now };
}

// ------------------------------------------------------------------ actions
async function act(m, action, extra = {}) {
  try {
    await post(`/api/nodes/${m.n.id}/license`, { action, ...extra });
    toast(`${ACTION[action]} — sent to ${m.n.hostname}. The result shows here within a minute.`, 'success', 6000);
  } catch (e) { toast(`${m.n.hostname}: ${e.message}`, 'error', 8000); }
  refresh();
}
const seatArg = (seat) => ({ license: { name: seat.id, version: seat.version || '' } });

async function releaseSeat(seat, m) {
  if (!await confirm(`Release the ${seat.name} seat on ${m.n.hostname}? It becomes free for any other machine — anything on ${m.n.hostname} that needs it stops working until it takes a seat again.`,
    { title: 'Release seat', confirmLabel: 'Release', danger: true })) return;
  act(m, 'maxon_release', seatArg(seat));
}

function MachinePicker({ seat, from, model, close }) {
  const [q, setQ] = useState('');
  const options = model.machines
    .filter((m) => m.account === model.company && m !== from && !seat.holders.includes(m))
    .filter((m) => !q || m.n.hostname.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (b.canSeat - a.canSeat) || a.n.hostname.localeCompare(b.n.hostname));
  const pick = async (m) => {
    try {
      const r = await post('/api/licenses/move', { name: seat.id, version: seat.version || '', from: from ? from.n.id : null, to: m.n.id });
      toast(`${seat.name}: ${r.steps.join(', ')}.`, 'success', 7000);
      refresh(); close(true);
    } catch (e) { toast(e.message, 'error', 8000); }
  };
  return html`<div class="stack" style="gap:12px">
    <p class="dim" style="margin:0">${from ? html`Released on <b>${from.n.hostname}</b> first; the machine you pick takes it once that's confirmed.` : html`The machine you pick takes a seat from this license. If every seat is already assigned (the Maxon App shows how many there are), Maxon refuses and you'll see why here.`}</p>
    <label class="search"><${Icon} name="search" /><input class="field" autofocus placeholder="Find a machine" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} /></label>
    <div class="lic-pick">${options.map((m) => html`<button key=${m.n.id} class="lic-pick-row" disabled=${!m.canSeat} onClick=${() => pick(m)}>
      <${OsStatus} node=${m.n} /><b>${m.n.hostname}</b>
      <span class="grow"></span>
      <span class="dim">${!m.n.online ? 'offline' : !m.canSeat ? 'agent updating' : m.held.length ? `holds ${[...new Set(m.held.map((l) => l.name))].join(', ')}` : 'holds nothing'}</span>
    </button>`)}</div>
  </div>`;
}
const openPicker = (seat, model, from = null) => openSheet((close) => html`<${MachinePicker} seat=${seat} from=${from} model=${model} close=${close} />`,
  { title: from ? `Move ${seat.name} from ${from.n.hostname}` : `Give ${seat.name} to a machine`, subtitle: seat.end && !seat.end.startsWith('2099') ? `License valid until ${fmtDate(seat.end)}` : '', width: 520 });

function TokenSheet({ m, close }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try { await post(`/api/nodes/${m.n.id}/license`, { action: 'maxon_login_token', token: token.trim() }); toast(`Sign-in sent to ${m.n.hostname}.`, 'success'); refresh(); close(true); }
    catch (e) { toast(e.message, 'error', 8000); setBusy(false); }
  };
  return html`<div class="form">
    <p style="margin:0">Paste a Maxon login token for <b>${m.n.hostname}</b> — it signs the machine's user in without a password.</p>
    <label>Login token<input class="field mono" type="password" autocomplete="off" value=${token} onInput=${(e) => setToken(e.currentTarget.value)} /></label>
    <p class="dim" style="margin:0;font-size:.82rem">Never stored: held in memory until ${m.n.hostname} collects it (within a minute), then forgotten. Not written to the database or the log.</p>
    <div class="row" style="justify-content:flex-end;gap:8px">
      <button class="btn ghost" onClick=${() => close(null)}>Cancel</button>
      <button class="btn primary" disabled=${busy || token.trim().length < 8} onClick=${send}><${Icon} name=${busy ? 'spinner' : 'key'} cls=${busy ? 'spin' : ''} />Sign in</button>
    </div>
  </div>`;
}

function machineMenu(e, m, model) {
  const takeable = model.pool.filter((e) => !e.floating && !e.holders.includes(m));
  openMenu(e.currentTarget, [
    { label: 'Take a seat…', icon: 'plus', disabled: !m.canSeat || m.account !== model.company || !takeable.length, onSelect: () => openMenu(e.currentTarget,
      takeable.map((x) => ({ label: `${x.name}${x.end && !x.end.startsWith('2099') ? ` · until ${fmtDate(x.end)}` : ''}`, icon: 'key', onSelect: () => act(m, 'maxon_assign', seatArg(x)) }))) },
    ...m.held.map((l) => ({ label: `Release ${l.name}`, icon: 'x', disabled: !m.canSeat, onSelect: () => releaseSeat(l, m) })),
    '-',
    { label: 'Refresh Maxon account', icon: 'refresh', disabled: !m.canAct, onSelect: () => act(m, 'maxon_refresh') },
    { label: 'Sign in with a token…', icon: 'key', disabled: !m.canAct, onSelect: () => openSheet((close) => html`<${TokenSheet} m=${m} close=${close} />`, { title: 'Sign in to Maxon', width: 480 }) },
    { label: 'Sign out of Maxon', icon: 'x', danger: true, disabled: !m.canAct || !m.account, onSelect: async () => {
      if (await confirm(`Sign ${m.n.hostname} out of Maxon? Cinema 4D and Redshift there stop rendering until someone signs back in.`, { title: 'Sign out of Maxon', confirmLabel: 'Sign out', danger: true })) act(m, 'maxon_logout');
    } },
    '-',
    m.renderOnly
      ? { label: 'Turn off render-only (After Effects)', icon: 'eyeOff', disabled: !m.canAct, onSelect: async () => {
        if (await confirm(`After Effects on ${m.n.hostname} will need a signed-in Adobe seat again.`, { title: 'Turn off render-only', confirmLabel: 'Turn off', danger: true })) act(m, 'ae_render_only_off');
      } }
      : { label: 'Make render-only (After Effects)', icon: 'film', disabled: !m.canAct, onSelect: async () => {
        if (await confirm(`Only for machines nobody works on in After Effects. Render-only lets ${m.n.hostname} render After Effects jobs without using an Adobe seat — but After Effects there will no longer open its interface.`,
          { title: 'Make render-only', confirmLabel: 'Make render-only' })) act(m, 'ae_render_only_on');
      } },
    m.n.os === 'windows' ? { label: 'Log off disconnected sessions', icon: 'power', disabled: !m.canAct || !m.disconnected.length, onSelect: async () => {
      if (await confirm(`Log off disconnected Windows sessions on ${m.n.hostname}? Only sessions nobody is connected to — anything left open in them closes.`, { title: 'Log off', confirmLabel: 'Log off', danger: true })) act(m, 'win_logoff_disconnected');
    } } : null,
    '-',
    { label: 'Open machine', icon: 'server', onSelect: () => go('machines', m.n.hostname) },
  ].filter(Boolean));
}

// ------------------------------------------------------------------ attention
function Attention({ model }) {
  const { machines, company, pool, now } = model;
  const reported = machines.filter((m) => m.li);
  const items = [];
  const ending = pool.filter((e) => e.days != null && e.days <= SOON);
  if (ending.length) {
    const first = ending.map((e) => e.end).sort()[0];
    items.push({ tone: ending.some((e) => e.days <= 14) ? 'bad' : 'warn', icon: 'clock',
      text: `${plural(ending.length, 'Maxon license')} end${ending.length === 1 ? 's' : ''} ${fmtDate(first)} — in ${plural(daysLeft(first, now), 'day')}`,
      detail: `${[...new Set(ending.map((e) => e.name))].join(', ')} — unless they renew, every seat on them stops`, link: ['Maxon account', 'https://my.maxon.net'] });
  }
  const others = reported.filter((m) => m.account && m.account !== company);
  if (others.length) items.push({ tone: 'warn', icon: 'user', text: `${plural(others.length, 'machine')} signed in with a different Maxon account`,
    detail: others.map((m) => `${m.n.hostname} (${m.account})`).join(', ') });
  const noMaxon = reported.filter((m) => m.hasMaxon && !m.account);
  if (noMaxon.length) items.push({ tone: 'warn', icon: 'key', text: `${plural(noMaxon.length, 'machine')} not signed in to Maxon`, detail: noMaxon.map((m) => m.n.hostname).join(', ') });
  const seat = reported.filter((m) => m.renderOnly === false);
  // Deliberately no "make them all render-only" button: render-only stops After Effects
  // opening its interface, so on a machine someone works on it would lock them out.
  if (seat.length) items.push({ tone: 'info', icon: 'film', text: `After Effects runs on an Adobe seat on ${plural(seat.length, 'machine')}`,
    detail: `Pure render nodes don't need one — switch those to render-only from their ⋯ menu in Machines. ${seat.map((m) => m.n.hostname).join(', ')}` });
  const noAuto = reported.filter((m) => m.autologin === false);
  if (noAuto.length) items.push({ tone: 'warn', icon: 'power', text: `Auto-login is off on ${plural(noAuto.length, 'machine')}`,
    detail: `${noAuto.map((m) => m.n.hostname).join(', ')} — after a reboot nothing renders until someone signs in` });
  if (!items.length) return null;
  return html`<section class="card lic-attn">${items.map((it) => html`<div key=${it.text} class=${'lic-attn-row ' + it.tone}>
    <span class="lic-attn-icon"><${Icon} name=${it.icon} /></span>
    <div class="grow"><b>${it.text}</b><span class="dim">${it.detail}</span></div>
    ${it.action ? html`<button class="btn sm" onClick=${it.action[1]}>${it.action[0]}</button>` : null}
    ${it.link ? html`<a class="btn sm ghost" href=${it.link[1]} target="_blank" rel="noopener"><${Icon} name="external" />${it.link[0]}</a>` : null}
  </div>`)}</section>`;
}

// ------------------------------------------------------------------ seats view
function HolderChip({ e, m, model }) {
  return html`<span class="lic-chip">
    <${OsStatus} node=${m.n} /><b>${m.n.hostname}</b>
    <button class="lic-chip-more" aria-label=${`${e.name} on ${m.n.hostname}`} disabled=${!m.canSeat} onClick=${(ev) => openMenu(ev.currentTarget, [
      { label: 'Move to another machine…', icon: 'send', onSelect: () => openPicker(e, model, m) },
      { label: `Release from ${m.n.hostname}`, icon: 'x', danger: true, onSelect: () => releaseSeat(e, m) },
      '-',
      { label: `Lock to ${m.n.hostname}`, icon: 'shieldOk', onSelect: () => act(m, 'maxon_lock', seatArg(e)) },
      { label: 'Unlock', icon: 'shieldOff', onSelect: () => act(m, 'maxon_unlock', seatArg(e)) },
      { label: `Don't auto-activate on ${m.n.hostname}`, icon: 'stop', onSelect: () => act(m, 'maxon_block', seatArg(e)) },
      { label: 'Allow auto-activation again', icon: 'play', onSelect: () => act(m, 'maxon_unblock', seatArg(e)) },
    ])}><${Icon} name="chevronDown" /></button>
  </span>`;
}

function SeatsView({ model, q }) {
  if (!model.company) return html`<${Empty}>No machine has reported a Maxon sign-in yet.<//>`;
  const tracked = model.machines.filter((m) => m.account === model.company).length;
  const groups = model.groups
    .map((g) => ({ ...g, entries: g.entries.filter((e) => !q || g.name.toLowerCase().includes(q) || e.holders.some((m) => m.n.hostname.toLowerCase().includes(q))) }))
    .filter((g) => g.entries.length);
  return html`<div class="stack" style="gap:12px">
    <div class="lic-account"><${Icon} name="key" /><b class="mono">${model.company}</b>
      <span class="dim">${plural(model.pool.length, 'license')} · signed in on ${plural(tracked, 'machine')}</span>
      <span class="grow"></span>
      <span class="dim lic-note" title="mx1 on each machine only knows what that machine holds">Seat totals and devices without the tracker are in the <a href="https://my.maxon.net" target="_blank" rel="noopener">Maxon App</a></span></div>
    ${groups.map((g) => html`<section key=${g.name} class="card lic-group">
      <header><b>${g.name}</b><span class="dim">${[...new Set(g.entries.map((e) => e.method))].join(' · ')}</span><span class="grow"></span>
        <span class="dim nowrap">${plural(g.entries.reduce((c, e) => c + e.holders.length, 0), 'tracked machine')} holding</span></header>
      ${g.entries.map((e) => html`<div key=${e.key} class="lic-seat">
        <span class=${'lic-ends ' + (e.days != null && e.days <= 14 ? 'bad' : e.days != null && e.days <= SOON ? 'warn' : '')}>
          ${!e.end ? '—' : e.end.startsWith('2099') ? 'Perpetual' : `Until ${fmtDate(e.end)}`}${e.days != null && e.days <= SOON ? html` <small>· ${plural(e.days, 'day')}</small>` : null}</span>
        <span class="lic-holders">${e.holders.length ? e.holders.map((m) => html`<${HolderChip} key=${m.n.id} e=${e} m=${m} model=${model} />`)
          : html`<span class="dim">${e.floating ? 'Floating — taken automatically while a render needs it' : 'Not held by any tracked machine'}</span>`}</span>
        ${e.floating ? null : html`<button class="btn sm" onClick=${() => openPicker(e, model)}><${Icon} name="plus" />Give to…</button>`}
      </div>`)}
    </section>`)}
    ${!groups.length ? html`<${Empty}>No licenses match.<//>` : null}
  </div>`;
}

// ------------------------------------------------------------------ machines view
function MachinesView({ model, q }) {
  const rows = model.machines.filter((m) => !q || m.n.hostname.toLowerCase().includes(q) || String(m.account || '').toLowerCase().includes(q));
  return html`<div class="card table-wrap"><table class="table lic-table">
    <thead><tr><th>Machine</th><th>Signed in</th><th>Maxon</th><th>Holding</th><th>After Effects</th><th></th></tr></thead>
    <tbody>${rows.map((m) => html`<tr key=${m.n.id}>
      <td class="nowrap"><span class="row" style="gap:8px;flex-wrap:nowrap"><${OsStatus} node=${m.n} /><b>${m.n.hostname}</b></span>
        ${m.last && model.now - m.last.at < 30 * 60 * 1000 ? html`<div class=${'lic-result ' + (m.last.ok ? 'ok' : 'bad')}><${Icon} name=${m.last.ok ? 'check' : 'alert'} />${m.last.message}<span class="dim"> · ${ago(m.last.at, model.now)}</span></div>` : null}</td>
      <td class="nowrap">${!m.li ? html`<span class="dim">${atLeast(m.n.agent_version, '2.37.0') ? 'reporting soon' : 'agent updating'}</span>`
        : m.session ? html`<span class=${'lic-dot ' + (m.session.state === 'active' ? 'on' : '')}></span>${m.session.user}<span class="dim"> · ${m.session.state}</span>`
        : html`<span class="warn-text">nobody</span>`}
        ${m.autologin === false ? html` <span class="tag warn" title="After a reboot nothing renders until someone signs in">no auto-login</span>` : null}</td>
      <td class="nowrap">${!m.li ? null : !m.hasMaxon ? html`<span class="dim">not installed</span>`
        : !m.account ? html`<span class="warn-text">not signed in</span>`
        : m.account === model.company ? html`<span class="dim">company account</span>`
        : html`<span class="warn-text mono" title="Not the account the rest of the farm uses">${m.account}</span>`}</td>
      <td>${m.held.length ? [...new Set(m.held.map((l) => l.name))].map((nm) => html`<span key=${nm} class="tag">${nm}</span> `) : html`<span class="dim">—</span>`}</td>
      <td class="nowrap">${m.renderOnly == null ? html`<span class="dim">—</span>` : m.renderOnly ? html`<span class="dim">render-only</span>` : html`<span class="warn-text">uses a seat</span>`}</td>
      <td class="right"><button class="btn sm ghost icon" aria-label=${`Actions for ${m.n.hostname}`} onClick=${(e) => machineMenu(e, m, model)}><${Icon} name="more" /></button></td>
    </tr>`)}</tbody>
  </table></div>`;
}

// ------------------------------------------------------------------ page
export function LicensesView() {
  const s = farm.value;
  if (!s) return html`<div class="page"><${Empty}>Loading…<//></div>`;
  const model = build(s);
  const q = search.value.trim().toLowerCase();
  const waiting = model.machines.filter((m) => !m.li).length;
  return html`<div class="page stack licenses-page">
    <${PageHeader} title="Licenses" subtitle="Your Maxon seats and who holds them, who is signed in where, and what needs you.">
      <a class="btn" href="https://my.maxon.net" target="_blank" rel="noopener"><${Icon} name="external" />Maxon account</a>
      <a class="btn" href="https://adminconsole.adobe.com" target="_blank" rel="noopener"><${Icon} name="external" />Adobe Admin Console</a>
    </${PageHeader}>
    <${Attention} model=${model} />
    <div class="row lic-bar">
      <div class="seg" role="tablist" aria-label="View">
        ${[['seats', 'Maxon seats'], ['machines', 'Machines']].map(([k, l]) => html`<button key=${k} role="tab" aria-selected=${view.value === k} class=${view.value === k ? 'on' : ''} onClick=${() => { view.value = k; }}>${l}</button>`)}
      </div>
      <span class="grow"></span>
      ${waiting ? html`<span class="dim" style="font-size:.84rem">${plural(waiting, 'machine')} still reporting…</span>` : null}
      <label class="search"><${Icon} name="search" /><input class="field" placeholder=${view.value === 'seats' ? 'Product or machine' : 'Machine or account'} value=${search.value} onInput=${(e) => { search.value = e.currentTarget.value; }} style="width:220px" /></label>
    </div>
    ${view.value === 'seats' ? html`<${SeatsView} model=${model} q=${q} />` : html`<${MachinesView} model=${model} q=${q} />`}
  </div>`;
}
