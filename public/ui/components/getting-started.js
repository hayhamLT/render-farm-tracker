// Adding a machine to the farm — the one thing someone needs on their first day here.
// Farmly installs this tracker's agent on a new machine (Fleet ▸ Add machine), with the machine's own
// key, in the same step as its own runner. The tracker hands out no installer, command or key itself
// any more, so this topic only says where to go.
import { html } from '../lib/html.js';
import { farm } from '../lib/store.js';
import { go } from '../lib/router.js';

export function GettingStarted() {
  const s = farm.value;
  if (!s) return null;
  return html`<div class="stack" style="gap:16px">
    <p style="margin:0">Add machines from <b>Farmly</b>: <b>Fleet ▸ Add machine</b>. Farmly's installer
      sets up this agent too, with the machine's own key, so installs run silently from the start.</p>
    <p class="dim" style="margin:0">The machine appears under <button class="linkish" onClick=${() => go('machines')}>Machines</button> within a minute of running it.</p>
  </div>`;
}
