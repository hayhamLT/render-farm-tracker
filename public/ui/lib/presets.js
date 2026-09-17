// Deploy knowledge copied VERBATIM from the classic dashboard (public/app.js) by script, so the
// new UI queues exactly the same install commands. Change both together until classic is retired.
// Generated sections: install presets + Adobe RUM, and the monogram tile colours.

// Generic macOS installer: .pkg direct, or .dmg (mount → run the .pkg inside → detach).
export const MACOS_PKG = 'F="{file}"; if echo "$F" | grep -qi "\\.dmg$"; then ' +
  'M=$(mktemp -d); hdiutil attach "$F" -nobrowse -mountpoint "$M" >/dev/null 2>&1; ' +
  'P=$(find "$M" -maxdepth 3 -name "*.pkg" | head -1); ' +
  'if [ -n "$P" ]; then installer -pkg "$P" -target /; R=$?; else echo "no .pkg in dmg"; R=1; fi; ' +
  'hdiutil detach "$M" >/dev/null 2>&1; exit $R; else installer -pkg "$F" -target /; fi';
// Maxon macOS: BitRock installer inside the .app — mount the .dmg, run installbuilder.sh
// unattended. Runs as root. (--skipMaxonAppGui was REMOVED in the 2026.3-era installers —
// passing it makes the installer exit 1 with "Unknown option".)
const MACOS_MAXON = 'F="{file}"; M=$(mktemp -d); hdiutil attach "$F" -nobrowse -mountpoint "$M" >/dev/null 2>&1; ' +
  'IB=$(find "$M" -maxdepth 4 -name installbuilder.sh | head -1); ' +
  'if [ -n "$IB" ]; then "$IB" --mode unattended --unattendedmodeui none; R=$?; ' +
  'else P=$(find "$M" -maxdepth 3 -name "*.pkg" | head -1); installer -pkg "$P" -target /; R=$?; fi; ' +
  'hdiutil detach "$M" >/dev/null 2>&1; exit $R';
// Windows Maxon (BitRock): plain unattended (no --skipMaxonAppGui — see note above).
const WIN_MAXON = '"{file}" --mode unattended --unattendedmodeui none';
// Adobe CC desktop (mac): the dmg holds an Install.app (NOT a pkg) — run its
// binary with Adobe's documented silent flag.
const MACOS_CC = 'F="{file}"; M=$(mktemp -d); hdiutil attach "$F" -nobrowse -mountpoint "$M" >/dev/null 2>&1; ' +
  'I=$(find "$M" -maxdepth 3 -path "*Install.app/Contents/MacOS/Install" | head -1); ' +
  'if [ -n "$I" ]; then "$I" --mode=silent; R=$?; ' +
  'else P=$(find "$M" -maxdepth 3 -name "*.pkg" | head -1); installer -pkg "$P" -target /; R=$?; fi; ' +
  'hdiutil detach "$M" >/dev/null 2>&1; exit $R';
// Redshift standalone disables its Cinema 4D plugin component by default —
// enable it so C4D actually renders with the new version, not its bundled one.
// (Only PLUGIN groups are valid here; the Redshift core always installs and
// "RedshiftCoreGroup" is rejected as an unknown component.)
const RS_COMPONENTS = ' --enable-components Cinema4DGroup,PluginC4D2026';
const WIN_RS = WIN_MAXON + RS_COMPONENTS;
const MACOS_RS = MACOS_MAXON.replace('--mode unattended --unattendedmodeui none; R=$?',
  '--mode unattended --unattendedmodeui none' + RS_COMPONENTS + '; R=$?');
// Blender macOS: .dmg holds Blender.app — mount, replace /Applications/Blender.app.
const MACOS_BLENDER = 'F="{file}"; M=$(mktemp -d); hdiutil attach "$F" -nobrowse -mountpoint "$M" >/dev/null 2>&1; ' +
  'A=$(find "$M" -maxdepth 2 -name "Blender.app" | head -1); ' +
  'if [ -n "$A" ]; then rm -rf /Applications/Blender.app; cp -R "$A" /Applications/; R=$?; else R=1; fi; ' +
  'hdiutil detach "$M" >/dev/null 2>&1; exit $R';
// FFmpeg is a static binary in a zip (no installer). Extract it to a tracker-managed,
// PATH-friendly location: C:\ProgramData\TrackerAgent\ffmpeg on Windows, /usr/local/bin on macOS.
const WIN_FFMPEG = 'rd /s /q "%TEMP%\\ffx" 2>nul & mkdir "%TEMP%\\ffx" & tar -xf "{file}" -C "%TEMP%\\ffx" & ' +
  'mkdir "C:\\ProgramData\\TrackerAgent\\ffmpeg" 2>nul & ' +
  'for /r "%TEMP%\\ffx" %i in (ffmpeg.exe ffprobe.exe) do copy /y "%i" "C:\\ProgramData\\TrackerAgent\\ffmpeg\\" >nul & ver >nul';
const MACOS_FFMPEG = 'F="{file}"; D=$(mktemp -d); unzip -o "$F" -d "$D" >/dev/null 2>&1; ' +
  'B=$(find "$D" -maxdepth 2 -name ffmpeg -type f | head -1); ' +
  'if [ -n "$B" ]; then mkdir -p /usr/local/bin; cp "$B" /usr/local/bin/ffmpeg; chmod +x /usr/local/bin/ffmpeg; R=$?; else R=1; fi; ' +
  'rm -rf "$D"; exit $R';
// Silent-install command defaults per product/OS, so users never type them.
export const INSTALL_PRESETS = {
  cinema4d:      { windows: WIN_MAXON, macos: MACOS_MAXON },
  redshift:      { windows: WIN_RS, macos: MACOS_RS },
  redgiant:      { windows: WIN_MAXON, macos: MACOS_MAXON },
  aftereffects:  { windows: '"{file}" --silent', macos: MACOS_PKG },
  // Maxon App: BitRock + its own extra switches (from Maxon's winget manifest) —
  // don't auto-launch the app after install, and self-elevate cleanly.
  maxonapp:      { windows: WIN_MAXON + ' --do_not_execute_maxonapp 1 --elevated 1',
                   macos: MACOS_MAXON.replace('--mode unattended --unattendedmodeui none; R=$?',
                     '--mode unattended --unattendedmodeui none --do_not_execute_maxonapp 1; R=$?') },
  creativecloud: { windows: '"{file}" --silent', macos: MACOS_CC },
  blender:       { windows: 'msiexec /i "{file}" /qn /norestart', macos: MACOS_BLENDER },
  ffmpeg:        { windows: WIN_FFMPEG, macos: MACOS_FFMPEG },
  notchlc:       { windows: '"{file}" /S', macos: MACOS_PKG },  // NSIS silent (Win) / .pkg (Mac)
  nvidia:        { windows: '"{file}" -s -noreboot' },   // NVIDIA setup: silent in-place upgrade, no surprise reboot (Win-only; no -clean so a failed install keeps the old driver)
};
export const presetCommand = (k, os) => (INSTALL_PRESETS[k] && INSTALL_PRESETS[k][os]) || (os === 'macos' ? MACOS_PKG : '"{file}"');

// After Effects has no normal vendor installer in the staged/link flow — it
// patches in place via Adobe Remote Update Manager. The binaries are staged in
// installers/. (Creative Cloud desktop is NOT here: Adobe self-updates it and the
// enterprise package can't set its version — see SELF_UPDATING.)
// Persist RUM to a fixed path on first AE update so detect_adobe_latest can use it
// later (Windows nodes have the Adobe stack but no permanent RUM otherwise).
// AEFT = After Effects, AME = Adobe Media Encoder. Always patch them together (RUM
// only updates products already installed, so AME is a no-op where it isn't present).
const RUM_AE_WIN = 'copy /y "{file}" "C:\\ProgramData\\TrackerAgent\\RemoteUpdateManager.exe" >nul & '
  + '"C:\\ProgramData\\TrackerAgent\\RemoteUpdateManager.exe" --productVersions=AEFT,AME --action=install';
// Windows nodes that have AE already carry the Adobe updater stack, so RUM.exe runs
// standalone from the downloaded file.
// macOS: the agent runs as root. The Mac Admin Console pkg carries RUM + the stack;
// install it only if RUM isn't present yet, then patch AE — fully self-bootstrapping.
const RUM_AE_MAC = 'if [ ! -x /usr/local/bin/RemoteUpdateManager ]; then installer -pkg "{file}" -target /; fi; '
  + '/usr/local/bin/RemoteUpdateManager --productVersions=AEFT,AME --action=install';
export const ADOBE_RUM = {
  aftereffects: {
    windows: { filename: 'RemoteUpdateManager.exe',  command: RUM_AE_WIN, how: 'updates After Effects + Media Encoder via Adobe RUM' },
    macos:   { filename: 'Adobe_CC_No-Apps_Mac.pkg', command: RUM_AE_MAC, how: 'updates After Effects + Media Encoder via Adobe RUM' },
  },
};

export const TILE = {
  aftereffects:  ['Ae',  '#2b2250', '#cfb3ff'],
  creativecloud: ['CC',  '#4a1010', '#ff9d9d'],
  cinema4d:      ['C4D', '#0d2d57', '#8ec5ff'],
  maxonapp:      ['MX',  '#3c1030', '#ff9ad5'],
  redgiant:      ['RG',  '#4a2010', '#ffb38f'],
  redshift:      ['RS',  '#451310', '#ff9d8f'],
  blender:       ['Bl',  '#2a1c06', '#ffb04d'],
  ffmpeg:        ['FF',  '#0c2a1c', '#5ad18f'],
  notchlc:       ['NL',  '#0a2230', '#5fd0e6'],
  nvidia:        ['NV',  '#16280a', '#76b900'],   // NVIDIA green
};
