'use strict';
// electron-builder afterPack hook: puts Electron's and Chromium's license
// notices into Mac apps. Windows and Linux builds keep them next to the app,
// but electron-builder deletes them from a Mac app, and Chromium's BSD-style
// license asks that copies of the program carry them.
//
// They're taken from Electron's npm package when it has them, and otherwise
// from Electron's own download (the one npm install already fetched and
// checked against electron/checksums.json), so a build never goes out without.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const FILES = { LICENSE: 'LICENSE.electron.txt', 'LICENSES.chromium.html': 'LICENSES.chromium.html' };

// Each notice's bytes, from dist or from Electron's zip for `platform` → { name: Buffer }
async function readNotices(platform = 'darwin', arch = process.arch) {
  const electronDir = path.dirname(require.resolve('electron/package.json'));
  const out = {};
  let zip = null;
  for (const name of Object.keys(FILES)) {
    const local = path.join(electronDir, 'dist', name);
    if (fs.existsSync(local)) { out[name] = fs.readFileSync(local); continue; }
    if (!zip) {
      const { downloadArtifact } = await import('@electron/get');
      zip = await downloadArtifact({
        version: require('electron/package.json').version,
        artifactName: 'electron',
        platform,
        arch,
        checksums: require('electron/checksums.json'),
      });
    }
    out[name] = execFileSync('unzip', ['-p', zip, name], { maxBuffer: 256 * 1024 * 1024 });
    if (!out[name].length) throw new Error(`${name} isn't in Electron's download`);
  }
  return out;
}

exports.default = async function macLicenses(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const resources = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources');
  const notices = await readNotices();
  for (const [name, to] of Object.entries(FILES)) fs.writeFileSync(path.join(resources, to), notices[name]);
  console.log('  • Electron and Chromium license notices added');
};

exports.readNotices = readNotices;
