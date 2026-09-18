// The farm: one dashboard, not three pages.
//
// Updates, machines and history were never separate subjects — they're the same farm, and
// splitting them meant finding that an app was behind on six machines, then leaving the page to
// ask whether those machines were healthy. Everything now stacks on one page: what the farm looks
// like, what needs a person, what's running, the apps, the machines, and the record at the bottom.
// Sections collapse and remember it, so the page is as long as you want it to be.
//
// The old addresses still work: #/machines and #/history scroll to their section (and #/machines/
// HOST opens that machine), so every link, bookmark and shortcut lands where it used to.
import { html } from '../lib/html.js';
import { useEffect } from 'preact/hooks';
import { farm } from '../lib/store.js';
import { route } from '../lib/router.js';
import { plural } from '../lib/format.js';
import { Icon } from '../components/common.js';
import { PageHeader } from '../components/page.js';
import { Section, revealSection, sectionOpen } from '../components/section.js';
import { FarmOverview, UpdatesSection, UpdatesActions, useAppModels, updatableApps, updatesCount } from './updates.js';
import { MachinesSection, MachinesActions, machinesSummary } from './machines.js';
import { HistorySection } from './history.js';
import { openRollout } from './deploy.js';

export function FarmView() {
  const s = farm.value;
  const models = useAppModels(s);
  const { name, params } = route.value;

  // Arriving on an old address (or a machine link) opens and scrolls to that part. Waits for the
  // farm data — until it lands there are no sections to scroll to.
  useEffect(() => {
    if (!s) return;
    if (name === 'machines') { sectionOpen('machines').value = true; if (!params[0]) revealSection('machines'); }
    if (name === 'history') revealSection('history');
  }, [name, params[0], !!s]);

  if (!s) return null;
  const available = updatableApps(models);
  const updates = updatesCount(models);
  const behind = new Set(available.flatMap((m) => m.behind.map((n) => n.id))).size;
  const failedDay = s.jobs.filter((j) => j.status === 'failed' && j.updated_at > Date.now() - 24 * 3600 * 1000).length;
  const offline = s.nodes.filter((n) => !n.online).length;

  return html`<div class="page farm-page">
    <${PageHeader} title="Farm"
      subtitle=${`${plural(s.nodes.length, 'machine')} · ${updates ? `${plural(updates, 'update')} for ${plural(behind, 'machine')}` : 'everything up to date'}${offline ? ` · ${offline} offline` : ''}`}>
      <button class="btn" onClick=${() => openRollout({})}><${Icon} name="package" />Install a specific version…</button>
    </${PageHeader}>

    <${FarmOverview} s=${s} models=${models} />

    <${Section} id="updates" icon="download" title="Updates" count=${updates || null} tone=${updates ? 'info' : ''}
      summary=${updates ? `${plural(available.filter((m) => m.behind.length).length, 'app')} behind` : 'every app current'}
      actions=${html`<${UpdatesActions} />`}>
      <${UpdatesSection} s=${s} models=${models} />
    </${Section}>

    <${Section} id="machines" icon="server" title="Machines" count=${s.nodes.length} tone=${offline ? 'bad' : ''}
      summary=${machinesSummary(s)} actions=${html`<${MachinesActions} />`}>
      <${MachinesSection} />
    </${Section}>

    <${Section} id="history" icon="activity" title="History" count=${failedDay || null} tone=${failedDay ? 'bad' : ''}
      summary=${failedDay ? `${plural(failedDay, 'install')} failed in the last 24 h` : 'installs, rollouts and events'}
      defaultOpen=${false}>
      <${HistorySection} />
    </${Section}>
  </div>`;
}
