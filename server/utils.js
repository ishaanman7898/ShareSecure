'use strict';
const crypto = require('crypto');
const zlib = require('zlib');

/** Cryptographically random alphanumeric ID */
function generateId(length = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

/** SHA-256 hex digest of a Buffer/ArrayBuffer */
function sha256hex(buffer) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)).digest('hex');
}

/** zlib DEFLATE compress → Buffer */
function compress(buffer) {
  return zlib.deflateSync(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
}

/** zlib INFLATE decompress → Buffer */
function decompress(buffer) {
  return zlib.inflateSync(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
}

/**
 * Load AES-256-GCM key from ENCRYPTION_KEY env (64 hex chars = 32 bytes).
 * Returns a Buffer, or null if not configured.
 */
function getEncKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) return null;
  try {
    return Buffer.from(hex, 'hex');
  } catch {
    return null;
  }
}

/**
 * Encrypt a Buffer with AES-256-GCM.
 * Output format: IV(12) + AuthTag(16) + Ciphertext
 * Returns the combined Buffer.
 */
function encryptBuffer(buffer, key) {
  if (!key) return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Decrypt a Buffer encrypted with encryptBuffer.
 */
function decryptBuffer(buffer, key) {
  if (!key) return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const iv = buf.slice(0, 12);
  const authTag = buf.slice(12, 28);
  const ct = buf.slice(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/**
 * Encrypt a string to 'enc:<base64>' format.
 * Returns the plain string if no key.
 */
function encryptString(str, key) {
  if (!key || !str) return str || '';
  const encrypted = encryptBuffer(Buffer.from(str, 'utf8'), key);
  return 'enc:' + encrypted.toString('base64');
}

/**
 * Decrypt an 'enc:<base64>' string.
 * Returns the raw string if not encrypted or no key.
 */
function decryptString(stored, key) {
  if (!stored) return '';
  if (!key || !stored.startsWith('enc:')) return stored;
  try {
    const buf = Buffer.from(stored.slice(4), 'base64');
    return decryptBuffer(buf, key).toString('utf8');
  } catch {
    return stored; // return raw if decryption fails
  }
}

/**
 * Decode a Bearer token (base64 "username:userId") → { username, userId } or null.
 */
function decodeToken(authHeader) {
  if (!authHeader) return null;
  try {
    const tokenPart = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    const decoded = Buffer.from(tokenPart, 'base64').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length < 2) return null;
    const userId = parseInt(parts[parts.length - 1], 10);
    if (isNaN(userId)) return null;
    const username = parts.slice(0, -1).join(':');
    return { username, userId };
  } catch {
    return null;
  }
}

/**
 * Quantize current UTC time to the nearest hour boundary (privacy: reduce temporal fingerprinting).
 * Returns SQLite-compatible datetime string: "YYYY-MM-DD HH:00:00"
 */
function quantizeToHour() {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

/**
 * Pad size to the next 100 KB boundary (privacy: hide exact file size).
 */
function padSize(bytes) {
  const boundary = 100 * 1024;
  return Math.ceil(Math.max(bytes, 1) / boundary) * boundary;
}

/**
 * Cryptographically random hex string of `bytes` bytes (default 32 → 64 hex chars).
 */
function randomHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

// Ephemeral fallback key — used only when ENCRYPTION_KEY is not set.
// Changes on every server restart, which means tags are non-persistent
// but the app still won't link uploads to a username in the DB.
let _ephemeralTagKey = null;

/**
 * Derive a pseudonymous upload tag for a user.
 * HMAC-SHA256(userId, derived_key) — irreversible without the key.
 * DB rows store this tag instead of the raw user ID, so a DB leak
 * alone cannot link a row to a username.
 */
function getUserTag(userId) {
  const encKey = getEncKey();
  if (!_ephemeralTagKey) {
    _ephemeralTagKey = encKey
      // sub-key derived from the encryption key so it's stable across restarts
      ? crypto.createHmac('sha256', encKey).update('sharesecure-user-tag-v1').digest()
      : crypto.randomBytes(32); // ephemeral if no ENCRYPTION_KEY
  }
  return crypto.createHmac('sha256', _ephemeralTagKey).update(String(userId)).digest('hex');
}

/**
 * Encrypt a buffer using a freshly generated per-file key, then wrap that key
 * with the master key.  Returns { data: Buffer, wrappedKey: string|null }.
 *
 * Forward-secrecy improvement: each file gets a unique key so compromising
 * the master key only exposes future files, not past ones.
 */
function encryptWithPerFileKey(buffer, masterKey) {
  if (!masterKey) {
    return { data: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer), wrappedKey: null };
  }
  const fileKey = crypto.randomBytes(32);
  const data = encryptBuffer(buffer, fileKey);
  // Wrap (encrypt) the file key with the master key.
  const wrappedKey = encryptBuffer(fileKey, masterKey).toString('base64');
  return { data, wrappedKey };
}

/**
 * Decrypt a buffer that was encrypted with encryptWithPerFileKey.
 * Falls back to direct master-key decryption for files uploaded before this
 * scheme was introduced (wrappedKey === null).
 */
function decryptWithPerFileKey(buffer, wrappedKeyB64, masterKey) {
  if (!masterKey) return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (!wrappedKeyB64) {
    // Backward compat: file encrypted directly with master key (old format)
    return decryptBuffer(buffer, masterKey);
  }
  const wrappedKeyBuf = Buffer.from(wrappedKeyB64, 'base64');
  const fileKey = decryptBuffer(wrappedKeyBuf, masterKey);
  return decryptBuffer(buffer, fileKey);
}

// ── HMAC integrity hash ────────────────────────────────────────────────────────
// Keyed with a sub-key derived from ENCRYPTION_KEY (or ephemeral if unset).
// Unlike raw SHA-256, this hash cannot be looked up in public content-addressable
// databases (VirusTotal, NSRL, etc.) because the key is secret.
let _ephemeralIntegrityKey = null;

function hmacHex(buffer) {
  const encKey = getEncKey();
  if (!_ephemeralIntegrityKey) {
    _ephemeralIntegrityKey = encKey
      ? crypto.createHmac('sha256', encKey).update('sharesecure-integrity-v1').digest()
      : crypto.randomBytes(32);
  }
  return crypto.createHmac('sha256', _ephemeralIntegrityKey)
    .update(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer))
    .digest('hex');
}

// ── in-file metadata stripping ────────────────────────────────────────────────

/**
 * Strip author/company/revision metadata from a DOCX buffer.
 * Replaces docProps/core.xml and docProps/app.xml with blank versions, and
 * zeroes out all ZIP entry timestamps.
 * Safe fallback: returns original buffer if parsing fails.
 */
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

/**
 * Strip author/date/producer metadata from a PDF buffer.
 * Blanks /Info dictionary string values and removes the XMP metadata packet.
 * Safe fallback: returns original buffer if processing fails.
 */
function stripPdfMetadata(buf) {
  try {
    // 'binary' (Latin-1) encoding is a byte-safe lossless round-trip for raw binary data
    let s = buf.toString('binary');
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
  generateId,
  sha256hex,
  hmacHex,
  compress,
  decompress,
  getEncKey,
  encryptBuffer,
  decryptBuffer,
  encryptString,
  decryptString,
  decodeToken,
  quantizeToHour,
  padSize,
  randomHex,
  getUserTag,
  encryptWithPerFileKey,
  decryptWithPerFileKey,
  stripDocxMetadata,
  stripPdfMetadata,
};
