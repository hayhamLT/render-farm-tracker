#!/usr/bin/env python3
"""
Render Farm Update Tracker — node agent.

Runs on each render node (Windows or macOS). Periodically:
  1. Detects installed versions of Cinema 4D, Redshift, Red Giant and After Effects.
  2. Checks in with the tracker server (inventory + heartbeat).
  3. Executes any deployment jobs the server has queued for this node
     (download installer, run the package's silent install command, report result).

Stdlib only — no pip installs needed. Python 3.8+.

Usage:
    python3 render_agent.py --server http://tracker-host:4400 --key <AGENT_KEY>
    python3 render_agent.py --server ... --key ... --once          # single check-in, no loop
    python3 render_agent.py --config /path/to/agent_config.json

Config file (overridden by CLI flags):
    { "server": "http://tracker-host:4400", "key": "....", "interval": 60 }

Deployments run installer commands, so run the agent with admin rights:
  - Windows: as a service / scheduled task running as SYSTEM or an admin account.
  - macOS:   as a LaunchDaemon (root). See agents/com.tracker.agent.plist.
"""

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import urllib.error

AGENT_VERSION = "2.21.0"
IS_WINDOWS = platform.system() == "Windows"
IS_MACOS = platform.system() == "Darwin"

# Run EVERYTHING silently on Windows. The agent is headless, so any console child it
# spawns (cmd for install commands, tasklist, mx1, RUM, ffmpeg, taskkill, powershell)
# would otherwise FLASH an MS-DOS window, and a GUI an installer opens would pop to the
# foreground. We subclass subprocess.Popen ONCE here so every subprocess.run()/Popen()
# in the agent inherits it (run() calls Popen internally): CREATE_NO_WINDOW kills the
# console, and STARTUPINFO + SW_HIDE asks any window to start hidden.
if IS_WINDOWS:
    _CREATE_NO_WINDOW = 0x08000000
    # CREATE_NO_WINDOW, DETACHED_PROCESS (0x08) and CREATE_NEW_CONSOLE (0x10) are
    # MUTUALLY EXCLUSIVE — CreateProcess fails if more than one is set. The self-update
    # relaunch already passes DETACHED_PROCESS (which is itself console-less), so only add
    # CREATE_NO_WINDOW when none of those console flags is present.
    _CONSOLE_FLAGS = 0x08000000 | 0x00000008 | 0x00000010

    class _SilentPopen(subprocess.Popen):
        def __init__(self, *args, **kwargs):
            cf = kwargs.get("creationflags", 0)
            if not (cf & _CONSOLE_FLAGS):
                cf |= _CREATE_NO_WINDOW
            kwargs["creationflags"] = cf
            if kwargs.get("startupinfo") is None:
                si = subprocess.STARTUPINFO()
                si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                si.wShowWindow = 0  # SW_HIDE
                kwargs["startupinfo"] = si
            super().__init__(*args, **kwargs)

    subprocess.Popen = _SilentPopen


def hide_own_console():
    """Hide the agent's OWN console window on Windows.

    The agent is meant to run as the hidden SYSTEM scheduled task, which has no console at
    all. But if it ever runs interactively — a Startup-folder shortcut, a manual start, or
    the Fast-Startup fallback on a node where the AtStartup SYSTEM task didn't fire (AVA-01)
    — python.exe attaches a visible MS-DOS console. A user who closes that window KILLS the
    agent mid-install and the node drops offline. So hide our own console window immediately:
    there's then no window to see or accidentally close. Best-effort, never raises. Under
    pythonw.exe or the SYSTEM task there is no console, so GetConsoleWindow() returns 0 and
    this is a harmless no-op.
    """
    if not IS_WINDOWS:
        return
    try:
        import ctypes
        hwnd = ctypes.windll.kernel32.GetConsoleWindow()
        if hwnd:
            ctypes.windll.user32.ShowWindow(hwnd, 0)  # SW_HIDE
    except Exception:
        pass


def acquire_single_instance():
    """Ensure only one agent runs per machine.

    Self-update relaunch + the scheduled task's restart-on-failure can briefly
    race; a global named mutex guarantees the loser exits instead of doubling up
    check-ins and installs. On macOS the root LaunchDaemon (KeepAlive) already
    guarantees a single instance, so this is a no-op there.
    """
    if not IS_WINDOWS:
        return True
    try:
        import ctypes
        ERROR_ALREADY_EXISTS = 183
        h = ctypes.windll.kernel32.CreateMutexW(None, False, "Global\\TrackerRenderAgent")
        if ctypes.windll.kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
            return False
        # Leak the handle on purpose: it stays held for the life of the process.
        acquire_single_instance._handle = h
        return True
    except Exception:
        return True  # never let the guard itself stop the agent from running


def ensure_task_watchdog():
    """Self-heal the elevated scheduled task so the agent ALWAYS restarts on its own.

    The original task attached its 5-minute repetition to the AtStartup trigger. If
    AtStartup never fired — which is exactly what Windows **Fast Startup** does (a
    "shutdown" becomes a hybrid resume, not a cold boot, so AtStartup tasks are skipped)
    — the repetition never started either, so a rebooted node could sit powered-on but
    with NO agent until someone logged in (the MARS-02 / AVA-01 symptom).

    Fix: give the task an INDEPENDENT time-based heartbeat trigger (every 5 min,
    StartWhenAvailable) that fires regardless of how the machine powered on, plus the
    AtStartup trigger. The single-instance mutex makes a re-fire a no-op when the agent
    is already alive. Idempotent (re-set on each agent start); best-effort, never raises.
    """
    if not IS_WINDOWS:
        return
    ps = (
        "$t=Get-ScheduledTask -TaskName 'TrackerAgentElevated' -ErrorAction SilentlyContinue;"
        "if($t){"
        "$boot=New-ScheduledTaskTrigger -AtStartup;"
        "$beat=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(-1) "
        "-RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650);"
        "Set-ScheduledTask -TaskName 'TrackerAgentElevated' -Trigger @($boot,$beat) | Out-Null}"
    )
    try:
        import base64
        enc = base64.b64encode(ps.encode("utf-16-le")).decode()
        subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                        "-EncodedCommand", enc], capture_output=True, timeout=60)
    except Exception:
        pass


def ensure_fast_startup_disabled():
    """Turn OFF Windows Fast Startup so a 'shutdown' is a TRUE cold boot.

    Fast Startup ("HiberbootEnabled") makes a shutdown a hybrid-hibernate: the next
    power-on RESUMES the saved kernel session instead of cold-booting, so AtStartup
    scheduled tasks don't fire (agent never comes back) AND Wake-on-LAN from S5 often
    fails. Disabling it makes shutdown/restart behave predictably. Idempotent registry
    write; only succeeds as SYSTEM/admin (the elevated task), silently no-ops otherwise.
    Leaves normal hibernate/sleep untouched. This auto-propagates fleet-wide as agents
    self-update — no manual re-elevation needed.
    """
    if not IS_WINDOWS:
        return
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                             r"SYSTEM\CurrentControlSet\Control\Session Manager\Power",
                             0, winreg.KEY_READ | winreg.KEY_SET_VALUE)
        try:
            cur, _ = winreg.QueryValueEx(key, "HiberbootEnabled")
        except OSError:
            cur = None
        if cur != 0:
            winreg.SetValueEx(key, "HiberbootEnabled", 0, winreg.REG_DWORD, 0)
        winreg.CloseKey(key)
    except Exception:
        pass

# --------------------------------------------------------------------------
# Software detection
# --------------------------------------------------------------------------

# product_key -> list of regexes matched against uninstall-entry / package names
PRODUCT_PATTERNS = {
    "cinema4d": [r"cinema\s*4d"],
    "redshift": [r"redshift"],
    "redgiant": [r"red\s*giant", r"trapcode", r"magic\s*bullet", r"universe"],
    "aftereffects": [r"after\s*effects"],
    # Anchored so "Maxon Cinema 4D"/"Maxon Redshift" never match the app itself.
    "maxonapp": [r"^maxon(\s*app)?(\.app)?$", r"maxon\s*one"],
    "creativecloud": [r"creative\s*cloud"],
    "blender": [r"blender"],
    "notchlc": [r"notchlc", r"notch\s*lc"],
    # FFmpeg is a CLI binary (no registry/app entry) — detected separately, see detect_ffmpeg().
}


def _match_product(display_name):
    low = display_name.lower()
    for key, patterns in PRODUCT_PATTERNS.items():
        for pat in patterns:
            if re.search(pat, low):
                return key
    return None


def _version_tuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", str(v))[:6]) or (0,)


def is_elevated():
    """True if this agent runs with admin/root rights (installs run without prompts)."""
    if IS_WINDOWS:
        try:
            import ctypes
            return bool(ctypes.windll.shell32.IsUserAnAdmin())
        except Exception:
            return False
    return os.geteuid() == 0


def detect_windows():
    """Read DisplayName/DisplayVersion from the Windows uninstall registry keys."""
    import winreg

    found = {}  # key -> (version, path)
    roots = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ]
    for hive, base in roots:
        try:
            with winreg.OpenKey(hive, base) as root:
                for i in range(winreg.QueryInfoKey(root)[0]):
                    try:
                        sub = winreg.EnumKey(root, i)
                        with winreg.OpenKey(root, sub) as k:
                            def val(name):
                                try:
                                    return str(winreg.QueryValueEx(k, name)[0])
                                except OSError:
                                    return ""
                            name = val("DisplayName")
                            if not name:
                                continue
                            product = _match_product(name)
                            if not product:
                                continue
                            version = val("DisplayVersion")
                            loc = val("InstallLocation") or name
                            prev = found.get(product)
                            if not prev or _version_tuple(version) > _version_tuple(prev[0]):
                                found[product] = (version, loc)
                    except OSError:
                        continue
        except OSError:
            continue

    # Fallback: derive versions from Program Files folder names if registry missed them.
    for base in (r"C:\Program Files", r"C:\Program Files\Adobe"):
        if not os.path.isdir(base):
            continue
        for entry in os.listdir(base):
            product = _match_product(entry)
            if product and product not in found:
                m = re.search(r"(\d[\d.]*)", entry)
                found[product] = (m.group(1) if m else "", os.path.join(base, entry))
    return found


def _plist_version(app_path):
    """CFBundleShortVersionString (fallback CFBundleVersion) from an .app bundle."""
    import plistlib

    info = os.path.join(app_path, "Contents", "Info.plist")
    try:
        with open(info, "rb") as f:
            pl = plistlib.load(f)
        return str(pl.get("CFBundleShortVersionString") or pl.get("CFBundleVersion") or "")
    except Exception:
        return ""


# Candidate priority: authoritative sources (bundle plists, plugin plists,
# release notes, pkg receipts) beat versions guessed from folder names.
PRIO_FOLDER, PRIO_PLIST = 1, 2


def _consider(found, product, version, path, prio):
    if not version:
        return
    cur = found.get(product)
    new_rank = (prio, _version_tuple(version), -len(os.path.basename(path)))
    if cur is None or new_rank > cur[2]:
        found[product] = (version, path, new_rank)


def detect_macos():
    found = {}  # key -> (version, path, rank)

    # 1) Scan /Applications (two levels deep) for matching .app bundles / folders.
    apps_root = "/Applications"
    candidates = []
    try:
        for entry in os.listdir(apps_root):
            full = os.path.join(apps_root, entry)
            candidates.append(full)
            if os.path.isdir(full) and not entry.endswith(".app"):
                try:
                    candidates += [os.path.join(full, e) for e in os.listdir(full)]
                except OSError:
                    pass
    except OSError:
        pass

    for path in candidates:
        name = os.path.basename(path)
        if name.endswith(("uninstall.app", "Uninstall.app")):
            continue
        product = _match_product(name)
        if not product:
            continue
        if name.endswith(".app"):
            _consider(found, product, _plist_version(path), path, PRIO_PLIST)
        else:
            m = re.search(r"(\d{4}(?:\.\d+)*|\d+(?:\.\d+)+)", name)
            _consider(found, product, m.group(1) if m else "", path, PRIO_FOLDER)
        # Maxon Redshift folders carry the exact version in release_notes.txt
        # (first line, e.g. "2026.6.2 (2026.05)").
        notes = os.path.join(path, "release_notes.txt")
        if product == "redshift" and os.path.isfile(notes):
            try:
                with open(notes, errors="replace") as f:
                    m = re.match(r"\s*(\d+(?:\.\d+)+)", f.readline())
                if m:
                    _consider(found, product, m.group(1), path, PRIO_PLIST)
            except OSError:
                pass

    # 1b) Known fixed locations the two-level /Applications scan can't reach.
    #     The Creative Cloud desktop app hides three levels down in Utilities.
    cc_app = "/Applications/Utilities/Adobe Creative Cloud/ACC/Creative Cloud.app"
    if os.path.isdir(cc_app):
        _consider(found, "creativecloud", _plist_version(cc_app), cc_app, PRIO_PLIST)

    # 2) Adobe MediaCore plugin bundles — authoritative for Red Giant suites
    #    (Magic Bullet / Trapcode / Universe / VFX report the suite version).
    mediacore = "/Library/Application Support/Adobe/Common/Plug-ins/7.0/MediaCore"
    try:
        for entry in os.listdir(mediacore):
            product = _match_product(entry) or (
                "redgiant" if re.match(r"^MB ", entry) else None)
            if product != "redgiant":
                continue
            plugin_dir = os.path.join(mediacore, entry)
            try:
                for plug in os.listdir(plugin_dir):
                    if plug.endswith(".plugin"):
                        _consider(found, "redgiant",
                                  _plist_version(os.path.join(plugin_dir, plug)),
                                  plugin_dir, PRIO_PLIST)
            except OSError:
                continue
    except OSError:
        pass

    # 3) pkgutil receipts — fallback when nothing on disk matched.
    try:
        pkgs = subprocess.run(
            ["pkgutil", "--pkgs"], capture_output=True, text=True, timeout=30
        ).stdout.splitlines()
        for pkg_id in pkgs:
            product = _match_product(pkg_id)
            if not product:
                continue
            info = subprocess.run(
                ["pkgutil", "--pkg-info", pkg_id], capture_output=True, text=True, timeout=30
            ).stdout
            m = re.search(r"^version:\s*(.+)$", info, re.M)
            if m:
                _consider(found, product, m.group(1).strip(), "pkg:" + pkg_id, PRIO_PLIST)
    except Exception:
        pass

    return {k: (ver, path) for k, (ver, path, _rank) in found.items()}


# The Maxon mx1 CLI (logged in on each node) is the authoritative source for
# Maxon product versions — far more reliable than registry/plist guessing.
MX1_PATH_WIN = r"C:\Program Files\Maxon\Tools\mx1.exe"
MX1_PATH_MAC = "/Library/Application Support/Maxon/Tools/mx1"
MX1_IDS = {
    "net.maxon.cinema4d": "cinema4d",
    "com.redshift3d.redshift": "redshift",
    "net.maxon.redgiant": "redgiant",
    "net.maxon.app": "maxonapp",
}


def detect_maxon_mx1():
    """Parse `mx1 product list` for installed Maxon product versions."""
    mx1 = MX1_PATH_WIN if IS_WINDOWS else MX1_PATH_MAC
    if not os.path.exists(mx1):
        return {}
    try:
        out = subprocess.run([mx1, "product", "list"],
                             capture_output=True, text=True, timeout=90).stdout
    except Exception:
        return {}
    found = {}
    for line in out.splitlines():
        m = re.search(r"(net\.maxon\.\S+|com\.\S+)\s*$", line.strip())
        if not m:
            continue
        key = MX1_IDS.get(m.group(1))
        if not key:
            continue
        # \binstalled\b matches "installed" but NOT "uninstalled"/"neverInstalled".
        if not re.search(r"\binstalled\b", line):
            continue
        vm = re.search(r"\b(\d{4}\.\d+(?:\.\d+)?|\d+\.\d+(?:\.\d+)?)\b", line)
        if vm:
            found[key] = (vm.group(1), "mx1:" + m.group(1))
    return found


def detect_maxon_latest():
    """Maxon 'latest available' is NOT auto-detected — the Catalog is the source of
    truth for Maxon versions (set manually when the Maxon App shows a new release).

    Why: mx1 has no reliable headless way to report the latest available version.
    `package query` / `product query` are not valid actions, and the only real signal
    (`mx1 product info <id>` -> hasUpdates) reads a cache that ONLY the Maxon App GUI
    refreshes. Render nodes have no GUI and there's no sudo-free CLI refresh, so that
    cache stays stale — `hasUpdates` reads false even when an update exists. (Installed
    versions are still detected via `mx1 product list`; see detect_maxon_mx1.)"""
    return {}


# Where Remote Update Manager lives if installed (Adobe pkg → mac; OOBE / our stage → win).
RUM_PATHS = (
    [r"C:\Program Files (x86)\Common Files\Adobe\OOBE_Enterprise\RemoteUpdateManager\RemoteUpdateManager.exe",
     r"C:\ProgramData\TrackerAgent\RemoteUpdateManager.exe"]
    if IS_WINDOWS else ["/usr/local/bin/RemoteUpdateManager"]
)


def detect_adobe_latest():
    """Latest AVAILABLE After Effects update per Adobe RUM (`--action=list`).
    The Adobe analog of detect_maxon_latest, so the catalog's AE 'latest' stays
    current with no manual entry. No-op if RUM isn't installed on this node."""
    rum = next((p for p in RUM_PATHS if os.path.exists(p)), None)
    if not rum:
        return {}
    try:
        out = subprocess.run([rum, "--action=list"], capture_output=True, text=True, timeout=120).stdout or ""
    except Exception:
        return {}
    # Lines look like "(AEFT/26.2.1.2/win64)" — take the highest, trimmed to the
    # 3-part marketing version so it matches what detect_software reports installed.
    vers = re.findall(r"\(AEFT/([0-9.]+)/", out)
    if not vers:
        return {}
    best = max(vers, key=_version_tuple)
    parts = best.split(".")
    return {"aftereffects": ".".join(parts[:3]) if len(parts) > 3 else best}


FFMPEG_MANAGED = (r"C:\ProgramData\TrackerAgent\ffmpeg\ffmpeg.exe" if IS_WINDOWS
                  else "/usr/local/bin/ffmpeg")


def _ffmpeg_candidates():
    """Standalone ffmpeg locations, in priority order. Deliberately a curated list of
    real install paths — NOT a filesystem search, which would also turn up app-bundled
    copies (Red Giant Trapcode Tools, Topaz Video, RemotePC, etc.) that aren't a usable
    standalone FFmpeg and would report misleading versions."""
    if IS_WINDOWS:
        return [
            FFMPEG_MANAGED,                          # tracker-managed copy
            r"C:\ffmpeg\bin\ffmpeg.exe",             # the de-facto standard manual install
            r"C:\ffmpeg\ffmpeg.exe",
            r"C:\tools\ffmpeg\bin\ffmpeg.exe",
            r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
            shutil.which("ffmpeg"),                  # anything on PATH
        ]
    return [
        FFMPEG_MANAGED,              # /usr/local/bin/ffmpeg (also Intel Homebrew)
        "/opt/homebrew/bin/ffmpeg", # Apple Silicon Homebrew — NOT on the launchd PATH
        "/opt/local/bin/ffmpeg",    # MacPorts
        shutil.which("ffmpeg"),     # anything on PATH
    ]


def detect_ffmpeg():
    """FFmpeg is a standalone CLI binary (no registry/app entry). Find a real standalone
    install by running `ffmpeg -version` at the managed path or a standard location.
    Render agents run under launchd / the Deadline service with a minimal PATH that omits
    /opt/homebrew/bin, so we probe explicit paths rather than relying on PATH alone.
    Returns (version, path) or None."""
    seen = set()
    for exe in _ffmpeg_candidates():
        if not exe or exe in seen:
            continue
        seen.add(exe)
        if not os.path.exists(exe):
            continue
        try:
            out = subprocess.run([exe, "-version"], capture_output=True, text=True, timeout=15).stdout or ""
        except Exception:
            continue
        m = re.search(r"ffmpeg version n?(\d+\.\d+(?:\.\d+)?)", out)
        if m:
            return (m.group(1), exe)
    return None


def detect_software():
    found = detect_windows() if IS_WINDOWS else detect_macos() if IS_MACOS else {}
    # mx1 only knows Maxon-App-managed installs — a standalone installer (e.g.
    # "Maxon Redshift 2026") is invisible to it. Let mx1 fill gaps or report
    # something NEWER, but never mask a newer on-disk install with a stale one.
    for key, val in detect_maxon_mx1().items():
        cur = found.get(key)
        if cur is None or _version_tuple(val[0]) > _version_tuple(cur[0]):
            found[key] = val
    ff = detect_ffmpeg()
    if ff:
        found["ffmpeg"] = ff
    nv = detect_nvidia_driver()
    if nv:
        found["nvidia"] = nv
    return [
        {"product": key, "version": ver or None, "path": path or None}
        for key, (ver, path) in sorted(found.items())
    ]


def detect_nvidia_driver():
    """The installed NVIDIA GeForce driver, reported as a trackable product so the server
    can flag out-of-date nodes and deploy the latest like any other app. Windows-only —
    the farm's NVIDIA cards are on Windows render nodes; macs are Apple Silicon. nvidia-smi
    reports the same public version string the tracker auto-detects (e.g. "610.62"), so the
    two compare directly. Returns (version, None) or None."""
    if not IS_WINDOWS:
        return None
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"],
                             capture_output=True, text=True, timeout=15).stdout or ""
        drv = next((l.strip() for l in out.splitlines() if l.strip()), "")
        # Only accept a clean version string (e.g. "610.62"). When the driver is broken
        # or absent, nvidia-smi prints an ERROR to stdout ("NVIDIA-SMI has failed…") —
        # never store that as a "version" (it would look like a node perpetually behind).
        return (drv, None) if re.match(r"^\d+(\.\d+)+$", drv) else None
    except Exception:
        return None


def _gpu_rendering():
    """True only when the GPU is ACTIVELY computing a render (high utilization). We must
    NOT use "is any process on the GPU" (compute-apps): on a Deadline farm the Worker
    service holds a persistent CUDA context even when idle, so that would defer the driver
    update forever and mislabel an idle node as "rendering". An actual render pins the GPU
    near 90-100%; an idle held context sits at ~0%. Windows render nodes only; if nvidia-smi
    can't run (broken/absent driver) we can't be rendering anyway, so don't block recovery."""
    if not IS_WINDOWS:
        return False
    try:
        p = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
                           capture_output=True, text=True, timeout=15)
        if p.returncode != 0:
            return False
        utils = [int(x.strip()) for x in (p.stdout or "").splitlines() if x.strip().isdigit()]
        return any(u >= 20 for u in utils)
    except Exception:
        return False


_MAC_CACHE = None
def _mac_addresses():
    """All hardware MAC addresses on this machine (for Wake-on-LAN). Cached — they don't
    change. Best-effort and stdlib-only; sending a wake packet to an extra/virtual MAC is
    harmless, so we don't try to filter perfectly."""
    global _MAC_CACHE
    if _MAC_CACHE is not None:
        return _MAC_CACHE
    macs = set()
    try:
        if IS_WINDOWS:
            out = subprocess.run(["getmac", "/fo", "csv", "/nh"], capture_output=True, text=True, timeout=15).stdout or ""
        elif IS_MACOS:
            out = subprocess.run(["ifconfig"], capture_output=True, text=True, timeout=15).stdout or ""
        else:
            out = subprocess.run(["ip", "link"], capture_output=True, text=True, timeout=15).stdout or ""
        for m in re.findall(r"([0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5})", out):
            mm = m.replace("-", ":").lower()
            if mm not in ("00:00:00:00:00:00", "ff:ff:ff:ff:ff:ff"):
                macs.add(mm)
    except Exception:
        pass
    _MAC_CACHE = sorted(macs)
    return _MAC_CACHE


def _fmt_gpus(names):
    """Collapse a multi-GPU list for display: identical cards become "2× Model"; mixed
    cards stay listed in full (e.g. "RTX 4090, GTX 1080"). Keeping every distinct model in
    the string matters — the server picks the NVIDIA driver track by regex over this text, so
    a machine with even one legacy (Maxwell/Pascal) card is correctly targeted to the driver
    that still supports its OLDEST card."""
    counts, order = {}, []
    for n in names:
        if n not in counts:
            counts[n] = 0
            order.append(n)
        counts[n] += 1
    return ", ".join(("%d× %s" % (counts[n], n)) if counts[n] > 1 else n for n in order)


def detect_health():
    """Machine health + GPU telemetry — every field is best-effort and independently
    guarded so a missing tool never breaks the check-in."""
    h = {}
    h["macs"] = _mac_addresses()   # for Wake-on-LAN (power a machine back on)
    # GPU + driver via nvidia-smi (Windows/Linux render nodes with NVIDIA). Report EVERY card
    # — many render nodes have multiple GPUs — and the single shared driver version.
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name,driver_version", "--format=csv,noheader"],
                             capture_output=True, text=True, timeout=15).stdout or ""
        names, drv = [], ""
        for ln in out.splitlines():
            if "," in ln:
                nm, dv = [x.strip() for x in ln.split(",", 1)]
                if nm:
                    names.append(nm)
                if dv and not drv:
                    drv = dv   # all GPUs in one machine run the same driver version
        if names:
            h["gpu"] = _fmt_gpus(names)
        if drv:
            h["gpuDriver"] = drv
    except Exception:
        pass
    # No NVIDIA card found via nvidia-smi → fall back to Windows WMI, which lists EVERY
    # display adapter (AMD/Radeon, Intel, virtual). Lets the dashboard show a node's GPU
    # even when it isn't NVIDIA (e.g. Node-00), and surfaces any AMD hardware on the farm.
    if not h.get("gpu") and IS_WINDOWS:
        try:
            out = subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 "Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion | ConvertTo-Csv -NoTypeInformation"],
                capture_output=True, text=True, timeout=25).stdout or ""
            rows = []
            for ln in out.splitlines():
                m = re.match(r'^"?(.*?)"?,"?(.*?)"?$', ln.strip())
                if m and m.group(1) and m.group(1).lower() != "name":
                    rows.append((m.group(1).strip(), m.group(2).strip()))
            # Prefer a real GPU over generic/virtual adapters (Basic Display, RDP, etc.).
            def rank(n):
                nl = n.lower()
                if any(k in nl for k in ("radeon", "amd", "nvidia", "geforce")): return 3
                if "intel" in nl: return 2
                if any(k in nl for k in ("basic", "remote", "virtual", "dameware", "mirror")): return 0
                return 1
            rows.sort(key=lambda r: rank(r[0]), reverse=True)
            if rows:
                h["gpu"] = rows[0][0]
                if rows[0][1] and not h.get("gpuDriver"):
                    h["gpuDriver"] = rows[0][1]
        except Exception:
            pass
    if not h.get("gpu") and IS_MACOS:  # Apple Silicon Macs have no NVIDIA — report the chip
        try:
            chip = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"],
                                  capture_output=True, text=True, timeout=10).stdout.strip()
            if chip:
                h["gpu"] = chip
        except Exception:
            pass
    # Live GPU utilization (%) so the Fleet view can show which nodes are ACTIVELY rendering.
    # Windows/NVIDIA only — an idle held CUDA context sits near 0%, a real render pins it near
    # 100% (same signal _gpu_rendering uses to gate installs). Best-effort.
    if IS_WINDOWS:
        try:
            pu = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
                                capture_output=True, text=True, timeout=15)
            if pu.returncode == 0:
                us = [int(x.strip()) for x in (pu.stdout or "").splitlines() if x.strip().isdigit()]
                if us:
                    h["gpuUtil"] = max(us)
        except Exception:
            pass
    # Free space on the system/install drive.
    try:
        du = shutil.disk_usage("C:\\" if IS_WINDOWS else "/")
        h["diskFreeGB"] = round(du.free / 1e9, 1)
        h["diskTotalGB"] = round(du.total / 1e9, 1)
    except Exception:
        pass
    # OS version.
    try:
        h["osVersion"] = ("Windows " + platform.version()) if IS_WINDOWS else ("macOS " + platform.mac_ver()[0])
    except Exception:
        pass
    # Windows pending-reboot (the common registry markers).
    if IS_WINDOWS:
        try:
            import winreg
            pending = 0
            for sub in (r"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending",
                        r"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired"):
                try:
                    winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, sub).Close()
                    pending = 1
                    break
                except OSError:
                    pass
            h["pendingReboot"] = pending
        except Exception:
            pass
    return h


# --------------------------------------------------------------------------
# Server communication
# --------------------------------------------------------------------------

class Server:
    def __init__(self, base_url, key):
        self.base = base_url.rstrip("/")
        self.key = key

    def _request(self, method, path, body=None, timeout=30):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            self.base + path,
            data=data,
            method=method,
            headers={"X-Agent-Key": self.key, "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())

    def checkin(self, software, latest=None, health=None):
        # software=None is a lightweight heartbeat (used while monitoring is paused).
        payload = {
            "hostname": socket.gethostname(),
            "os": "windows" if IS_WINDOWS else "macos",
            "agentVersion": AGENT_VERSION,
            "elevated": is_elevated(),
        }
        if software is not None:
            payload["software"] = software
        if latest:
            payload["latest"] = latest
        if health:
            payload["health"] = health
        return self._request("POST", "/api/agent/checkin", payload)

    def get_agent_code(self):
        req = urllib.request.Request(self.base + "/agent", headers={"X-Agent-Key": self.key})
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.read()

    def report(self, job_id, status, log=None):
        try:
            self._request("POST", "/api/agent/jobs/%d/status" % job_id,
                          {"status": status, "log": log})
        except Exception as e:
            print("  ! failed to report job status: %s" % e)

    def download(self, package_id, dest_path):
        req = urllib.request.Request(
            self.base + "/api/agent/download/%d" % package_id,
            headers={"X-Agent-Key": self.key},
        )
        with urllib.request.urlopen(req, timeout=120) as resp, open(dest_path, "wb") as out:
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)


# --------------------------------------------------------------------------
# Job execution
# --------------------------------------------------------------------------

INSTALL_TIMEOUT = 3600  # seconds


def _installed_version(product_key):
    for s in detect_software():
        if s.get("product") == product_key:
            return s.get("version")
    return None


# --------------------------------------------------------------------------
# Update blockers: never interrupt an active render; close an idle app that would
# otherwise make the installer / RUM fail with "app in use".
# --------------------------------------------------------------------------
def _proc_running(names):
    """True if any exact-named process is running (best-effort, cross-platform)."""
    for n in names:
        try:
            if IS_WINDOWS:
                out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq %s" % n, "/NH"],
                                     capture_output=True, text=True, timeout=20).stdout or ""
                if n.lower() in out.lower():
                    return True
            elif subprocess.run(["pgrep", "-x", n], capture_output=True, timeout=20).returncode == 0:
                return True
        except Exception:
            pass
    return False


def _close_app(names):
    """Quit idle apps gracefully (SIGTERM / taskkill); force only if they hang."""
    for n in names:
        try:
            if IS_WINDOWS:
                subprocess.run(["taskkill", "/IM", n], capture_output=True, timeout=20)
            else:
                subprocess.run(["pkill", "-TERM", "-x", n], capture_output=True, timeout=20)
        except Exception:
            pass
    time.sleep(6)
    if _proc_running(names):
        for n in names:
            try:
                if IS_WINDOWS:
                    subprocess.run(["taskkill", "/F", "/IM", n], capture_output=True, timeout=20)
                else:
                    subprocess.run(["pkill", "-KILL", "-x", n], capture_output=True, timeout=20)
            except Exception:
                pass


def _restart_cc():
    """Bounce the Creative Cloud desktop app right after an install so it relaunches
    and runs its own self-update check. Best-effort and silent — never fails a job,
    and skipped while a render is active (don't disturb Adobe licensing mid-render)."""
    ae_render = ["aerender.exe"] if IS_WINDOWS else ["aerender"]
    c4d = ["Cinema 4D.exe"] if IS_WINDOWS else ["Cinema 4D"]
    if _proc_running(ae_render + c4d):
        return
    try:
        if IS_WINDOWS:
            subprocess.run(
                'taskkill /F /IM "Adobe Desktop Service.exe" /IM "Creative Cloud.exe" '
                '/IM "CCXProcess.exe" 2>nul & ver >nul',
                shell=True, capture_output=True, timeout=30)
            time.sleep(2)
            for p in (r"C:\Program Files\Adobe\Adobe Creative Cloud\ACC\Creative Cloud.exe",
                      r"C:\Program Files (x86)\Adobe\Adobe Creative Cloud\ACC\Creative Cloud.exe"):
                if os.path.exists(p):
                    subprocess.Popen([p], close_fds=True)
                    break
        else:
            subprocess.run(
                "pkill -f 'Adobe Desktop Service' 2>/dev/null; pkill -x 'Creative Cloud' 2>/dev/null; "
                "pkill -f 'Adobe Creative Cloud' 2>/dev/null; true",
                shell=True, capture_output=True, timeout=30)
            time.sleep(2)
            # -g: don't bring it to the foreground;  -j: launch hidden/minimized in the
            # background. CC still runs and self-updates, but never steals the screen.
            subprocess.run(["open", "-g", "-j", "-a", "Creative Cloud"], capture_output=True, timeout=20)
        print("  ↻ restarted Creative Cloud (hidden) to pick up updates")
    except Exception:
        pass


# A running "render" process means work is in progress — NEVER touch it, defer the
# update. A "gui" process is the app left open idle — safe to close. (Cinema 4D
# can't be told apart from a C4D render by name, so we never auto-close it.)
def _blockers(product_key):
    # RUM HANGS if a target app is open. AE updates touch After Effects AND Media Encoder
    # (AEFT,AME), so DEFER the patch while any of them — or the render engine — is running,
    # rather than force-closing an artist's session or letting the install stall. It retries
    # automatically each check-in once they're closed.
    ae_apps = (["AfterFX.exe", "AfterFX.com", "aerender.exe", "Adobe Media Encoder.exe", "AfterFXLib.dll"]
               if IS_WINDOWS else ["After Effects", "aerender", "Adobe Media Encoder"])
    ae_render = ["aerender.exe"] if IS_WINDOWS else ["aerender"]
    c4d = ["Cinema 4D.exe"] if IS_WINDOWS else ["Cinema 4D"]
    return {
        "aftereffects": {"render": ae_apps, "gui": []},
        "cinema4d":     {"render": c4d, "gui": []},
        "redshift":     {"render": c4d, "gui": []},
        "redgiant":     {"render": c4d + ae_render, "gui": []},
        # CC refresh must never bounce Adobe licensing mid-render — defer if rendering.
        "creativecloud": {"render": ae_render + c4d, "gui": []},
    }.get(product_key, {"render": [], "gui": []})


def prepare_for_install(product_key):
    """(proceed, note). proceed=False => defer: the node is rendering and must not
    be interrupted (it retries automatically next check-in). An idle blocking app
    is closed gracefully so the install isn't blocked."""
    # The GPU driver is special: installing it RESETS the GPU and would crash any active
    # render (and the install itself fails, "device in use"). It has no single render
    # process to watch, so gate on whether the GPU is actually busy with compute work.
    if product_key == "nvidia" and _gpu_rendering():
        return False, ("Deferred — the GPU is busy rendering; the NVIDIA driver update "
                       "will run automatically once the GPU is idle.")
    b = _blockers(product_key)
    if not b["render"] and not b["gui"]:
        return True, ""
    if _proc_running(b["render"]):
        return False, ("Deferred — this node is rendering; the %s update will run "
                       "automatically once it's idle." % product_key)
    if b["gui"] and _proc_running(b["gui"]):
        print("  closing idle %s app before install" % product_key)
        _close_app(b["gui"])
    return True, ""


def _reboot_machine():
    """Reboot this machine on the server's request — the agent-side fallback for when
    Deadline RemoteControl can't reach the box. The agent runs elevated (Windows) / as root
    (mac), so the OS reboot command works without a prompt."""
    try:
        if IS_WINDOWS:
            subprocess.Popen('shutdown /r /t 5 /f /c "Restart requested from the Render Farm tracker"', shell=True)
        else:
            subprocess.Popen(["/sbin/shutdown", "-r", "now"])
        print("  ⏻ reboot requested by server — restarting now")
    except Exception as e:
        print("  ! reboot command failed: %s" % e)


def run_job(server, job):
    job_id = job["id"]
    kind = job.get("kind", "installer")
    print("Job #%d: %s %s (%s) — starting" % (job_id, job["product_key"], job["version"], kind))

    # Never interrupt an active render; close an idle blocking app first.
    proceed, defer_note = prepare_for_install(job["product_key"])
    if not proceed:
        server.report(job_id, "pending", defer_note)
        print("  ⏸ %s" % defer_note)
        return

    # "Refresh Creative Cloud" action: restart the CC desktop app so it re-checks Adobe and
    # applies any pending app updates (e.g. an After Effects build that ships via the CC
    # channel, not RUM). Render-gated above. No install/version change to verify.
    if kind == "command" and (job.get("install_command") or "").strip() == "__RESTART_CC__":
        _restart_cc()
        server.report(job_id, "success",
                      "Creative Cloud restarted — it will check Adobe for pending app "
                      "updates (applies in the background if auto-update is on and the app is closed).")
        print("  ✓ Creative Cloud refreshed")
        return

    # Snapshot the version before installing so we can verify it actually changed.
    before_ver = _installed_version(job["product_key"])

    work_dir = None
    installer = None
    if kind == "command":
        # Managed update: run a tool already on the node (Adobe RUM, Maxon App
        # CLI, winget, etc.). No file download; {file} is not used.
        cmd = job["install_command"]
    else:
        work_dir = tempfile.mkdtemp(prefix="tracker_job_%d_" % job_id)
        installer = os.path.join(work_dir, os.path.basename(job["filename"]))
        server.report(job_id, "downloading", "Downloading %s" % job["filename"])
        try:
            server.download(job["package_id"], installer)
        except Exception as e:
            server.report(job_id, "failed", "Download failed: %s" % e)
            print("  ! download failed: %s" % e)
            return
        # Verify integrity before running anything (SHA256 from the server).
        expected = job.get("sha256")
        if expected:
            h = hashlib.sha256()
            with open(installer, "rb") as f:
                for chunk in iter(lambda: f.read(1024 * 1024), b""):
                    h.update(chunk)
            actual = h.hexdigest()
            if actual.lower() != expected.lower():
                server.report(job_id, "failed",
                              "SHA256 mismatch — refusing to install.\nexpected %s\ngot      %s"
                              % (expected, actual))
                print("  ! sha256 mismatch — aborting")
                return
            print("  sha256 verified")
        if IS_MACOS:
            os.chmod(installer, 0o755)
        cmd = job["install_command"].replace("{file}", installer)

    server.report(job_id, "installing", "Running: %s" % cmd)
    print("  running: %s" % cmd)
    # Per-product timeout: Adobe RUM installs run ~10-15 min, so cap them at 30 min — a hung
    # RUM (e.g. an in-use app it can't patch) self-aborts and frees the machine fast instead
    # of tying it up for the full hour. Everything else keeps the long default.
    job_timeout = 1800 if job["product_key"] in ("aftereffects", "creativecloud") else INSTALL_TIMEOUT
    try:
        proc = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            text=True,
            timeout=job_timeout,
        )
        tail = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip()[-4000:]
        if proc.returncode != 0:
            server.report(job_id, "failed", "Exit code %d\n%s" % (proc.returncode, tail))
            print("  ✗ failed (exit %d)" % proc.returncode)
        else:
            # Verify the install actually changed the version — exit 0 alone is not
            # proof (e.g. a downloader that doesn't install would exit 0 too).
            after_ver = _installed_version(job["product_key"])
            target = job.get("version") or ""
            changed = after_ver and after_ver != before_ver
            reached = after_ver and target and _version_tuple(after_ver) >= _version_tuple(target)
            # Some installs don't reflect the new version during the job:
            #  • NVIDIA driver — installed with -noreboot, so nvidia-smi keeps reporting
            #    the OLD version until the machine reboots. Exit 0 IS the install proof.
            #  • Creative Cloud — self-updates asynchronously after a nudge.
            reboot_deferred = job["product_key"] == "nvidia"
            # Adobe RUM ran fine but had nothing to install: the node is already current
            # per Adobe's update source. This is NOT a failure — RUM simply can't deliver a
            # version that isn't in its catalog (e.g. an AE release that shipped via the
            # Creative Cloud app). Treat exit-0 + "no applicable updates" as a clean no-op.
            tl = tail.lower()
            rum_noop = ("no new applicable updates" in tl
                        or "all products are up-to-date" in tl
                        or "all products are up to date" in tl)
            if changed or reached or reboot_deferred or job["product_key"] == "creativecloud":
                if reboot_deferred and not (changed or reached):
                    note = ("Installed (target %s) — takes effect after reboot; nvidia-smi "
                            "still reports %s until then.\n%s" % (target, after_ver, tail))
                else:
                    note = "Installed: %s -> %s\n%s" % (before_ver, after_ver, tail)
                server.report(job_id, "success", note)
                print("  ✓ success (%s -> %s)" % (before_ver, after_ver))
                # Restart Creative Cloud right after any install so it self-updates too.
                if job["product_key"] != "creativecloud":
                    _restart_cc()
            elif rum_noop:
                server.report(job_id, "success",
                              "No RUM update needed — Adobe RUM reports this node is already "
                              "current per Adobe's update source. A release like %s ships "
                              "through the Creative Cloud app, not RUM, so RUM can't deliver "
                              "it (and didn't fail).\n%s" % (target or "the latest", tail))
                print("  ✓ RUM no-op (current per Adobe source, %s)" % after_ver)
            else:
                server.report(job_id, "failed",
                              "Command exited 0 but version unchanged (still %s) — "
                              "nothing installed.\n%s" % (after_ver, tail))
                print("  ✗ no-op (version unchanged: %s)" % after_ver)
    except subprocess.TimeoutExpired:
        server.report(job_id, "failed", "Command timed out after %ds (no progress — the agent aborted it to free the machine)" % job_timeout)
    except Exception as e:
        server.report(job_id, "failed", "Execution error: %s" % e)
    finally:
        if installer:
            try:
                os.remove(installer)
                os.rmdir(work_dir)
            except OSError:
                pass


# --------------------------------------------------------------------------
# Self-update — keep every node's agent current with no manual push.
# --------------------------------------------------------------------------

def self_update(server, latest):
    """Download the newer agent, replace this script, and relaunch."""
    try:
        code = server.get_agent_code()
        # Sanity-check before overwriting, so a bad download can't brick the agent.
        if b"AGENT_VERSION" not in code or b"def main" not in code or len(code) < 2000:
            print("  ! self-update aborted: downloaded agent failed sanity check")
            return
        script = os.path.abspath(__file__)
        tmp = script + ".new"
        with open(tmp, "wb") as f:
            f.write(code)
        if not IS_WINDOWS:
            os.chmod(tmp, 0o755)
        os.replace(tmp, script)              # atomic swap
        print("Self-updated agent -> %s, relaunching" % latest)
        if IS_WINDOWS:
            # The elevated agent runs inside a scheduled-task *job object*; when this
            # process exits the job is torn down and would kill a plain child with it.
            # CREATE_BREAKAWAY_FROM_JOB lets the replacement escape the job and survive.
            DETACHED = 0x00000008
            NEW_GROUP = 0x00000200
            BREAKAWAY = 0x01000000
            cmd = [sys.executable, script] + sys.argv[1:]
            try:
                subprocess.Popen(cmd, creationflags=DETACHED | NEW_GROUP | BREAKAWAY,
                                 close_fds=True)
            except OSError:
                # Job forbids breakaway (rare) — fall back; the non-zero exit below
                # makes the task's restart-on-failure the safety net instead.
                subprocess.Popen(cmd, creationflags=DETACHED | NEW_GROUP, close_fds=True)
            # Exit NON-ZERO on purpose: if the child somehow dies with the job, the
            # scheduled task restarts the (already-updated) script within a minute.
            # The single-instance guard prevents a duplicate if the child survived.
            os._exit(1)
        else:
            # exec replaces this process in place; launchd/launchAgent keeps watching.
            os.execv(sys.executable, [sys.executable, script] + sys.argv[1:])
    except Exception as e:
        print("  ! self-update failed: %s" % e)


# --------------------------------------------------------------------------
# Wedge watchdog
# --------------------------------------------------------------------------
# The agent keeps heartbeating (stays "online") even if its work loop stalls or a job
# thread hangs — so `busy` never clears and it stops self-updating / picking up jobs. The
# OS auto-restart (Windows scheduled task / macOS LaunchDaemon) only catches a DEAD
# process, never a hung-but-alive one. This daemon thread force-restarts the agent if the
# main loop hasn't iterated in a long time OR a job thread has been running absurdly long;
# on exit the OS relaunches a fresh agent. Timeouts are generous so a healthy agent (which
# ticks ~once a minute, and installs cap at INSTALL_TIMEOUT) never trips it.
_MAIN_LOOP_STALE = 12 * 60      # main loop hasn't iterated in 12 min → stuck
_JOB_BUSY_MAX = 120 * 60        # a job thread alive > 2h → hung (real installs are minutes)


def _wedge_watchdog(state):
    while True:
        time.sleep(120)
        now = time.time()
        if state.get("tick") and now - state["tick"] > _MAIN_LOOP_STALE:
            print("Watchdog: main loop stalled %ds — restarting agent" % int(now - state["tick"]))
            os._exit(1)
        bs = state.get("busy_since")
        if bs and now - bs > _JOB_BUSY_MAX:
            print("Watchdog: install thread hung %dmin — restarting agent" % int((now - bs) / 60))
            os._exit(1)


# --------------------------------------------------------------------------
# Main loop
# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Render Farm Update Tracker agent")
    ap.add_argument("--server", help="tracker base URL, e.g. http://tracker-host:4400")
    ap.add_argument("--key", help="agent key (shown when the server starts)")
    ap.add_argument("--interval", type=int, help="check-in interval in seconds (default 60)")
    ap.add_argument("--config", help="path to agent_config.json")
    ap.add_argument("--once", action="store_true", help="check in once and exit")
    args = ap.parse_args()

    # First thing on Windows: hide any console window we were launched with, so the agent is
    # truly invisible and can't be closed out from under an install. (Skipped for --once so
    # manual test runs still print to the terminal.)
    if not args.once:
        hide_own_console()

    cfg = {}
    cfg_path = args.config or os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                           "agent_config.json")
    if os.path.exists(cfg_path):
        with open(cfg_path) as f:
            cfg = json.load(f)

    server_url = args.server or cfg.get("server")
    key = args.key or cfg.get("key")
    interval = args.interval or cfg.get("interval") or 60

    if not server_url or not key:
        ap.error("--server and --key are required (or provide agent_config.json)")
    if not IS_WINDOWS and not IS_MACOS:
        sys.exit("Unsupported OS: %s" % platform.system())

    if not args.once and not acquire_single_instance():
        print("Another agent instance is already running — exiting.")
        return

    server = Server(server_url, key)
    print("Tracker agent %s on %s (%s) -> %s"
          % (AGENT_VERSION, socket.gethostname(), platform.system(), server_url))

    # Make the elevated task self-restart (no-op on non-elevated/macOS nodes), and turn off
    # Fast Startup so reboots cold-boot the agent before login (and Wake-on-LAN works).
    ensure_task_watchdog()
    ensure_fast_startup_disabled()

    # Wedge watchdog: force a restart if the loop stalls or a job hangs (see above).
    watch_state = {"tick": time.time(), "busy_since": None}
    threading.Thread(target=_wedge_watchdog, args=(watch_state,), daemon=True).start()

    # Jobs run in a background worker so a slow/stuck install never blocks the
    # heartbeat — the node stays "online" the whole time it's installing.
    job_state = {"thread": None}

    def run_jobs_bg(jobs):
        for job in jobs:
            run_job(server, job)
        try:
            server.checkin(detect_software())  # reflect new versions immediately
        except Exception:
            pass

    was_active = None
    last_latest = 0.0  # when we last asked mx1 for latest-available versions
    last_health = 0.0  # when we last gathered GPU/disk/OS telemetry
    while True:
        sleep_for = interval
        watch_state["tick"] = time.time()   # prove the main loop is alive to the watchdog
        try:
            busy = job_state["thread"] is not None and job_state["thread"].is_alive()
            watch_state["busy_since"] = (watch_state["busy_since"] or time.time()) if busy else None
            # Lightweight heartbeat first — learn whether monitoring is switched on.
            resp = server.checkin(None)
            # Server asked us to reboot (fallback when Deadline RemoteControl can't reach us).
            if resp.get("reboot"):
                _reboot_machine()
                time.sleep(30)   # let the OS begin shutting down; the process dies with it
                continue
            active = resp.get("active", True)
            # Check-in cadence is server-controlled (≈ offline-threshold ÷ 3), so offline
            # detection speed is tunable from the server alone. Falls back to the local interval.
            sleep_for = resp.get("pollSeconds") or interval
            if active != was_active:
                print("Monitoring %s" % ("ON — reporting versions" if active else "OFF — standing by"))
                was_active = active

            # Self-update to the server's agent version (never mid-install).
            latest_agent = resp.get("latestAgent")
            if latest_agent and not busy and _version_tuple(latest_agent) > _version_tuple(AGENT_VERSION):
                print("Newer agent available: %s (have %s)" % (latest_agent, AGENT_VERSION))
                self_update(server, latest_agent)  # replaces process; only returns on failure

            if active:
                # Refresh latest-available versions ~every 30 min (hits Maxon, throttled).
                latest = None
                if not busy and time.time() - last_latest > 1800:
                    latest = {**detect_maxon_latest(), **detect_adobe_latest()}
                    last_latest = time.time()
                # Health/GPU telemetry ~every 5 min (cheap, but no need every minute).
                health = None
                if time.time() - last_health > 300:
                    health = detect_health()
                    last_health = time.time()
                # Always report software so the dashboard shows us online, even mid-install.
                resp = server.checkin(detect_software(), latest=latest, health=health)
                if not busy:
                    jobs = [j for j in resp.get("jobs", []) if j["status"] == "pending"]
                    if jobs:
                        print("%d job(s) queued — running in background" % len(jobs))
                        t = threading.Thread(target=run_jobs_bg, args=(jobs,), daemon=True)
                        t.start()
                        job_state["thread"] = t
            else:
                # Paused: poll more often (set by server) so we resume quickly.
                sleep_for = resp.get("pollSeconds", 20)
        except urllib.error.HTTPError as e:
            print("Server error %s: %s" % (e.code, e.read().decode()[:200]))
        except Exception as e:
            print("Check-in failed: %s" % e)

        if args.once:
            break
        time.sleep(sleep_for)


if __name__ == "__main__":
    main()
