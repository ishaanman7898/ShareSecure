'use strict';
const crypto = require('crypto');
const zlib = require('zlib');

const toBuffer = b => Buffer.isBuffer(b) ? b : Buffer.from(b);

// random letters and digits
function generateId(length = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.randomBytes(length), b => chars[b % chars.length]).join('');
}

const compress = buffer => zlib.deflateSync(toBuffer(buffer));
const decompress = buffer => zlib.inflateSync(toBuffer(buffer));
const randomHex = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

// the master key from ENCRYPTION_KEY (64 hex characters), or null
function getEncKey() {
  const hex = process.env.ENCRYPTION_KEY;
  return hex && hex.length === 64 ? Buffer.from(hex, 'hex') : null;
}

// AES-256-GCM: IV (12) + tag (16) + ciphertext. Without a key, the bytes pass through.
function encryptBuffer(buffer, key) {
  if (!key) return toBuffer(buffer);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(toBuffer(buffer)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

function decryptBuffer(buffer, key) {
  const buf = toBuffer(buffer);
  if (!key) return buf;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
}

// strings are stored as "enc:<base64>"; anything else is returned as it is
function encryptString(str, key) {
  if (!key || !str) return str || '';
  return 'enc:' + encryptBuffer(Buffer.from(str, 'utf8'), key).toString('base64');
}

function decryptString(stored, key) {
  if (!stored) return '';
  if (!key || !stored.startsWith('enc:')) return stored;
  try {
    return decryptBuffer(Buffer.from(stored.slice(4), 'base64'), key).toString('utf8');
  } catch {
    return stored;
  }
}

// now, to the hour ("YYYY-MM-DD HH:00:00"), so upload times say less
function quantizeToHour() {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

// sizes are rounded up to 100 KB, so they say less about the file
const padSize = bytes => Math.ceil(Math.max(bytes, 1) / (100 * 1024)) * (100 * 1024);

// Each file gets its own random key, wrapped by the master key and kept only in
// the file's row, so deleting the row destroys the key. → { data, wrappedKey }
function encryptWithPerFileKey(buffer, masterKey) {
  if (!masterKey) return { data: toBuffer(buffer), wrappedKey: null };
  const fileKey = crypto.randomBytes(32);
  return { data: encryptBuffer(buffer, fileKey), wrappedKey: encryptBuffer(fileKey, masterKey).toString('base64') };
}

// files from before per-file keys (no wrapped key) use the master key directly
function decryptWithPerFileKey(buffer, wrappedKeyB64, masterKey) {
  if (!masterKey) return toBuffer(buffer);
  if (!wrappedKeyB64) return decryptBuffer(buffer, masterKey);
  return decryptBuffer(buffer, decryptBuffer(Buffer.from(wrappedKeyB64, 'base64'), masterKey));
}

// An integrity hash keyed from the master key (random if there isn't one), so
// it can't be looked up in public hash databases.
let integrityKey = null;
function hmacHex(buffer) {
  if (!integrityKey) {
    const encKey = getEncKey();
    integrityKey = encKey ? crypto.createHmac('sha256', encKey).update('sharesecure-integrity-v1').digest() : crypto.randomBytes(32);
  }
  return crypto.createHmac('sha256', integrityKey).update(toBuffer(buffer)).digest('hex');
}

// ── in-file metadata stripping ────────────────────────────────────────────────

// DOCX: blank docProps/core.xml and app.xml and zero every ZIP timestamp.
// Returns the original bytes if it can't be parsed.
function stripDocxMetadata(buf) {
  try {
    return _rebuildDocxWithoutMeta(buf);
  } catch {
    return buf;
  }
}

// CRC-32 (needed to rebuild valid ZIP entries)
const _crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function _crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = _crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const _LOCSIG = 0x04034B50;
const _CENSIG = 0x02014B50;
const _ENDSIG = 0x06054B50;

const _BLANK_CORE = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<cp:coreProperties' +
  ' xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
  ' xmlns:dc="http://purl.org/dc/elements/1.1/"' +
  ' xmlns:dcterms="http://purl.org/dc/terms/"' +
  ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>'
);
const _BLANK_APP = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"/>'
);

function _rebuildDocxWithoutMeta(buf) {
  const replacements = new Map([
    ['docProps/core.xml', _BLANK_CORE],
    ['docProps/app.xml',  _BLANK_APP],
  ]);

  // Find EOCD (scan from end, limit search to avoid pathological inputs)
  let eocdOff = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === _ENDSIG) { eocdOff = i; break; }
  }
  if (eocdOff < 0) return buf; // not a valid ZIP — return unchanged

  const cdOffset   = buf.readUInt32LE(eocdOff + 16);
  const numEntries = buf.readUInt16LE(eocdOff + 10);

  // Parse central directory for the full entry list
  const entries = [];
  let cdPos = cdOffset;
  for (let i = 0; i < numEntries; i++) {
    if (cdPos + 46 > buf.length || buf.readUInt32LE(cdPos) !== _CENSIG) break;
    const method     = buf.readUInt16LE(cdPos + 10);
    const crc        = buf.readUInt32LE(cdPos + 16);
    const compSize   = buf.readUInt32LE(cdPos + 20);
    const uncompSize = buf.readUInt32LE(cdPos + 24);
    const nameLen    = buf.readUInt16LE(cdPos + 28);
    const extraLen   = buf.readUInt16LE(cdPos + 30);
    const commentLen = buf.readUInt16LE(cdPos + 32);
    const localOff   = buf.readUInt32LE(cdPos + 42);
    const name       = buf.slice(cdPos + 46, cdPos + 46 + nameLen).toString('utf8');

    // Locate data start via the local header
    const lNameLen  = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff   = localOff + 30 + lNameLen + lExtraLen;

    entries.push({
      name, method, crc, compSize, uncompSize, dataOff,
      nameBytes:    buf.slice(cdPos + 46, cdPos + 46 + nameLen),
      centralExtra: buf.slice(cdPos + 46 + nameLen, cdPos + 46 + nameLen + extraLen),
      comment:      buf.slice(cdPos + 46 + nameLen + extraLen, cdPos + 46 + nameLen + extraLen + commentLen),
    });
    cdPos += 46 + nameLen + extraLen + commentLen;
  }

  const localParts   = [];
  const centralParts = [];
  let offset = 0;

  for (const e of entries) {
    let data     = buf.slice(e.dataOff, e.dataOff + e.compSize);
    let method   = e.method;
    let crc      = e.crc;
    let compSize = e.compSize;
    let uncompSize = e.uncompSize;

    if (replacements.has(e.name)) {
      data       = replacements.get(e.name);
      method     = 0; // stored (no compression)
      compSize   = data.length;
      uncompSize = data.length;
      crc        = _crc32(data);
    }

    // Local header — timestamps zeroed out (MS-DOS epoch: 1980-01-01 00:00:00)
    const lh = Buffer.alloc(30 + e.nameBytes.length);
    lh.writeUInt32LE(_LOCSIG, 0);
    lh.writeUInt16LE(20, 4);                  // version needed: 2.0
    lh.writeUInt16LE(0, 6);                   // flags: none
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);                  // last-mod time: zeroed
    lh.writeUInt16LE(0x2100, 12);             // last-mod date: 1980-01-01
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compSize, 18);
    lh.writeUInt32LE(uncompSize, 22);
    lh.writeUInt16LE(e.nameBytes.length, 26);
    lh.writeUInt16LE(0, 28);                  // no extra
    e.nameBytes.copy(lh, 30);

    const localEntryOffset = offset;
    localParts.push(lh, data);
    offset += lh.length + data.length;

    // Central directory entry — also zeroed timestamps
    const ce = Buffer.alloc(46 + e.nameBytes.length + e.centralExtra.length + e.comment.length);
    ce.writeUInt32LE(_CENSIG, 0);
    ce.writeUInt16LE(20, 4); ce.writeUInt16LE(20, 6);
    ce.writeUInt16LE(0, 8);
    ce.writeUInt16LE(method, 10);
    ce.writeUInt16LE(0, 12);                  // last-mod time: zeroed
    ce.writeUInt16LE(0x2100, 14);             // last-mod date: 1980-01-01
    ce.writeUInt32LE(crc, 16);
    ce.writeUInt32LE(compSize, 20);
    ce.writeUInt32LE(uncompSize, 24);
    ce.writeUInt16LE(e.nameBytes.length, 28);
    ce.writeUInt16LE(e.centralExtra.length, 30);
    ce.writeUInt16LE(e.comment.length, 32);
    ce.writeUInt16LE(0, 34); ce.writeUInt16LE(0, 36);
    ce.writeUInt32LE(0, 38);
    ce.writeUInt32LE(localEntryOffset, 42);
    e.nameBytes.copy(ce, 46);
    if (e.centralExtra.length) e.centralExtra.copy(ce, 46 + e.nameBytes.length);
    if (e.comment.length)      e.comment.copy(ce, 46 + e.nameBytes.length + e.centralExtra.length);
    centralParts.push(ce);
  }

  const localBuf   = Buffer.concat(localParts);
  const centralBuf = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(_ENDSIG, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localBuf, centralBuf, eocd]);
}

// PDF: blank the author, dates and other /Info strings and drop the XMP packet.
// Returns the original bytes if anything goes wrong.
function stripPdfMetadata(buf) {
  try {
    let s = buf.toString('binary');   // Latin-1 round-trips every byte
    const fields = [
      'Author', 'Creator', 'Producer', 'Subject', 'Keywords', 'Title',
      'Company', 'Manager', 'CreationDate', 'ModDate',
    ];
    for (const f of fields) {
      // Blank literal strings:  /Author (John Doe)  →  /Author ()
      s = s.replace(new RegExp(`(/${f}[ \\t]*)\\((?:[^()\\\\]|\\\\.)*\\)`, 'g'), '$1()');
      // Blank hex strings:  /Author <4A6F686E>  →  /Author <>
      s = s.replace(new RegExp(`(/${f}[ \\t]*)<[^>]*>`, 'g'), '$1<>');
    }
    // Remove full XMP metadata packet
    s = s.replace(/<\?xpacket begin[^?]*\?>[\s\S]*?<\?xpacket end[^?]*\?>/g, '');
    return Buffer.from(s, 'binary');
  } catch {
    return buf;
  }
}

module.exports = {
  generateId, hmacHex, compress, decompress, getEncKey,
  encryptString, decryptString, quantizeToHour, padSize, randomHex,
  encryptWithPerFileKey, decryptWithPerFileKey, stripDocxMetadata, stripPdfMetadata,
};
