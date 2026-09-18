// Page header: title, one-line summary, and the page's main actions.
import { html } from '../lib/html.js';

export function PageHeader({ title, subtitle, children }) {
  return html`<header class="page-header">
    <div><h1>${title}</h1>${subtitle && html`<p>${subtitle}</p>`}</div>
    ${children && html`<div class="actions">${children}</div>`}
  </header>`;
}
