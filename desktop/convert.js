'use strict';
// Converting a file before it's shared, on this computer only (the desktop
// app). Some files can't be shared as they are (an iPhone HEIC photo, an MKV
// video, a FLAC song), and some are better in another format (a MOV the
// viewer plays as MP4, a WAV that's smaller as MP3). The kind of file is
// worked out from its bytes, like public/filetypes.js, never from its name.
//
// FFmpeg does almost all of it. It isn't in the installer: desktop/ffmpeg.js
// fetches it the first time it's needed, once the person agrees. HEIC photos
// go through heic-convert (FFmpeg can't read them), so an iPhone photo becomes
// a JPEG or PNG without FFmpeg at all. Nothing leaves this computer, and
// metadata (camera, place, dates) is left out of every converted file.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpeg = require('./ffmpeg');

// heic-convert is an optional dependency (self-hosted installs leave it out)
let HEIC = false;
try { require.resolve('heic-convert'); HEIC = true; } catch {}

// Where FFmpeg is kept, how to ask before fetching it and what to fetch it
// with (set by main.js), or a binary to use as it is (the tests).
const config = { dir: null, ffmpegPath: null, confirm: async () => false, fetchImpl: undefined };
function setup(options) { Object.assign(config, options); }

const canUseFfmpeg = () => Boolean(config.ffmpegPath || (config.dir && ffmpeg.buildFor()));
// what a HEIC photo becomes without FFmpeg, in heic-convert's words
const HEIC_DIRECT = { jpg: 'JPEG', png: 'PNG' };

// What each format is called, and how FFmpeg makes it
const TARGETS = {
  jpg: { label: 'JPEG image', args: ['-frames:v', '1', '-q:v', '2'] },
  png: { label: 'PNG image', args: ['-frames:v', '1'] },
  webp: { label: 'WebP image', args: ['-frames:v', '1', '-c:v', 'libwebp', '-quality', '90'] },
  // even sizes and yuv420p, or some players (and phones) refuse H.264
  mp4: { label: 'MP4 video', args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'] },
  webm: { label: 'WebM video', args: ['-c:v', 'libvpx-vp9', '-crf', '33', '-b:v', '0', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-c:a', 'libopus', '-b:a', '128k'] },
  mp3: { label: 'MP3 audio', args: ['-vn', '-c:a', 'libmp3lame', '-q:a', '2'] },
  m4a: { label: 'M4A audio', args: ['-vn', '-c:a', 'aac', '-b:a', '192k'] },
  wav: { label: 'WAV audio', args: ['-vn', '-c:a', 'pcm_s16le'] },
};
const FOR_KIND = {
  image: ['jpg', 'png', 'webp'],
  animation: ['mp4', 'png', 'jpg'],
  video: ['mp4', 'webm', 'mp3'],
  audio: ['mp3', 'm4a', 'wav'],
};

const ascii = (b, from, to) => b.subarray(from, to).toString('latin1');

// A file's format from its first bytes → { kind, format, label } or null.
// format is the extension it would have.
function identify(head) {
  const b = Buffer.from(head);
  const is = (format, kind, label) => ({ format, kind, label });
  if (ascii(b, 4, 8) === 'ftyp') {
    const brands = ascii(b, 8, Math.min(b.length, 64));
    const major = brands.slice(0, 4);
    if (/avi[fs]/.test(brands) && !/^(heic|heix)/.test(major)) return is('avif', 'image', 'AVIF image');
    if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(major)) return is('heic', 'heic', 'HEIC photo');
    if (major === 'qt  ') return is('mov', 'video', 'QuickTime video');
    if (/^M4[AB] /.test(major)) return is('m4a', 'audio', 'M4A audio');
    if (/^3g/.test(major)) return is('3gp', 'video', '3GP video');
    return is('mp4', 'video', 'MP4 video');
  }
  if (b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') return is('png', 'image', 'PNG image');
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return is('jpg', 'image', 'JPEG image');
  if (/^GIF8[79]a/.test(ascii(b, 0, 6))) return is('gif', 'animation', 'GIF');
  if (ascii(b, 0, 2) === 'BM') return is('bmp', 'image', 'BMP image');
  if (ascii(b, 0, 4) === 'II*\0' || ascii(b, 0, 4) === 'MM\0*') return is('tiff', 'image', 'TIFF image');
  if (ascii(b, 0, 4) === '8BPS') return is('psd', 'image', 'Photoshop image');
  if (b.length > 6 && b.readUInt32BE(0) === 0x00000100 && b.readUInt16LE(4) > 0) return is('ico', 'image', 'Icon');
  if (ascii(b, 0, 4) === 'RIFF') {
    const sub = ascii(b, 8, 12);
    if (sub === 'WEBP') return is('webp', 'image', 'WebP image');
    if (sub === 'WAVE') return is('wav', 'audio', 'WAV audio');
    if (sub === 'AVI ') return is('avi', 'video', 'AVI video');
  }
  if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) {
    return ascii(b, 0, 64).includes('webm') ? is('webm', 'video', 'WebM video') : is('mkv', 'video', 'MKV video');
  }
  if (ascii(b, 0, 3) === 'FLV') return is('flv', 'video', 'Flash video');
  // ASF holds Windows Media video and audio alike: its header lists each
  // stream's media type, and a file with no video stream is audio
  if (b.length > 4 && b.readUInt32BE(0) === 0x3026B275) {
    const hasVideo = b.includes(Buffer.from('C0EF19BC4D5BCF11A8FD00805F5C442B', 'hex'));
    const hasAudio = b.includes(Buffer.from('409E69F84D5BCF11A8FD00805F5C442B', 'hex'));
    return hasAudio && !hasVideo ? is('wma', 'audio', 'Windows Media audio') : is('wmv', 'video', 'Windows Media video');
  }
  if (b.length > 4 && b.readUInt32BE(0) === 0x000001BA) return is('mpg', 'video', 'MPEG video');
  if (b[0] === 0x47 && b[188] === 0x47) return is('ts', 'video', 'MPEG-TS video');
  if (ascii(b, 0, 4) === 'fLaC') return is('flac', 'audio', 'FLAC audio');
  if (ascii(b, 0, 4) === 'OggS') return is('ogg', 'audio', 'Ogg audio');
  if (ascii(b, 0, 4) === 'FORM' && /^AIF[FC]$/.test(ascii(b, 8, 12))) return is('aiff', 'audio', 'AIFF audio');
  if (ascii(b, 0, 5) === '#!AMR') return is('amr', 'audio', 'AMR audio');
  if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xFF && (b[1] & 0xE6) === 0xE2)) return is('mp3', 'audio', 'MP3 audio');
  if (b[0] === 0xFF && (b[1] & 0xF6) === 0xF0) return is('aac', 'audio', 'AAC audio');
  return null;
}

// What a file can be turned into → { kind, format, label, targets: [{ ext, label }] } or null
function optionsFor(head) {
  const found = identify(head);
  if (!found) return null;
  const heic = found.kind === 'heic';
  if (heic && !HEIC) return null;
  const kind = heic ? 'image' : found.kind;
  const targets = FOR_KIND[kind]
    .filter(ext => ext !== found.format)
    .filter(ext => canUseFfmpeg() || (heic && HEIC_DIRECT[ext]))
    .map(ext => ({ ext, label: TARGETS[ext].label }));
  return targets.length ? { ...found, kind, targets } : null;
}

// ── getting FFmpeg ──────────────────────────────────────────────────────────
// Asked for (and downloaded) once; everyone converting meanwhile waits on the
// same download.
let fetching = null;
const cancelled = () => Object.assign(new Error('cancelled'), { code: 'cancelled' });

async function ffmpegPath() {
  if (config.ffmpegPath) return config.ffmpegPath;
  if (!config.dir || !ffmpeg.buildFor()) throw new Error('FFmpeg isn’t available for this computer.');
  if (ffmpeg.installed(config.dir)) return ffmpeg.locate(config.dir);
  fetching ||= (async () => {
    if (!(await config.confirm(ffmpeg.downloadSize()))) throw cancelled();
    return ffmpeg.install(config.dir, { fetchImpl: config.fetchImpl });
  })().finally(() => { fetching = null; });
  return fetching;
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { windowsHide: true, maxBuffer: 1 << 20 }, err => (err ? reject(err) : resolve()));
  });
}

// One conversion at a time: a video can keep every core busy for minutes.
let busy = Promise.resolve();

// Converts a file (by its path, or its bytes when it has none) → { bytes, name }.
// Rejects with code 'cancelled' if FFmpeg was needed and the person said no.
// The working copies live in a private temporary folder that's always emptied.
function convert({ filePath, bytes, name, to }) {
  const target = TARGETS[to];
  if (!target) return Promise.reject(new Error('unknown format'));
  const job = busy.then(async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sharesecure-'));
    try {
      let input = filePath;
      if (!input) {
        input = path.join(dir, 'in');
        await fs.promises.writeFile(input, Buffer.from(bytes));
      }
      const head = Buffer.alloc(4096);
      const fd = await fs.promises.open(input, 'r');
      try { await fd.read(head, 0, head.length, 0); } finally { await fd.close(); }
      const found = identify(head);
      if (!found) throw new Error('unknown file');
      const base = String(name || 'file').replace(/\.[^.]{1,10}$/, '') || 'file';
      const output = { name: `${base}.${to}` };
      if (found.kind === 'heic') {
        if (!HEIC) throw new Error('HEIC isn’t available');
        const heic = require('heic-convert');
        const buffer = await fs.promises.readFile(input);
        // straight to JPEG or PNG: decoded pixels carry no metadata
        if (HEIC_DIRECT[to]) return { ...output, bytes: new Uint8Array(await heic({ buffer, format: HEIC_DIRECT[to], quality: 0.92 })) };
        // anything else goes through a lossless PNG, which FFmpeg can make it from
        input = path.join(dir, 'decoded.png');
        await fs.promises.writeFile(input, Buffer.from(await heic({ buffer, format: 'PNG' })));
      }
      const out = path.join(dir, `out.${to}`);
      await run(await ffmpegPath(), ['-i', input, '-map_metadata', '-1', ...target.args, out]);
      return { ...output, bytes: new Uint8Array(await fs.promises.readFile(out)) };
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
  busy = job.catch(() => {});
  return job;
}

module.exports = { identify, optionsFor, convert, setup, TARGETS };
