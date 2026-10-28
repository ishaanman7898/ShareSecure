// Just enough ZIP for ShareSecure: list what's in one (to tell a Word file from
// a spreadsheet from a plain archive), open its entries in the viewer, and pack
// several files into one share. Shared by the browser, both backends and the
// local MCP server, so it has no dependencies.

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;
const ZIP64_LOCATOR = 0x07064b50, ZIP64_EOCD = 0x06064b50;

// ── CRC-32, which every ZIP entry carries ────────────────────────────────────
let table;
export function crc32(bytes) {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const view = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
const utf8 = new TextDecoder('utf-8');
const latin1 = new TextDecoder('windows-1252');

// ── reading ──────────────────────────────────────────────────────────────────
// The list of entries sits at the end of a ZIP, so this only reads the end,
// never the whole file. → [{ name, method, size, compressedSize, offset, crc, dir }]
// or null if it isn't a ZIP it can read.
export function listEntries(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 22) return null;
  const dv = view(b);
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xFFFF); i--) {
    if (dv.getUint32(i, true) === EOCD) { end = i; break; }
  }
  if (end < 0) return null;
  let count = dv.getUint16(end + 10, true);
  let start = dv.getUint32(end + 16, true);
  // ZIP64: the real numbers are in a second record just before this one
  if ((count === 0xFFFF || start === 0xFFFFFFFF) && end >= 20 && dv.getUint32(end - 20, true) === ZIP64_LOCATOR) {
    const at = Number(dv.getBigUint64(end - 12, true));
    if (at + 56 > b.length || dv.getUint32(at, true) !== ZIP64_EOCD) return null;
    count = Number(dv.getBigUint64(at + 32, true));
    start = Number(dv.getBigUint64(at + 48, true));
  }
  if (count > 65535 * 16) return null;

  const entries = [];
  let p = start;
  for (let n = 0; n < count; n++) {
    if (p + 46 > b.length || dv.getUint32(p, true) !== CENTRAL) return null;
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    let compressedSize = dv.getUint32(p + 20, true);
    let size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    let offset = dv.getUint32(p + 42, true);
    const rawName = b.subarray(p + 46, p + 46 + nameLen);
    // bit 11 says the name is UTF-8; older tools wrote the DOS code page
    const name = (flags & 0x800 ? utf8 : latin1).decode(rawName);
    // ZIP64 sizes and offset live in an extra field
    let q = p + 46 + nameLen;
    const extraEnd = q + extraLen;
    while (q + 4 <= extraEnd) {
      const id = dv.getUint16(q, true), len = dv.getUint16(q + 2, true);
      if (id === 1) {
        let r = q + 4;
        if (size === 0xFFFFFFFF) { size = Number(dv.getBigUint64(r, true)); r += 8; }
        if (compressedSize === 0xFFFFFFFF) { compressedSize = Number(dv.getBigUint64(r, true)); r += 8; }
        if (offset === 0xFFFFFFFF) { offset = Number(dv.getBigUint64(r, true)); }
      }
      q += 4 + len;
    }
    entries.push({ name, method, size, compressedSize, offset, crc, encrypted: Boolean(flags & 1), dir: name.endsWith('/') });
    p = extraEnd + commentLen;
  }
  return entries;
}

// One entry's bytes. Stored and deflated entries open; anything else (and
// password-protected entries) throws.
export async function readEntry(bytes, entry) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = view(b);
  if (entry.encrypted) throw new Error('This file in the ZIP has its own password.');
  if (dv.getUint32(entry.offset, true) !== LOCAL) throw new Error('Damaged ZIP');
  const at = entry.offset + 30 + dv.getUint16(entry.offset + 26, true) + dv.getUint16(entry.offset + 28, true);
  const data = b.subarray(at, at + entry.compressedSize);
  let out;
  if (entry.method === 0) out = data;
  else if (entry.method === 8) {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    out = new Uint8Array(await new Response(stream).arrayBuffer());
  } else throw new Error('This file in the ZIP is packed in a way the viewer can’t open.');
  if (out.length !== entry.size || crc32(out) !== entry.crc) throw new Error('Damaged ZIP');
  return out;
}

// ── writing ──────────────────────────────────────────────────────────────────
// Packs files into a ZIP: [{ name: 'folder/file.pdf', bytes }]. Each is
// compressed when that makes it smaller. Times are left at 1980-01-01, so the
// ZIP doesn't say when anything was made. → Uint8Array
export async function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const { name, bytes } of files) {
    const nameBytes = enc.encode(name);
    const crc = crc32(bytes);
    let data = bytes, method = 0;
    if (typeof CompressionStream !== 'undefined' && bytes.length > 256) {
      const packed = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
      if (packed.length < bytes.length * 0.95) { data = packed; method = 8; }
    }
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = view(local);
    lv.setUint32(0, LOCAL, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x800, true);            // names are UTF-8
    lv.setUint16(8, method, true);
    lv.setUint16(12, 0x21, true);            // 1980-01-01
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, bytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    const head = new Uint8Array(46 + nameBytes.length);
    const cv = view(head);
    cv.setUint32(0, CENTRAL, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, bytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    head.set(nameBytes, 46);

    parts.push(local, data);
    central.push(head);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = view(end);
  ev.setUint32(0, EOCD, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + 22);
  let p = 0;
  for (const part of [...parts, ...central, end]) { out.set(part, p); p += part.length; }
  return out;
}

// A path inside a bundle: forward slashes, no "..", no drive letters, nothing
// that could climb out of the folder it's unpacked into.
export function safeEntryName(path) {
  return String(path || '')
    .replace(/\\/g, '/')
    .split('/')
    .map(s => s.replace(/[\x00-\x1F\x7F<>:"|?*]/g, '').trim())
    .filter(s => s && s !== '.' && s !== '..')
    .join('/')
    .slice(0, 400);
}
