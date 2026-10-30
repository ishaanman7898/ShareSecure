'use strict';
// Converting files in the desktop app (desktop/convert.js). What matters here:
// a file ShareSecure can't take is recognised from its bytes, and what comes
// out of a conversion is something ShareSecure takes (public/filetypes.js).
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const converter = require(path.join(root, 'desktop', 'convert.js'));
let ffmpeg = null;
try { ffmpeg = require('ffmpeg-static'); } catch {}
const skip = !ffmpeg && 'ffmpeg-static is not installed';

let detectType;
before(async () => {
  ({ detectType } = await import(pathToFileURL(path.join(root, 'public', 'filetypes.js')).href));
});

const head = (...parts) => {
  const b = Buffer.alloc(512);
  let at = 0;
  for (const p of parts) { const x = Buffer.from(p, 'latin1'); x.copy(b, at); at += x.length; }
  return b;
};

test('files are recognised from their bytes, whatever they’re called', () => {
  assert.equal(converter.identify(head('\0\0\0\x18ftypheic\0\0\0\0mif1heic')).kind, 'heic');
  assert.equal(converter.identify(head('\0\0\0\x1cftypavif\0\0\0\0avifmif1')).format, 'avif');
  assert.equal(converter.identify(head('\0\0\0\x14ftypqt  ')).format, 'mov');
  assert.equal(converter.identify(head('\x1A\x45\xDF\xA3\x01\0\0\0matroska')).format, 'mkv');
  assert.equal(converter.identify(head('\x1A\x45\xDF\xA3\x01\0\0\0webm')).format, 'webm');
  assert.equal(converter.identify(head('RIFF\0\0\0\0AVI LIST')).format, 'avi');
  assert.equal(converter.identify(head('fLaC')).format, 'flac');
  assert.equal(converter.identify(head('BM')).format, 'bmp');
  assert.equal(converter.identify(head('II*\0')).format, 'tiff');
  assert.equal(converter.identify(head('%PDF-1.7')), null);
  assert.equal(converter.identify(head('hello, world')), null);
});

test('a file is never offered its own format', { skip }, () => {
  const png = converter.optionsFor(head('\x89PNG\r\n\x1a\n'));
  assert.deepEqual(png.targets.map(t => t.ext), ['jpg', 'webp']);
  assert.equal(converter.optionsFor(head('fLaC')).targets.some(t => t.ext === 'flac'), false);
});

test('converted files are ones ShareSecure takes, with no metadata left in', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharesecure-convert-'));
  try {
    const make = (name, ...args) => {
      execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args, '-metadata', 'title=secret place', path.join(dir, name)]);
      return path.join(dir, name);
    };
    const mkv = make('clip.mkv', '-f', 'lavfi', '-i', 'testsrc=size=321x241:rate=10', '-f', 'lavfi', '-i', 'sine', '-t', '1', '-c:v', 'libx264', '-c:a', 'aac');
    const flac = make('song.flac', '-f', 'lavfi', '-i', 'sine', '-t', '1');
    const bmp = make('scan.bmp', '-f', 'lavfi', '-i', 'testsrc=size=64x64', '-frames:v', '1');
    // Windows Media audio and video share a container; only video is offered video formats
    const kindOf = file => converter.identify(fs.readFileSync(file).subarray(0, 4096)).kind;
    assert.equal(kindOf(make('voice.wma', '-f', 'lavfi', '-i', 'sine', '-t', '1')), 'audio');
    assert.equal(kindOf(make('clip.wmv', '-f', 'lavfi', '-i', 'testsrc', '-t', '1')), 'video');
    assert.equal(kindOf(make('clip.ts', '-f', 'lavfi', '-i', 'testsrc', '-t', '1')), 'video');
    for (const file of [mkv, flac, bmp]) {
      const bytes = fs.readFileSync(file);
      assert.equal(detectType(bytes, path.basename(file), ''), null, `${file} isn't taken as it is`);
      const { targets } = converter.optionsFor(bytes.subarray(0, 4096));
      for (const { ext } of targets) {
        // by path, as a picked file goes; by bytes, as a pasted one does
        const out = await converter.convert(ext === targets[0].ext ? { bytes, name: path.basename(file), to: ext } : { filePath: file, name: path.basename(file), to: ext });
        assert.equal(out.name, path.basename(file).replace(/\.\w+$/, `.${ext}`));
        assert.ok(detectType(out.bytes, out.name, ''), `${out.name} is taken`);
        assert.equal(Buffer.from(out.bytes).includes('secret place'), false, `${out.name} has no metadata`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown format is refused', { skip }, async () => {
  await assert.rejects(converter.convert({ bytes: new Uint8Array(8), name: 'x', to: 'exe' }));
  await assert.rejects(converter.convert({ bytes: new TextEncoder().encode('plain text'), name: 'x.txt', to: 'png' }));
});
