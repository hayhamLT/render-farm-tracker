#!/bin/bash
# Elevate every macOS node at once: install the root LaunchDaemon agent via sudo.
# Reads the admin password from a file (NOT the command line / not echoed).
# Usage:  bash elevate_macs.sh /path/to/passwordfile
set -u
DC=/Applications/Thinkbox/Deadline10/Resources/deadlinecommand
SRV=http://10.10.10.96:4400
PWFILE="${1:-$HOME/mac_admin_pw.txt}"
[ -f "$PWFILE" ] || { echo "password file not found: $PWFILE"; exit 1; }
PW=$(tr -d '\r\n' < "$PWFILE")
CONTROLLER=$(hostname)

run_to(){ local s=$1; shift; "$@" & local p=$!; ( sleep "$s"; kill -9 "$p" 2>/dev/null ) & local w=$!; wait "$p" 2>/dev/null; kill "$w" 2>/dev/null; }

# Mac worker names from Deadline (Darwin only).
MACS=$("$DC" GetSlaveNames 2>/dev/null | tr -d '\r' | while read -r n; do
  probe=$(run_to 20 "$DC" RemoteControl "$n" Execute '/usr/bin/uname -s' 2>&1)
  echo "$probe" | grep -q Darwin && echo "$n"
done)

for n in $MACS; do
  # Skip the controller here; it's elevated locally below (avoids remoting to self).
  case "$(echo "$n" | tr '[:lower:]' '[:upper:]')" in MACBOOK-N29*) continue;; esac
  echo "== $n =="
  run_to 30 "$DC" RemoteControl "$n" Execute "/bin/bash -c \"curl -fsSL $SRV/setup.sh -o /tmp/trk_setup.sh\"" >/dev/null 2>&1
  # Feed the password to sudo via stdin (-S), prompt suppressed (-p '').
  r=$(run_to 120 "$DC" RemoteControl "$n" Execute "/bin/bash -c \"printf '%s\\n' '$PW' | /usr/bin/sudo -S -p '' /bin/bash /tmp/trk_setup.sh 2>&1\"" 2>&1)
  echo "$r" | grep -qi "installed as root" && echo "  OK (root daemon)" || echo "  FAIL: $(echo "$r" | grep -iE 'incorrect|sorry|error|password' | head -1)"
done

# Controller (this Mac) — elevate locally.
echo "== $CONTROLLER (controller, local) =="
curl -fsSL "$SRV/setup.sh" -o /tmp/trk_setup.sh 2>/dev/null
printf '%s\n' "$PW" | /usr/bin/sudo -S -p '' /bin/bash /tmp/trk_setup.sh 2>&1 | grep -qi "installed as root" && echo "  OK (root daemon)" || echo "  check /tmp/trk_setup.sh output"
rm -f /tmp/trk_setup.sh
echo "=== done — Macs elevated; they will reappear on the dashboard within a minute ==="
