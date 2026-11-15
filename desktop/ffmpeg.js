'use strict';
// FFmpeg for converting files (desktop/convert.js), fetched the first time
// someone converts a video, audio file or image instead of shipping in every
// installer: it's 45–80 MB, more than the rest of the app.
//
// It's the build ffmpeg-static publishes (FFmpeg 6–7, GPL v3), pinned by its
// SHA-256 so a changed or tampered download is refused. ShareSecure doesn't
// ship or change FFmpeg; its license and where its source is come down with it
// (ffmpeg.LICENSE, ffmpeg.README) and are on the Licenses page.
//
// Nothing here uses Electron, so the tests can run it in plain Node.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RELEASE = 'b6.1.1';   // ffmpeg-static's binary-release-tag
const BASE = `https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE}`;
// sha256 and size of each .gz this may download
const BUILDS = {
  'win32-x64': { sha256: '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77', size: 29581307 },
  'darwin-x64': { sha256: '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106', size: 25296431 },
  'darwin-arm64': { sha256: '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa', size: 19246198 },
  'linux-x64': { sha256: 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa', size: 29354986 },
  'linux-arm64': { sha256: '754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0', size: 25568691 },
};

// The build for this computer → { name, sha256, size } or null. Windows on ARM
// runs the x64 one: there's no ARM64 build, and Windows runs x64 programs itself.
function buildFor(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'arm64') arch = 'x64';
  const name = `${platform}-${arch}`;
  return BUILDS[name] ? { name, ...BUILDS[name] } : null;
}

const exeName = (platform = process.platform) => (platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

// Where it lives: one folder per release, so a newer pin downloads afresh.
function locate(dir, platform = process.platform) {
  return path.join(dir, RELEASE, exeName(platform));
}

const installed = dir => Boolean(dir) && fs.existsSync(locate(dir));

// Downloads, checks and unpacks it into dir → its path. fetchImpl is
// Electron's net.fetch in the app (it follows the computer's proxy settings).
async function install(dir, { fetchImpl = fetch, build = buildFor(), platform = process.platform } = {}) {
  if (!build) throw new Error('FFmpeg isn’t available for this computer.');
  const target = locate(dir, platform);
  const res = await fetchImpl(`${BASE}/ffmpeg-${build.name}.gz`);
  if (!res.ok) throw new Error(`FFmpeg download failed (HTTP ${res.status})`);
  const gz = Buffer.from(await res.arrayBuffer());
  const hash = crypto.createHash('sha256').update(gz).digest('hex');
  if (hash !== build.sha256) throw new Error('The FFmpeg download wasn’t the expected file, so it wasn’t used.');
  const binary = zlib.gunzipSync(gz);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  // written beside it and renamed, so a half-written file is never run
  const part = `${target}.part`;
  await fs.promises.writeFile(part, binary, { mode: 0o755 });
  await fs.promises.rename(part, target);
  // its license and build notes (with where its source code is), best effort
  for (const kind of ['LICENSE', 'README']) {
    try {
      const doc = await fetchImpl(`${BASE}/${build.name}.${kind}`);
      if (doc.ok) await fs.promises.writeFile(path.join(path.dirname(target), `ffmpeg.${kind}`), Buffer.from(await doc.arrayBuffer()));
    } catch {}
  }
  // older releases' copies aren't needed any more
  for (const old of await fs.promises.readdir(dir).catch(() => [])) {
    if (old !== RELEASE) await fs.promises.rm(path.join(dir, old), { recursive: true, force: true }).catch(() => {});
  }
  return target;
}

const downloadSize = () => buildFor()?.size || 0;

module.exports = { RELEASE, BUILDS, buildFor, locate, installed, install, downloadSize };
