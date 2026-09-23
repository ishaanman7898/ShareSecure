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
const { purgeExpired, purgeCluster } = require('../purge');

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

function detectFileType(buf) {
  if (!buf || buf.length < 4) return null;
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
  return null;
}

// Memory storage — we process (compress/encrypt) before writing to disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
});

// ── POST /api/upload ──────────────────────────────────────────────────────────
router.post('/upload', requireOwner, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  // ── server-side magic byte validation (zero-knowledge: no logging) ───────
  const detected = detectFileType(req.file.buffer);
  if (!detected) {
    return res.status(415).json({
      error: 'Only PDF (.pdf), Word (.docx), PNG (.png), and JPEG (.jpg/.jpeg) files are accepted. File type is determined by content, not filename.',
    });
  }
  // Override user-supplied MIME with content-derived MIME — prevents spoofing
  req.file.mimetype = detected.mime;

  // Only the signed-in owner can upload to a self-hosted instance, so there is
  // no daily limit and no upload log.

  const rawHours = parseFloat(req.body.expires_hours) || 1;
  const expiresHours = Math.min(Math.max(rawHours, 1 / 60), 240); // min 1 min, max 10 days
  const expires_at = new Date(Date.now() + expiresHours * 3600 * 1000).toISOString();

  const allow_annotations = req.body.allow_annotations === '1' ? 1 : 0;
  const allow_download    = req.body.allow_download    === '1' ? 1 : 0;

  // Optional custom display name — sanitise and preserve correct extension
  let displayName = (req.body.display_name || '').toString().trim();
  if (displayName) {
    const ext = detected.type === 'pdf' ? '.pdf' : detected.type === 'docx' ? '.docx' : detected.mime === 'image/png' ? '.png' : '.jpg';
    // Strip any extension the user typed so we always enforce the correct one
    displayName = displayName.replace(/\.[^.]+$/, '') + ext;
    // Remove filesystem-unsafe characters
    displayName = displayName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim();
    if (displayName.length > 200) displayName = displayName.substring(0, 197) + ext;
    if (!displayName || displayName === ext) displayName = req.file.originalname;
  } else {
    displayName = req.file.originalname;
  }

  const shortId    = generateId(8);
  const deleteToken = generateId(24);
  const mimeType   = req.file.mimetype || 'application/octet-stream';

  // ── strip in-file metadata (author, creator, timestamps, XMP) ────────────
  // Removes identifying information embedded in the document before storage.
  let rawBuffer = req.file.buffer;
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

  // write to disk
  const storedFilename = generateId(32) + '.bin';
  fs.writeFileSync(path.join(UPLOADS_DIR, storedFilename), processed);

  // encrypt metadata strings
  const encFilename = encryptString(displayName, encKey);
  const encMime     = encryptString(mimeType, encKey);

  // privacy: quantize upload time to hour boundary; pad size to 100 KB boundary
  const uploaded_at = quantizeToHour();
  const paddedSize  = padSize(req.file.size);

  // Privacy improvement: user_tag is no longer stored on the files row.
  // The dashboard is now client-side (localStorage), so there is no server-side
  // association between an upload and a user account.
  db.prepare(`
    INSERT INTO files (
      short_id, original_filename, mime_type, size_bytes, stored_filename,
      integrity_hash, compressed, encrypted, uploaded_at, expires_at, delete_token,
      wrapped_key, cluster_id, allow_annotations, allow_download
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    shortId, encFilename, encMime, paddedSize, storedFilename,
    integrity_hash, isEncrypted, uploaded_at, expires_at, deleteToken,
    wrappedKey,
    shortId, // cluster_id = shortId (own random cluster, not shared with reshares)
    allow_annotations, allow_download
  );

  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  res.json({
    shortId,
    shortUrl: `${baseUrl}/r/${shortId}`,
    filename: req.file.originalname,
    size: paddedSize,
    expiresAt: expires_at,
    deleteToken,
  });
});

// ── GET /api/info/:shortId ────────────────────────────────────────────────────
router.get('/info/:shortId', (req, res) => {
  const file = db.prepare(`
    SELECT short_id, original_filename, mime_type, size_bytes,
           expires_at, download_count, integrity_hash,
           allow_annotations, allow_download
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

  if (disposition === 'attachment') {
    // download: reveal original mime + filename (owner-only action)
    const filename = decryptString(file.original_filename, encKey);
    const mimeType = decryptString(file.mime_type, encKey);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  } else {
    // inline (raw viewer): strip mime type and filename from headers — privacy
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline');
  }

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

  // cascade: erase this cluster (original + all reshares) and shred the stored file
  purgeCluster(file.cluster_id || short_id);

  res.json({ deleted: true });
});

// ── POST /api/reshare/:shortId ────────────────────────────────────────────────
router.post('/reshare/:shortId', (req, res) => {
  const file = db.prepare(
    'SELECT * FROM files WHERE short_id = ? AND is_active = 1'
  ).get(req.params.shortId);

  if (goneIfExpired(file, res)) return;

  const newShortId      = generateId(8);
  const newDeleteToken  = generateId(24);
  const newClusterId    = generateId(16);   // privacy: independent cluster, no link to original
  const newIntegrity    = randomHex(32);    // privacy: random hash, breaks content-fingerprint correlation
  const reshareUploadAt = quantizeToHour(); // privacy: quantize to hour boundary
  const baseUrl         = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

  // reshared rows share the same stored_filename (no file copy needed)
  // parent_short_id intentionally omitted — each reshare is a standalone, untraceable link
  db.prepare(`
    INSERT INTO files (
      short_id, original_filename, mime_type, size_bytes, stored_filename,
      integrity_hash, compressed, encrypted, expires_at, delete_token,
      cluster_id, uploaded_at, allow_annotations, allow_download, wrapped_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newShortId, file.original_filename, file.mime_type, file.size_bytes, file.stored_filename,
    newIntegrity, file.compressed, file.encrypted, file.expires_at, newDeleteToken,
    newClusterId, reshareUploadAt,
    file.allow_annotations, file.allow_download, file.wrapped_key || null
  );

  res.json({
    shortId:     newShortId,
    shortUrl:    `${baseUrl}/r/${newShortId}`,
    deleteToken: newDeleteToken,
  });
});

// ── GET /api/annotations/:shortId ────────────────────────────────────────────
router.get('/annotations/:shortId', (req, res) => {
  const file = db.prepare(
    'SELECT annotations, expires_at, allow_annotations FROM files WHERE short_id = ? AND is_active = 1'
  ).get(req.params.shortId);

  if (goneIfExpired(file, res)) return;
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
  const { annotations } = req.body || {};
  if (!Array.isArray(annotations)) return res.status(400).json({ error: 'Annotations must be an array' });

  const annotStr = JSON.stringify(annotations);
  if (annotStr.length > 1024 * 1024) return res.status(413).json({ error: 'Annotations too large (max 1 MB)' });

  const file = db.prepare(
    'SELECT short_id, expires_at, allow_annotations FROM files WHERE short_id = ? AND is_active = 1'
  ).get(req.params.shortId);

  if (goneIfExpired(file, res)) return;
  if (!file.allow_annotations) return res.status(403).json({ error: 'Annotations are turned off for this file' });

  const encKey    = getEncKey();
  const encAnnot  = encryptString(annotStr, encKey);

  db.prepare('UPDATE files SET annotations = ? WHERE short_id = ?')
    .run(encAnnot, req.params.shortId);

  res.json({ saved: true });
});

module.exports = router;
