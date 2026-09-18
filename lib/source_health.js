'use strict';
// Did each version source actually answer? The checks used to swallow every failure, so
// "Maxon redesigned the page" and "no new version today" looked exactly the same — the farm
// would quietly stop getting updates while everything read as current. Every source now
// records whether it produced a version, and since when it last did (kept in the database so a
// restart doesn't forget a source that's been broken for days).
let db = null;

function init(database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS version_sources (
    key TEXT PRIMARY KEY, label TEXT, ok INTEGER, ok_at INTEGER, last_at INTEGER, error TEXT, version TEXT)`);
}

// key = the app's product key; ok = the source produced a version this time.
function record(key, label, ok, detail) {
  if (!db) return;
  const now = Date.now();
  const prev = db.prepare('SELECT ok_at FROM version_sources WHERE key = ?').get(key);
  db.prepare(`INSERT OR REPLACE INTO version_sources (key, label, ok, ok_at, last_at, error, version)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(key, label, ok ? 1 : 0, ok ? now : (prev ? prev.ok_at : null), now,
      ok ? null : String(detail || 'no version found').slice(0, 300), ok ? String(detail || '') : null);
}

function all() {
  return db ? db.prepare('SELECT * FROM version_sources ORDER BY key').all() : [];
}

module.exports = { init, record, all };
