#!/bin/bash
# Watch a list of nodes and enrol each one the moment it comes back online.
# Emits one line per node when it succeeds, then exits when all are done.
DC=/Applications/Thinkbox/Deadline10/Resources/deadlinecommand
SRV=http://10.10.10.96:4400
NODES=("AVA-01" "MACSTUDIO-N05" "MARS-05")

run_to() { local s=$1; shift; "$@" & local p=$!; ( sleep "$s"; kill -9 "$p" 2>/dev/null ) & local w=$!; wait "$p" 2>/dev/null; local rc=$?; kill "$w" 2>/dev/null; return $rc; }

enroll_one() {
  local n="$1" probe r
  probe=$(run_to 20 "$DC" RemoteControl "$n" Execute '/usr/bin/uname -s' 2>&1)
  echo "$probe" | grep -qi "Connection Accepted" || return 1   # not reachable yet
  if echo "$probe" | grep -q Darwin; then
    run_to 30 "$DC" RemoteControl "$n" Execute "curl -fsSL $SRV/enroll.sh -o /tmp/tracker_enroll.sh" >/dev/null 2>&1
    r=$(run_to 60 "$DC" RemoteControl "$n" Execute 'bash /tmp/tracker_enroll.sh' 2>&1)
  else
    run_to 30 "$DC" RemoteControl "$n" Execute "curl.exe -fsSL $SRV/enroll.ps1 -o C:\\Windows\\Temp\\tracker_enroll.ps1" >/dev/null 2>&1
    r=$(run_to 60 "$DC" RemoteControl "$n" Execute 'powershell -ExecutionPolicy Bypass -File C:\Windows\Temp\tracker_enroll.ps1' 2>&1)
  fi
  echo "$r" | grep -q "tracker-agent installed"
}

remaining=("${NODES[@]}")
for round in $(seq 1 120); do      # up to ~60 min (30s/round)
  still=()
  for n in "${remaining[@]}"; do
    if enroll_one "$n"; then echo "ENROLLED $n"; else still+=("$n"); fi
  done
  remaining=("${still[@]}")
  [ ${#remaining[@]} -eq 0 ] && { echo "ALL DONE"; exit 0; }
  sleep 30
done
echo "TIMEOUT still pending: ${remaining[*]}"
