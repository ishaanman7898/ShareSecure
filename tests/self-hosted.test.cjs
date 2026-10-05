'use strict';
// The self-hosted server (server/): what it accepts, what it stores, and its MCP tools.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sharesecure-selfhost-'));
process.env.DATA_DIR = temp;
process.env.ENCRYPTION_KEY = '17'.repeat(32);
process.env.USE_LOCAL_TUNNEL = 'false';

const root = path.resolve(__dirname, '..');
const express = require(path.join(root, 'node_modules', 'express'));
const { db, UPLOADS_DIR } = require(path.join(root, 'server', 'db.js'));
const utils = require(path.join(root, 'server', 'utils.js'));
const { storeFile } = require(path.join(root, 'server', 'routes', 'files.js'));
const mcp = require(path.join(root, 'server', 'mcp.js'));

after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

const store = (bytes, originalname, extra = {}) => storeFile(
  { buffer: Buffer.from(bytes), originalname, size: bytes.length, mimetype: extra.mimetype },
  { expires_hours: '1', allow_download: '1', display_name: extra.display_name || '' },
);

// the bytes as stored on disk, decrypted and decompressed again
function readBack(shortId) {
  const row = db.prepare('SELECT * FROM files WHERE short_id = ?').get(shortId);
  const onDisk = fs.readFileSync(path.join(UPLOADS_DIR, row.stored_filename));
  return { row, onDisk, bytes: utils.decompress(utils.decryptWithPerFileKey(onDisk, row.wrapped_key, utils.getEncKey())) };
}

// a ZIP of stored (uncompressed) entries
function zip(entries) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xFFFFFFFF; for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text), nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034B50, 0); lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc(data), 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ce = Buffer.alloc(46); ce.writeUInt32LE(0x02014B50, 0); ce.writeUInt16LE(20, 4); ce.writeUInt16LE(20, 6);
    ce.writeUInt32LE(crc(data), 16); ce.writeUInt32LE(data.length, 20); ce.writeUInt32LE(data.length, 24); ce.writeUInt16LE(nameBuf.length, 28); ce.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, data); centrals.push(ce, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054B50, 0);
  end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

const PNG = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D4944415478DA63F8CFC0F01F0005000201E2C2D6E80000000049454E44AE426082', 'hex');

test('uploads are checked by their bytes, and the shown name always ends in the real type', async () => {
  const png = await store(PNG, 'chart.exe');
  assert(!png.error, png.error);
  assert.equal(png.displayName, 'chart.png');

  const md = await store(Buffer.from('# Notes'), 'notes.md', { display_name: 'evil.html' });
  assert.equal(md.displayName, 'evil.md');

  const fakePdf = await store(Buffer.from('<html>not a pdf</html>'), 'report.pdf');
  assert.equal(fakePdf.status, 415);

  const plainZip = await store(zip({ 'readme.txt': 'hi' }), 'archive.docx');
  assert.equal(plainZip.status, 415, 'a ZIP that isn’t a Word document is refused');

  const utf16 = await store(Buffer.from('﻿hello', 'utf16le'), 'notes.txt');
  assert.match(utf16.error, /UTF-8/);
});

test('stored files are encrypted at rest, with PDF and Word metadata stripped', async () => {
  const pdf = await store(Buffer.from('%PDF-1.4\n1 0 obj << /Author (Jane Doe) /Producer <4A616E65> >> endobj\n%%EOF'), 'cv.pdf');
  const back = readBack(pdf.shortId);
  assert(!back.onDisk.includes('Jane Doe') && !back.onDisk.includes('%PDF'), 'nothing readable on disk');
  assert.equal(back.row.encrypted, 1);
  const text = back.bytes.toString('latin1');
  assert.match(text, /\/Author \(\)/);
  assert.match(text, /\/Producer <>/);

  const docx = await store(zip({ 'word/document.xml': '<w:document/>', 'docProps/core.xml': '<dc:creator>Jane Doe</dc:creator>' }), 'letter.docx');
  assert(!docx.error, docx.error);
  const docBytes = readBack(docx.shortId).bytes;
  assert(!docBytes.includes('Jane Doe'));
  assert(docBytes.includes('word/document.xml'));
});

test('encryption helpers round-trip, and the master key wraps a fresh key per file', () => {
  const key = utils.getEncKey(), msg = Buffer.from('hello');
  const a = utils.encryptWithPerFileKey(msg, key), b = utils.encryptWithPerFileKey(msg, key);
  assert.notEqual(a.wrappedKey, b.wrappedKey);
  assert(utils.decryptWithPerFileKey(a.data, a.wrappedKey, key).equals(msg));
  assert.throws(() => utils.decryptWithPerFileKey(a.data, b.wrappedKey, key));
  assert.equal(utils.decryptString(utils.encryptString('héllo', key), key), 'héllo');
});

test('MCP: shares text and files, refuses fakes, and takes chunked uploads', async () => {
  const token = mcp.createToken();
  const app = express();
  app.use('/mcp', mcp.router);
  const server = app.listen(0);
  try {
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    const rpc = async (method, params, auth = token) => (await (await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })).json());
    const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;

    assert.equal((await rpc('tools/list', {}, 'ss_wrong')).error.code, -32001);
    const init = (await rpc('initialize', {})).result;
    assert.match(init.instructions, /call list_shares before trying again/);
    assert.match(init.serverInfo.icons[0].src, /\/app-icon\.png$/);
    const names = (await rpc('tools/list', {})).result.tools.map(t => t.name);
    assert.deepEqual(names, ['share_text', 'share_file', 'begin_upload', 'upload_chunk', 'finish_upload', 'send_share', 'list_shares', 'delete_share']);

    const text = await call('share_text', { text: '# Hi', title: 'Q3 / Q4' });
    assert(!text.isError, JSON.stringify(text));
    assert.equal(text.structuredContent.name, 'Q3 - Q4.md');

    const png = await call('share_file', { content_base64: PNG.toString('base64'), filename: 'chart' });
    assert.equal(png.structuredContent.name, 'chart.png');
    assert.match((await call('share_file', { content_base64: Buffer.from('<html>').toString('base64'), filename: 'x.pdf' })).content[0].text, /isn’t a real PDF/);
    assert.match((await call('share_file', { content_base64: '!!!', filename: 'a.txt' })).content[0].text, /isn’t valid base64/);

    const begun = await call('begin_upload', { filename: 'notes', size: 5 });
    const uploadId = /upload_id: (\S+)/.exec(begun.content[0].text)[1];
    await call('upload_chunk', { upload_id: uploadId, index: 0, data_base64: Buffer.from('hello').toString('base64') });
    const done = await call('finish_upload', { upload_id: uploadId });
    assert.equal(done.structuredContent.name, 'notes.txt');
    assert.equal(readBack(done.structuredContent.id).bytes.toString(), 'hello');

    // with no account linked, sending reports what to do instead of failing the share
    const sent = await call('share_text', { text: 'for bob', title: 'Hi', send_to: ['bob'] });
    assert(!sent.isError);
    assert.match(sent.content[0].text, /No ShareSecure account is linked/);
  } finally {
    server.close();
  }
});
