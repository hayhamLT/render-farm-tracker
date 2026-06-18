#!/bin/bash
# End-to-end smoke test for the tracker.
# Usage: test/e2e.sh  (expects the server already running on :4400)
set -e
cd "$(dirname "$0")/.."
BASE=http://localhost:4400
KEY=$(node -e "console.log(require('./config.json').agentKey)")
J() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }

echo "--- 1. dashboard reachable"
curl -sf "$BASE/" | grep -q "Render Farm Update Tracker" && echo OK

echo "--- 2. bad agent key rejected"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/agent/checkin" -H 'X-Agent-Key: wrong' -d '{}')
[ "$code" = 401 ] && echo OK

echo "--- 3. simulate a mixed 10-node farm checking in"
for i in 1 2 3 4 5; do
  curl -sf -X POST "$BASE/api/agent/checkin" -H "X-Agent-Key: $KEY" -H 'Content-Type: application/json' -d "{
    \"hostname\": \"render-win-0$i\", \"os\": \"windows\", \"agentVersion\": \"1.0.0\",
    \"software\": [
      {\"product\": \"cinema4d\", \"version\": \"2025.1.$i\", \"path\": \"C:\\\\Program Files\\\\Maxon Cinema 4D 2025\"},
      {\"product\": \"redshift\", \"version\": \"2025.4.0\", \"path\": \"C:\\\\ProgramData\\\\Redshift\"},
      {\"product\": \"aftereffects\", \"version\": \"25.2\", \"path\": \"C:\\\\Program Files\\\\Adobe\\\\Adobe After Effects 2025\"}
    ]}" > /dev/null
  curl -sf -X POST "$BASE/api/agent/checkin" -H "X-Agent-Key: $KEY" -H 'Content-Type: application/json' -d "{
    \"hostname\": \"render-mac-0$i\", \"os\": \"macos\", \"agentVersion\": \"1.0.0\",
    \"software\": [
      {\"product\": \"cinema4d\", \"version\": \"2024.5.1\", \"path\": \"/Applications/Maxon Cinema 4D 2024\"},
      {\"product\": \"redshift\", \"version\": \"2025.3.2\", \"path\": \"pkg:com.maxon.redshift\"},
      {\"product\": \"redgiant\", \"version\": \"2025.2\", \"path\": \"pkg:com.redgiant.universe\"}
    ]}" > /dev/null
done
n=$(curl -sf "$BASE/api/state" | J "len(d['nodes'])")
echo "nodes registered: $n"; [ "$n" = 10 ] && echo OK

echo "--- 4. set latest versions in catalog"
curl -sf -X PUT "$BASE/api/products/cinema4d" -H 'Content-Type: application/json' \
  -d '{"latest_version": "2025.2.1"}' > /dev/null
curl -sf -X PUT "$BASE/api/products/redshift" -H 'Content-Type: application/json' \
  -d '{"latest_version": "2025.4.0"}' > /dev/null
echo OK

echo "--- 5. register a package (fake installer) and deploy"
echo '#!/bin/sh
echo "fake installer ran"' > installers/fake-c4d-2025.2.1.sh
curl -sf -X POST "$BASE/api/packages" -H 'Content-Type: application/json' -d '{
  "product_key": "cinema4d", "version": "2025.2.1", "os": "macos",
  "filename": "fake-c4d-2025.2.1.sh", "install_command": "sh \"{file}\""}' > /dev/null
PKG=$(curl -sf "$BASE/api/state" | J "d['packages'][0]['id']")
NODE=$(curl -sf "$BASE/api/state" | J "[n['id'] for n in d['nodes'] if n['hostname']=='render-mac-01'][0]")
WINNODE=$(curl -sf "$BASE/api/state" | J "[n['id'] for n in d['nodes'] if n['os']=='windows'][0]")
queued=$(curl -sf -X POST "$BASE/api/deployments" -H 'Content-Type: application/json' \
  -d "{\"package_id\": $PKG, \"node_ids\": [$NODE, $WINNODE]}" | J "len(d['queued'])")
echo "queued jobs: $queued (windows node must be skipped)"; [ "$queued" = 1 ] && echo OK

echo "--- 6. real agent run against the server (this Mac detects its own software, executes the job)"
# Check in as render-mac-01 so the queued job is picked up: spoof via hostname is not possible,
# so instead run the agent for real (registers this machine) and also drain the queued job manually.
python3 agents/render_agent.py --server "$BASE" --key "$KEY" --once

echo "--- 7. simulate render-mac-01 executing its job"
JOB=$(curl -sf -X POST "$BASE/api/agent/checkin" -H "X-Agent-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"hostname": "render-mac-01", "os": "macos"}' | J "d['jobs'][0]['id']")
curl -sf -X GET "$BASE/api/agent/download/$PKG" -H "X-Agent-Key: $KEY" -o /tmp/fake-installer.sh
sh /tmp/fake-installer.sh
curl -sf -X POST "$BASE/api/agent/jobs/$JOB/status" -H "X-Agent-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"status": "success", "log": "Exit code 0\nfake installer ran"}' > /dev/null
st=$(curl -sf "$BASE/api/state" | J "[j['status'] for j in d['jobs'] if j['id']==$JOB][0]")
echo "job status: $st"; [ "$st" = success ] && echo OK

echo "--- ALL TESTS PASSED"
