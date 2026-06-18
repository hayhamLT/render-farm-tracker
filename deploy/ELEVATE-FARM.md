# Elevating the farm (the one step the tracker can't do itself)

The tracker can download installers (no login — Maxon's CDN is public), distribute them
over the LAN, verify SHA256, and run them silently. The **only** thing it can't bootstrap
remotely is **elevation** — Windows/macOS deliberately forbid a user-level process from
granting itself admin rights without an already-elevated foothold. This is the same reason
PDQ / SCCM / Jamf / Intune all require admin creds or MDM enrollment.

You run **one** of the methods below **once per node**. After that, the tracker installs
across the whole farm automatically (one click → public download once → LAN fan-out →
SHA256-verified → silent install → version-confirmed).

The command each method runs is just:

- **Windows:** `irm http://10.10.10.96:4400/elevate.ps1 | iex`   (must be an *elevated* shell)
- **macOS:**   `curl -fsSL http://10.10.10.96:4400/setup.sh | sudo bash`

`elevate.ps1` registers the agent as a scheduled task that runs as the logged-on user with
**highest privileges** (elevated, no UAC, keeps the user's Maxon session). `setup.sh`
installs the agent as a **root LaunchDaemon**.

---

## Windows — pick one

### A. Group Policy (domain — best for scale)
Group Policy Preferences run as SYSTEM, so they can create the elevated task on every machine:
1. GPMC → new GPO linked to the render-node OU.
2. Computer Config → Preferences → Control Panel Settings → **Scheduled Tasks** → New → "At least Windows 7".
3. General: Run as `NT AUTHORITY\SYSTEM`, **Run with highest privileges**.
4. Action: Start a program →
   `powershell.exe` arg `-NoProfile -ExecutionPolicy Bypass -Command "irm http://10.10.10.96:4400/elevate.ps1 | iex"`
5. Trigger: At startup (one-shot is fine). `gpupdate /force` or reboot the nodes.

### B. PDQ Deploy
New package → PowerShell step (PDQ runs as its deployment service = SYSTEM):
```
irm http://10.10.10.96:4400/elevate.ps1 | iex
```
Target the render nodes → Deploy Once.

### C. Manual / RDP (no management tool)
On each node: right-click PowerShell → **Run as administrator** →
```
irm http://10.10.10.96:4400/elevate.ps1 | iex
```

---

## macOS — pick one

### A. MDM (Jamf / Mosyle / Intune) — best for scale
Push a script policy (runs as root):
```
curl -fsSL http://10.10.10.96:4400/setup.sh | sudo bash
```

### B. Apple Remote Desktop
Send UNIX command **as root** to the selected Macs:
```
curl -fsSL http://10.10.10.96:4400/setup.sh | bash
```

### C. Manual / SSH
```
curl -fsSL http://10.10.10.96:4400/setup.sh | sudo bash
```

---

## Verify
Each node flips its agent to elevated within a minute. On the dashboard the node stays
online; the next install it runs will complete with **no UAC/root prompt** and the version
badge will change for real. Re-running any of the above is safe (idempotent).
