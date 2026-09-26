'use strict';
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const { db, UPLOADS_DIR } = require('../db');
const {
  generateId, sha256hex, hmacHex, compress, decompress,
  getEncKey, encryptBuffer, decryptBuffer,
  encryptString, decryptString, decodeToken,
  quantizeToHour, padSize, randomHex, getUserTag,
  encryptWithPerFileKey, decryptWithPerFileKey,
  stripDocxMetadata, stripPdfMetadata,
} = require('../utils');
const { requireOwner } = require('../session');
const { purgeExpired, purgeLink } = require('../purge');

const isExpired = file => Boolean(file.expires_at && file.expires_at <= new Date().toISOString());

// A link that has expired is erased the moment anyone touches it, not at the next sweep.
function goneIfExpired(file, res, asJson = true) {
  if (!file) {
    asJson ? res.status(404).json({ error: 'File not found' }) : res.status(404).send('Not found');
    return true;
  }
  if (isExpired(file)) {
    purgeExpired();
    asJson ? res.status(410).json({ error: 'Link expired' }) : res.status(410).send('Expired');
    return true;
  }
  return false;
}

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

// ── magic byte detection ──────────────────────────────────────────────────────
// Returns { type: 'pdf'|'docx', mime: string } or null if not a permitted type.
// Validates actual file content, not user-supplied headers.

/**
 * Scan ZIP local file headers looking for the 'word/document.xml' entry.
 * A real DOCX must contain this path; a generic ZIP that is not a Word document
 * will not.  This closes the gap where any valid ZIP passed the magic byte check.
 */
function isValidDocxZip(buf) {
  const LOCAL_HEADER_SIG = 0x504B0304;
  let offset = 0;
  while (offset + 30 <= buf.length) {
    if (buf.readUInt32LE(offset) !== LOCAL_HEADER_SIG) break;
    const flags          = buf.readUInt16LE(offset + 6);
    const compressedSize = buf.readUInt32LE(offset + 18);
    const filenameLen    = buf.readUInt16LE(offset + 26);
    const extraLen       = buf.readUInt16LE(offset + 28);
    const nameEnd        = offset + 30 + filenameLen;
    if (nameEnd > buf.length) break;
    const name = buf.slice(offset + 30, nameEnd).toString('utf8');
    if (name === 'word/document.xml') return true;
    // If the data descriptor bit is set and sizes are zero we cannot safely skip
    if ((flags & 0x08) && compressedSize === 0) break;
    offset += 30 + filenameLen + extraLen + compressedSize;
  }
  return false;
}

// ── text files ────────────────────────────────────────────────────────────────
// Text has no magic bytes, so it's allowed by its name (or the type the
// uploader gave) and then checked: valid UTF-8 with no control characters
// except tab, newlines and form feed. It's only ever served as plain text.
const TEXT_TYPES = { '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.csv': 'text/csv' };
const TEXT_EXT = { 'text/plain': '.txt', 'text/markdown': '.md', 'text/csv': '.csv' };
const isTextMime = mime => Object.prototype.hasOwnProperty.call(TEXT_EXT, String(mime || '').split(';')[0].trim().toLowerCase());

function isCleanText(buf) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return false; }
  return !/[\x00-\x08\x0B\x0E-\x1F\x7F]/.test(text);
}

function textTypeFor(name, claimedType) {
  const ext = (String(name || '').toLowerCase().match(/\.[a-z0-9]+$/) || [''])[0];
  if (TEXT_TYPES[ext]) return TEXT_TYPES[ext];
  const claimed = String(claimedType || '').split(';')[0].trim().toLowerCase();
  return isTextMime(claimed) ? claimed : null;
}

// name and claimedType only matter for text; everything else goes by its bytes
function detectFileType(buf, name = '', claimedType = '') {
  if (!buf || !buf.length) return null;
  if (buf.length < 4) {
    const mime = textTypeFor(name, claimedType);
    return mime && isCleanText(buf) ? { type: 'text', mime } : null;
  }
  // PDF: %PDF = 0x25 0x50 0x44 0x46
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return { type: 'pdf', mime: 'application/pdf' };
  }
  // DOCX: ZIP magic bytes AND internal word/document.xml entry required
  if (buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04) {
    if (!isValidDocxZip(buf)) return null; // valid ZIP but not a Word document
    return { type: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }
  // PNG: 0x89 0x50 0x4E 0x47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
    return { type: 'image', mime: 'image/png' };
  }
  // JPEG: 0xFF 0xD8 0xFF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
    return { type: 'image', mime: 'image/jpeg' };
  }
  const mime = textTypeFor(name, claimedType);
  if (mime && isCleanText(buf)) return { type: 'text', mime };
  return null;
}

// Memory storage — we process (compress/encrypt) before writing to disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
});

const UNSUPPORTED_TYPE = 'Only PDF (.pdf), Word (.docx), PNG (.png), JPEG (.jpg/.jpeg) and text (.txt, .md, .csv) files are accepted. Files are checked by their content, not just their name.';

// The shown name always ends in the extension of the file's real type, so a PDF
// can't arrive looking like "invoice.exe".
function cleanDisplayName(requested, detected, originalName) {
  let name = (requested || '').toString().trim() || String(originalName || 'file');
  const ext = detected.type === 'pdf' ? '.pdf'
    : detected.type === 'docx' ? '.docx'
    : detected.type === 'text' ? TEXT_EXT[detected.mime]
    : detected.mime === 'image/png' ? '.png' : '.jpg';
  // Strip any extension the user typed so we always enforce the correct one
  name = name.replace(/\.[^.]+$/, '') + ext;
  // Remove filesystem-unsafe characters
  name = name.replace(/[<>:"/\|?*\x00-\x1f]/g, '').trim();
  if (name.length > 200) name = name.substring(0, 197) + ext;
  return name === ext ? 'file' + ext : name;
}

// Validate, strip metadata, compress, encrypt and store an uploaded file.
// Used for the owner's uploads and for files people send to the owner
// (`incoming`), which are stored inactive until the owner accepts them.
function storeFile(file, body, { incoming = false, note = null } = {}) {
  const detected = detectFileType(file.buffer, file.originalname, file.mimetype);
  if (!detected) return { error: UNSUPPORTED_TYPE, status: 415 };

  const rawHours = parseFloat(body.expires_hours) || 1;
  const expiresHours = Math.min(Math.max(rawHours, 1 / 60), 240); // min 1 min, max 10 days
  const expires_at = new Date(Date.now() + expiresHours * 3600 * 1000).toISOString();

  const allow_annotations = body.allow_annotations === '1' ? 1 : 0;
  const allow_download    = body.allow_download    === '1' ? 1 : 0;
  const displayName = cleanDisplayName(body.display_name, detected, file.originalname);

  const shortId     = generateId(8);
  const deleteToken = generateId(24);
  const mimeType    = detected.mime; // content-derived MIME, never the client's claim

  // ── strip in-file metadata (author, creator, timestamps, XMP) ────────────
  // (text has none to strip)
  let rawBuffer = file.buffer;
  if (detected.type === 'docx') rawBuffer = stripDocxMetadata(rawBuffer);
  if (detected.type === 'pdf')  rawBuffer = stripPdfMetadata(rawBuffer);

  // HMAC-SHA256 integrity hash (keyed — not searchable in public hash databases)
  const integrity_hash = hmacHex(rawBuffer);

  // compress then optionally encrypt with per-file key wrapping
  let processed = compress(rawBuffer);
  const encKey = getEncKey();
  const isEncrypted = encKey ? 1 : 0;
  let wrappedKey = null;
  if (encKey) {
    const result = encryptWithPerFileKey(processed, encKey);
    processed  = result.data;
    wrappedKey = result.wrappedKey;
  }

  const storedFilename = generateId(32) + '.bin';
  fs.writeFileSync(path.join(UPLOADS_DIR, storedFilename), processed);

  // privacy: quantize upload time to hour boundary; pad size to 100 KB boundary
  const uploaded_at = quantizeToHour();
  const paddedSize  = padSize(file.size);

  db.prepare(`
    INSERT INTO files (
      short_id, original_filename, mime_type, size_bytes, stored_filename,
      integrity_hash, compressed, encrypted, uploaded_at, expires_at, delete_token,
      wrapped_key, cluster_id, allow_annotations, allow_download,
      is_active, inbox_status, inbox_note
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    shortId, encryptString(displayName, encKey), encryptString(mimeType, encKey), paddedSize, storedFilename,
    integrity_hash, isEncrypted, uploaded_at, expires_at, deleteToken,
    wrappedKey,
    shortId, // cluster_id = shortId (own random cluster, not shared with reshares)
    allow_annotations, allow_download,
    incoming ? 0 : 1,
    incoming ? 'pending' : null,
    note ? encryptString(note, encKey) : null
  );

  return { shortId, deleteToken, expires_at, paddedSize, displayName };
}

// ── POST /api/upload ──────────────────────────────────────────────────────────
// Only the signed-in owner can upload to a self-hosted instance, so there is
// no daily limit and no upload log.
router.post('/upload', requireOwner, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const stored = storeFile(req.file, req.body);
  if (stored.error) return res.status(stored.status).json({ error: stored.error });

  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  res.json({
    shortId: stored.shortId,
    shortUrl: `${baseUrl}/r/${stored.shortId}`,
    filename: req.file.originalname,
    size: stored.paddedSize,
    expiresAt: stored.expires_at,
    deleteToken: stored.deleteToken,
  });
});

// ── GET /api/info/:shortId ────────────────────────────────────────────────────
router.get('/info/:shortId', (req, res) => {
  const file = db.prepare(`
    SELECT short_id, original_filename, mime_type, size_bytes,
           expires_at, download_count, integrity_hash,
           allow_annotations, allow_download, cluster_id, parent_short_id
    FROM files WHERE short_id = ? AND is_active = 1
  `).get(req.params.shortId);

  if (goneIfExpired(file, res)) return;

  const encKey   = getEncKey();
  const filename = decryptString(file.original_filename, encKey);
  const mimeType = decryptString(file.mime_type, encKey);

  res.json({
    filename,
    size: file.size_bytes,
    mimeType,
    expiresAt: file.expires_at,
    views: file.download_count,
    integrityHash: file.integrity_hash,
    allowAnnotations: file.allow_annotations ?? 1,
    allowDownload:    file.allow_download    ?? 0,
    // the original upload: deleting it removes every link to the file
    isRoot: !file.parent_short_id && (!file.cluster_id || file.cluster_id === file.short_id),
  });
});

// ── internal: decompress + decrypt and send a file ───────────────────────────
function pipeFile(res, file, disposition) {
  if (!file.stored_filename) return res.status(404).send('File not found');

  const fp = path.join(UPLOADS_DIR, file.stored_filename);
  if (!fs.existsSync(fp)) return res.status(404).send('File not found on disk');

  let data = fs.readFileSync(fp);
  const encKey = getEncKey();

  if (file.encrypted) {
    if (!encKey) return res.status(500).send('File is encrypted but ENCRYPTION_KEY is not set');
    try { data = decryptWithPerFileKey(data, file.wrapped_key || null, encKey); }
    catch { return res.status(500).send('Decryption failed'); }
  }

  if (file.compressed) {
    try { data = decompress(data); }
    catch { return res.status(500).send('Decompression failed'); }
  }

  // increment view count
  db.prepare('UPDATE files SET download_count = download_count + 1 WHERE short_id = ?')
    .run(file.short_id);

  const mimeType = decryptString(file.mime_type, encKey);
  const isText = isTextMime(mimeType);
  if (disposition === 'attachment') {
    // download: reveal original mime + filename (owner-only action).
    // Only the types we accept are named; anything else goes out as plain bytes.
    const filename = decryptString(file.original_filename, encKey);
    const known = isText || ['application/pdf', 'image/png', 'image/jpeg', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(mimeType);
    res.setHeader('Content-Type', isText ? `${mimeType}; charset=utf-8` : known ? mimeType : 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  } else {
    // inline (raw viewer): strip mime type and filename from headers — privacy.
    // Text is always plain text, so a browser never runs it as a page.
    res.setHeader('Content-Type', isText ? 'text/plain; charset=utf-8' : 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');

  res.setHeader('Content-Length', data.length);
  res.setHeader('Cache-Control', 'no-store');
  res.send(data);
}

// ── GET /api/raw/:shortId ─────────────────────────────────────────────────────
router.get('/raw/:shortId', (req, res) => {
  const file = db.prepare(
    'SELECT * FROM files WHERE short_id = ? AND is_active = 1'
  ).get(req.params.shortId);

  if (goneIfExpired(file, res, false)) return;

  pipeFile(res, file, 'inline');
});

// ── GET /api/download/:shortId ────────────────────────────────────────────────
router.get('/download/:shortId', (req, res) => {
  const file = db.prepare(
    'SELECT * FROM files WHERE short_id = ? AND is_active = 1'
  ).get(req.params.shortId);

  if (goneIfExpired(file, res)) return;
  if (!file.allow_download) return res.status(403).json({ error: 'Download not permitted for this file' });

  pipeFile(res, file, 'attachment');
});

// ── POST /api/delete/:shortId ─────────────────────────────────────────────────
router.post('/delete/:shortId', (req, res) => {
  const auth         = decodeToken(req.headers.authorization);
  const deleteToken  = req.body && req.body.deleteToken;
  const short_id     = req.params.shortId;

  const file = db.prepare(
    'SELECT short_id, delete_token, cluster_id FROM files WHERE short_id = ?'
  ).get(short_id);

  if (!file) return res.status(404).json({ error: 'File not found' });

  const isOwner = Boolean(auth);   // the only account on a self-hosted instance is the owner
  const hasToken = deleteToken && file.delete_token && file.delete_token === deleteToken;

  if (!isOwner && !hasToken) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  // the original takes every link with it; any other link takes only its branch
  const everyone = file.cluster_id === short_id;
  purgeLink(file);

  res.json({ deleted: true, scope: everyone ? 'everyone' : 'branch' });
});

// ── POST /api/reshare/:shortId ────────────────────────────────────────────────
router.post('/reshare/:shortId', (req, res) => {
  const file = db.prepare(
    'SELECT * FROM files WHERE short_id = ? AND is_active = 1'
  ).get(req.params.shortId);

  if (goneIfExpired(file, res)) return;

  const newShortId      = generateId(8);
  const newDeleteToken  = generateId(24);
  const newIntegrity    = randomHex(32);    // privacy: random hash, breaks content-fingerprint correlation
  const reshareUploadAt = quantizeToHour(); // privacy: quantize to hour boundary
  const baseUrl         = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

  // A reshare shares the stored file (no copy) and is a branch of the link it
  // came from: deleting that link, or the original, deletes this one too.
  db.prepare(`
    INSERT INTO files (
      short_id, original_filename, mime_type, size_bytes, stored_filename,
      integrity_hash, compressed, encrypted, expires_at, delete_token,
      cluster_id, parent_short_id, uploaded_at, allow_annotations, allow_download, wrapped_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newShortId, file.original_filename, file.mime_type, file.size_bytes, file.stored_filename,
    newIntegrity, file.compressed, file.encrypted, file.expires_at, newDeleteToken,
    file.cluster_id || file.short_id, file.short_id, reshareUploadAt,
    file.allow_annotations, file.allow_download, file.wrapped_key || null
  );

  res.json({
    shortId:     newShortId,
    shortUrl:    `${baseUrl}/r/${newShortId}`,
    deleteToken: newDeleteToken,
  });
});

// ── annotations ──────────────────────────────────────────────────────────────
// Annotations are the private notes of whoever owns a link: every other viewer
// gets a fresh link of their own before annotations load. Reading and saving
// both need the link's delete token in the X-Delete-Token header.
const annCrypto = require('crypto');

const ANN_MAX_BYTES   = 1024 * 1024;
const ANN_MAX_STROKES = 5000;
const ANN_MAX_POINTS  = 20000;
const ANN_COLOR = /^(#[0-9a-f]{6}|rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(0|1|0?\.\d+)\s*\))$/i;

// hashing both sides first keeps the compare fixed-length and constant-time
function annTokenMatches(given, stored) {
  if (!given || !stored || typeof given !== 'string') return false;
  const a = annCrypto.createHash('sha256').update(given).digest();
  const b = annCrypto.createHash('sha256').update(String(stored)).digest();
  return annCrypto.timingSafeEqual(a, b);
}

const annIsNum = n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e6;

// Keep only well-formed strokes, rebuilt with known fields, or null if any is bad.
function cleanStrokes(list) {
  if (!Array.isArray(list) || list.length > ANN_MAX_STROKES) return null;
  const out = [];
  for (const s of list) {
    if (typeof s !== 'object' || s === null) return null;
    if (!Number.isInteger(s.page) || s.page < 1 || s.page > 10000) return null;
    if (typeof s.color !== 'string' || !ANN_COLOR.test(s.color)) return null;
    if (!annIsNum(s.width) || s.width <= 0 || s.width > 64) return null;
    if (!Array.isArray(s.points) || s.points.length > ANN_MAX_POINTS) return null;
    if (!s.points.every(p => typeof p === 'object' && p !== null && annIsNum(p.x) && annIsNum(p.y))) return null;
    out.push({
      page: s.page,
      color: s.color,
      width: s.width,
      eraser: s.eraser === true,
      highlight: s.highlight === true,
      points: s.points.map(p => ({ x: p.x, y: p.y })),
    });
  }
  return out;
}

// ── GET /api/annotations/:shortId ────────────────────────────────────────────
router.get('/annotations/:shortId', (req, res) => {
  const file = db.prepare(
    'SELECT annotations, expires_at, allow_annotations, delete_token FROM files WHERE short_id = ? AND is_active = 1'
  ).get(req.params.shortId);

  if (goneIfExpired(file, res)) return;
  if (!annTokenMatches(req.get('X-Delete-Token'), file.delete_token)) {
    return res.status(403).json({ error: 'Only the owner of this link can use its annotations' });
  }
  if (!file.allow_annotations) return res.json({ annotations: [] });

  const encKey = getEncKey();
  const raw    = decryptString(file.annotations, encKey);

  let annotations = [];
  if (raw) {
    try { annotations = JSON.parse(raw); } catch {}
  }

  res.json({ annotations });
});

// ── POST /api/annotations/:shortId ───────────────────────────────────────────
router.post('/annotations/:shortId', (req, res) => {
  const file = db.prepare(
    'SELECT short_id, expires_at, allow_annotations, delete_token FROM files WHERE short_id = ? AND is_active = 1'
  ).get(req.params.shortId);

  if (goneIfExpired(file, res)) return;
  if (!annTokenMatches(req.get('X-Delete-Token'), file.delete_token)) {
    return res.status(403).json({ error: 'Only the owner of this link can use its annotations' });
  }
  if (!file.allow_annotations) return res.status(403).json({ error: 'Annotations are turned off for this file' });

  const annotations = cleanStrokes((req.body || {}).annotations);
  if (!annotations) return res.status(400).json({ error: 'Invalid annotations' });

  const annotStr = JSON.stringify(annotations);
  if (annotStr.length > ANN_MAX_BYTES) return res.status(413).json({ error: 'Annotations too large (max 1 MB)' });

  const encKey    = getEncKey();
  const encAnnot  = encryptString(annotStr, encKey);

  db.prepare('UPDATE files SET annotations = ? WHERE short_id = ?')
    .run(encAnnot, req.params.shortId);

  res.json({ saved: true });
});

module.exports = router;
module.exports.storeFile = storeFile;
module.exports.upload = upload;
