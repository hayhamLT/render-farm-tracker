// App-wide UI services: toasts, confirmation dialogs, custom dialogs, popover menus, and
// preferences that survive a reload.
import { signal } from '@preact/signals-core';

// ---- toasts ----
export const toasts = signal([]);
let toastSeq = 0;
export function toast(message, type = 'info', ms = 5000) {
  const id = ++toastSeq;
  toasts.value = [...toasts.value, { id, message, type }];
  if (ms) setTimeout(() => dismissToast(id), ms);
  return id;
}
export const dismissToast = (id) => { toasts.value = toasts.value.filter((t) => t.id !== id); };

// ---- dialogs ----
// One modal at a time. `dialog.value = { kind, ...props, resolve }` — rendered by <DialogHost/>.
export const dialog = signal(null);

// Confirm: resolves true/false. Enter confirms, Esc / backdrop cancels.
export function confirm(message, { title = 'Are you sure?', confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false, details = null } = {}) {
  return new Promise((resolve) => {
    dialog.value = { kind: 'confirm', title, message, details, confirmLabel, cancelLabel, danger,
      resolve: (v) => { dialog.value = null; resolve(v); } };
  });
}

// Custom dialog: `render(close)` returns the body; resolves with whatever close() is called with.
export function openDialog(render, { title, wide = false } = {}) {
  return new Promise((resolve) => {
    dialog.value = { kind: 'custom', title, wide, render, resolve: (v) => { dialog.value = null; resolve(v); } };
  });
}

// ---- menus ----
// A popover anchored to an element: menu.value = { x, y, items:[{label, icon, danger, disabled, onSelect}|'-'] }
export const menu = signal(null);
export function openMenu(anchor, items) {
  const r = anchor.getBoundingClientRect();
  menu.value = { right: Math.max(8, window.innerWidth - r.right), top: r.bottom + 4, bottomAnchor: r.top, items };
}
export const closeMenu = () => { menu.value = null; };

// ---- preferences (per browser; never required for correctness) ----
export function pref(key, initial) {
  let start = initial;
  try {
    const raw = localStorage.getItem('rft.' + key);
    if (raw != null) start = JSON.parse(raw);
  } catch { /* private window / blocked storage — use the default */ }
  const s = signal(start);
  s.subscribe((v) => { try { localStorage.setItem('rft.' + key, JSON.stringify(v)); } catch { /* ignore */ } });
  return s;
}

// ---- keyboard ----
export const isTyping = (e) => {
  const t = e.target;
  return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
};
