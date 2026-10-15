// Maxon's downloads pages, 2026-10-14: Cinema 4D 2027 was on its own "cinema-4d-2027-downloads" page that a fixed "2026"
// never read, and Redshift 2027.0.1 was on the main page while the release notes still said 2027.0.0.
const test = require('node:test');
const assert = require('node:assert');
const { downloadsPages, pickInstallerUrl, urlVersion, INSTALLER_KEYWORDS } = require('../lib/maxon_versions');

const B = 'https://mx-app-blob-prod.maxon.net/mx-package-production/installer';
const URLS = [
  `${B}/macos/maxon/cinema4d/releases/2027.0.0/Cinema4D_2027_2027.0_Mac.dmg`,
  `${B}/windows/maxon/cinema4d/releases/2027.0.0/Cinema4D_2027_2027.0_Win.exe`,
  `${B}/winarm/maxon/cinema4d/releases/2027.0.0/Cinema4D_2027_2027.0_WinArm.exe`,
  'https://installer.maxon.net/installer/rs/redshift_2027.0.1_2938502628_macos.dmg',
  'https://installer.maxon.net/installer/rs/redshift_2027.0.1_2938502628_macos_min.dmg',
  'https://installer.maxon.net/installer/rs/redshift_2027.0.1_2938502628_win_x64.exe',
  'https://installer.maxon.net/installer/rs/redshift_2027.0.1_2938502628_win_arm64.exe',
  'https://installer.maxon.net/installer/rs/redshift_2026.6.0_111_win_x64.exe',
  `${B}/windows/maxon/redgiant/releases/2027.0.0/RedGiant-2027.0.0_Win.exe`,
];

test('the Cinema 4D page follows the newest year, this year and next', () => {
  const pages = downloadsPages('2027.0.0', new Date('2026-10-14'));
  assert.ok(pages.includes('https://www.maxon.net/en/downloads'));
  for (const y of [2026, 2027]) assert.ok(pages.includes(`https://www.maxon.net/en/downloads/cinema-4d-${y}-downloads`), y);
  assert.ok(downloadsPages(null, new Date('2027-02-01')).includes('https://www.maxon.net/en/downloads/cinema-4d-2028-downloads'));
});

test('Cinema 4D 2027 is picked for each OS, no Arm build', () => {
  assert.match(pickInstallerUrl(URLS, INSTALLER_KEYWORDS.cinema4d, '2027.0.0', 'macos'), /Cinema4D_2027_2027\.0_Mac\.dmg$/);
  assert.match(pickInstallerUrl(URLS, INSTALLER_KEYWORDS.cinema4d, '2027.0.0', 'windows'), /Cinema4D_2027_2027\.0_Win\.exe$/);
});

test('a newer Redshift on the page than the release notes said is taken, never an older one or a _min', () => {
  assert.match(pickInstallerUrl(URLS, INSTALLER_KEYWORDS.redshift, '2027.0.0', 'windows'), /redshift_2027\.0\.1_.*_win_x64\.exe$/);
  assert.match(pickInstallerUrl(URLS, INSTALLER_KEYWORDS.redshift, '2027.0.0', 'macos'), /redshift_2027\.0\.1_.*_macos\.dmg$/);
  assert.strictEqual(pickInstallerUrl(URLS, INSTALLER_KEYWORDS.redshift, '2027.1.0', 'windows'), null);
  assert.strictEqual(urlVersion(URLS[0]), '2027.0.0');
  assert.strictEqual(urlVersion(URLS[3]), '2027.0.1');
});
