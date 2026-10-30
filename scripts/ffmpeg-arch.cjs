'use strict';
// electron-builder afterPack hook: gives each packed app the ffmpeg for its
// own processor (desktop/convert.js). ffmpeg-static downloads one for the
// machine npm ran on, but the Mac build makes Intel and Apple Silicon apps on
// one machine. Windows on ARM keeps the x64 one: there's no ARM64 build, and
// Windows runs x64 programs itself.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Arch } = require('electron-builder');

const RELEASE = 'b6.1.1';   // ffmpeg-static's binary-release-tag
// sha256 of each download this hook may need, so a changed file fails the build
const SHA256 = {
  'darwin-x64': '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106',
};

exports.default = async function ffmpegForArch(context) {
  const platform = context.electronPlatformName;
  let arch = Arch[context.arch];
  if (platform === 'win32' && arch === 'arm64') arch = 'x64';
  if (platform === process.platform && arch === process.arch) return;   // npm already fetched it

  const want = `${platform}-${arch}`;
  if (!SHA256[want]) throw new Error(`No ffmpeg pinned for ${want}: add its sha256 to scripts/ffmpeg-arch.cjs`);
  const resources = platform === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const target = path.join(resources, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

  const res = await fetch(`https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE}/ffmpeg-${want}.gz`);
  if (!res.ok) throw new Error(`ffmpeg ${want}: HTTP ${res.status}`);
  const gz = Buffer.from(await res.arrayBuffer());
  const hash = crypto.createHash('sha256').update(gz).digest('hex');
  if (hash !== SHA256[want]) throw new Error(`ffmpeg ${want}: unexpected sha256 ${hash}`);
  fs.writeFileSync(target, zlib.gunzipSync(gz), { mode: 0o755 });
  console.log(`  • ffmpeg replaced with ${want}`);
};
