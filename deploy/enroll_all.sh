#!/bin/bash
# Parallel push-enrol of every Deadline worker. Each node runs concurrently with
# a self-timeout so offline/unreachable workers can't stall the batch.
DC=/Applications/Thinkbox/Deadline10/Resources/deadlinecommand
SRV=http://10.10.10.96:4400
OUT=/tmp/tracker_enroll_results
: > "$OUT"

# run_to <seconds> <cmd...> : run with a hard timeout, no coreutils needed.
run_to() {
  local secs=$1; shift
  "$@" & local pid=$!
  ( sleep "$secs"; kill -9 "$pid" 2>/dev/null ) & local w=$!
  wait "$pid" 2>/dev/null; local rc=$?
  kill "$w" 2>/dev/null
  return $rc
}

enroll_one() {
  local n="$1"
  case "$n" in MACBOOK-N29*) echo "$n SKIP (controller)" >> "$OUT"; return;; esac
  local probe
  probe=$(run_to 40 "$DC" RemoteControl "$n" Execute '/usr/bin/uname -s' 2>&1)
  if [ -z "$probe" ]; then echo "$n FAIL: unreachable (timeout)" >> "$OUT"; return; fi
  local r
  if echo "$probe" | grep -q Darwin; then
    run_to 40 "$DC" RemoteControl "$n" Execute "curl -fsSL $SRV/enroll.sh -o /tmp/tracker_enroll.sh" >/dev/null 2>&1
    r=$(run_to 60 "$DC" RemoteControl "$n" Execute 'bash /tmp/tracker_enroll.sh' 2>&1)
  else
    run_to 40 "$DC" RemoteControl "$n" Execute "curl.exe -fsSL $SRV/enroll.ps1 -o C:\\Windows\\Temp\\tracker_enroll.ps1" >/dev/null 2>&1
    r=$(run_to 60 "$DC" RemoteControl "$n" Execute 'powershell -ExecutionPolicy Bypass -File C:\Windows\Temp\tracker_enroll.ps1' 2>&1)
  fi
  if echo "$r" | grep -q "tracker-agent installed"; then
    echo "$n OK" >> "$OUT"
  else
    echo "$n FAIL: $(echo "$r" | grep -iE 'stderr|exception|denied|error|timeout' | head -1 | tr -d '\r' | cut -c1-80)" >> "$OUT"
  fi
}

for n in $("$DC" GetSlaveNames 2>/dev/null | tr -d '\r'); do
  enroll_one "$n" &
done
wait
echo "=== enrollment pass complete ===" >> "$OUT"
sort "$OUT"
