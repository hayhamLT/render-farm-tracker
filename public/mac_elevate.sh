#!/bin/bash
# Elevate a macOS node to the root LaunchDaemon agent.
# Usage:  bash mac_elevate.sh '<admin-password>'
# The pipe to sudo lives INSIDE this file (bash-internal), so Deadline's
# command parser never sees a pipe to split on.
PW="$1"
# Deadline can pass the literal surrounding quotes — strip them.
PW="${PW#\'}"; PW="${PW%\'}"
PW="${PW#\"}"; PW="${PW%\"}"
[ -z "$PW" ] && { echo "no password given"; exit 2; }
curl -fsSL http://10.10.10.96:4400/setup.sh -o /tmp/trk_setup.sh || { echo "download failed"; exit 3; }
printf '%s\n' "$PW" | /usr/bin/sudo -S -p '' /bin/bash /tmp/trk_setup.sh
RC=$?
rm -f /tmp/trk_setup.sh
exit $RC
