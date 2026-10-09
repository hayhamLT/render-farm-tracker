'use strict';
// Every line the tracker prints (to logs/tracker.log, through Farmly.app's start script) starts with the
// local time in ISO 8601, e.g. "2026-10-09T12:41:02.117-07:00 Render Farm Update Tracker". Nothing else
// about the lines changes.
const util = require('node:util');

const pad = (n, w = 2) => String(n).padStart(w, '0');

function isoLocal(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
    + `${off >= 0 ? '+' : '-'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

// Prefix console.log/info/warn/error with the time. Safe to call twice.
function stampConsole(c = console, clock = () => new Date()) {
  if (c.__stamped) return c;
  for (const m of ['log', 'info', 'warn', 'error']) {
    const orig = c[m].bind(c);
    c[m] = (...args) => orig('%s %s', isoLocal(clock()), util.format(...args));
  }
  Object.defineProperty(c, '__stamped', { value: true });
  return c;
}

module.exports = { isoLocal, stampConsole };
