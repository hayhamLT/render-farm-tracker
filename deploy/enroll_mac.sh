#!/bin/bash
# Runs ON a macOS worker (delivered via Deadline RemoteControl Execute).
# Installs the tracker agent as a per-user LaunchAgent (no sudo needed).
# Args: $1 = server base URL, $2 = agent key
set -e
SERVER="$1"; KEY="$2"
DIR="$HOME/tracker"
mkdir -p "$DIR" "$HOME/Library/LaunchAgents"
curl -fsSL "$SERVER/agent" -o "$DIR/render_agent.py"
PLIST="$HOME/Library/LaunchAgents/com.tracker.agent.plist"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.tracker.agent</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/python3</string><string>$DIR/render_agent.py</string>
    <string>--server</string><string>$SERVER</string>
    <string>--key</string><string>$KEY</string>
    <string>--interval</string><string>60</string>
  </array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/agent.log</string>
  <key>StandardErrorPath</key><string>$DIR/agent.log</string>
</dict></plist>
PLIST
launchctl bootout gui/$(id -u)/com.tracker.agent 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$PLIST"
echo "tracker-agent installed on $(hostname)"
