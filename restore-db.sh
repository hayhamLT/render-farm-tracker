#!/bin/sh
# Restore the tracker database from a backup made by lib/backup.js.
#
#   ./restore-db.sh                 # restore the NEWEST backup
#   ./restore-db.sh <path-to.db>    # restore a specific snapshot
#
# Safe: it stops the server, keeps a copy of the current DB, swaps in the backup,
# clears the stale WAL/SHM, and restarts. Run it from the repo directory.
set -e
cd "$(dirname "$0")"

BACKUP_DIR="${TRACKER_BACKUP_DIR:-$HOME/tracker-backups}"
SRC="$1"
if [ -z "$SRC" ]; then
  SRC="$(ls -t "$BACKUP_DIR"/tracker-*.db 2>/dev/null | head -1)"
fi
if [ -z "$SRC" ] || [ ! -f "$SRC" ]; then
  echo "No backup found. Give a path, or check $BACKUP_DIR" >&2
  exit 1
fi

LABEL="gui/$(id -u)/com.tracker.server"
PLIST="$HOME/Library/LaunchAgents/com.tracker.server.plist"

echo "Restoring from: $SRC"
echo "1/4 stopping server…"
launchctl bootout "$LABEL" 2>/dev/null || true
sleep 1

echo "2/4 saving the current DB aside…"
[ -f tracker.db ] && cp tracker.db "tracker.db.pre-restore-$(date +%Y%m%d-%H%M%S)" || true

echo "3/4 swapping in the backup + clearing stale WAL/SHM…"
cp "$SRC" tracker.db
rm -f tracker.db-wal tracker.db-shm

echo "4/4 starting server…"
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl kickstart -k "$LABEL" 2>/dev/null || true

echo "Done. The server is restarting from the backup."
