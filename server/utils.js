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

module.exports = {
  generateId,
  sha256hex,
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
};
