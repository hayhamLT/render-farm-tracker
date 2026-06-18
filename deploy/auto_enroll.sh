#!/bin/bash
# Auto-discovery + auto-enrolment daemon (reconciliation loop).
#
# Desired state: every Deadline worker is enrolled in the tracker (and Macs are
# elevated if the admin password is available). Every cycle it diffs the Deadline
# worker list against the tracker's enrolled nodes and closes the gap. Any NEW
# machine added to the farm (Mac or Windows) appears on the dashboard within a
# few minutes — no manual step.
#
# Runs forever; installed as the LaunchAgent com.tracker.autoenroll.
set -u
DC=/Applications/Thinkbox/Deadline10/Resources/deadlinecommand
SRV=http://10.10.10.96:4400
PWFILE="$HOME/mac_admin_pw.txt"     # present ⇒ new Macs are auto-elevated (root daemon)
INTERVAL=300                         # seconds between reconciliations
LOG="$HOME/tracker/autoenroll.log"
mkdir -p "$HOME/tracker"

run_to(){ local s=$1; shift; "$@" & local p=$!; ( sleep "$s"; kill -9 "$p" 2>/dev/null ) & local w=$!; wait "$p" 2>/dev/null; kill "$w" 2>/dev/null; }
log(){ echo "$(date '+%H:%M:%S') $*" >> "$LOG"; }

norm(){ echo "$1" | sed 's/\..*//' | tr '[:lower:]' '[:upper:]'; }

reconcile(){
  # Hostnames already enrolled (normalised, uppercase, no domain suffix).
  local enrolled
  enrolled=$(curl -sf "$SRV/api/state" 2>/dev/null | python3 -c \
    "import sys,json
try: d=json.load(sys.stdin)
except: sys.exit()
print(' '.join(n['hostname'].split('.')[0].upper() for n in d['nodes']))" 2>/dev/null)
  [ -z "$enrolled" ] && { log "tracker not reachable, skip"; return; }

  for n in $("$DC" GetSlaveNames 2>/dev/null | tr -d '\r'); do
    local nu; nu=$(norm "$n")
    echo " $enrolled " | grep -q " $nu " && continue          # already on the dashboard
    # Reachable via Deadline launcher?
    local probe; probe=$(run_to 20 "$DC" RemoteControl "$n" Execute '/usr/bin/uname -s' 2>&1)
    echo "$probe" | grep -qi "Connection Accepted" || continue # launcher not up yet — try next cycle

    if echo "$probe" | grep -q Darwin; then
      local elevated=0
      if [ -f "$PWFILE" ]; then
        # New Mac + admin password → install the ELEVATED root daemon. The pipe to
        # sudo lives inside mac_elevate.sh, so Deadline never sees it.
        local pw; pw=$(tr -d '\r\n' < "$PWFILE")
        run_to 25 "$DC" RemoteControl "$n" Execute "curl -fsSL $SRV/mac_elevate.sh -o /tmp/me.sh" >/dev/null 2>&1
        local r; r=$(run_to 150 "$DC" RemoteControl "$n" Execute "/bin/bash /tmp/me.sh '$pw'" 2>&1)
        echo "$r" | grep -qi "installed as root" && { log "ENROLLED+ELEVATED (mac) $n"; elevated=1; } || log "mac elevate fail (wrong pw?) $n — falling back to monitor"
      fi
      if [ "$elevated" = 0 ]; then
        # No password / elevation failed → at least enrol the monitoring agent.
        run_to 30 "$DC" RemoteControl "$n" Execute "curl -fsSL $SRV/enroll.sh -o /tmp/tracker_enroll.sh" >/dev/null 2>&1
        run_to 60 "$DC" RemoteControl "$n" Execute 'bash /tmp/tracker_enroll.sh' >/dev/null 2>&1
        log "ENROLLED (mac, unelevated) $n"
      fi
    else
      # New Windows node → basic monitoring agent (install-elevation is via GPO/manual).
      run_to 30 "$DC" RemoteControl "$n" Execute "curl.exe -fsSL $SRV/enroll.ps1 -o C:\\Windows\\Temp\\tracker_enroll.ps1" >/dev/null 2>&1
      local r; r=$(run_to 60 "$DC" RemoteControl "$n" Execute 'powershell -ExecutionPolicy Bypass -File C:\Windows\Temp\tracker_enroll.ps1' 2>&1)
      echo "$r" | grep -q "tracker-agent installed" && log "ENROLLED (win) $n" || log "win enroll fail $n"
    fi
  done
}

log "auto-enroll daemon started (interval ${INTERVAL}s)"
while true; do reconcile; sleep "$INTERVAL"; done
