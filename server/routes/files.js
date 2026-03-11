'use strict';
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const { db, UPLOADS_DIR } = require('../db');
const {
  generateId, sha256hex, compress, decompress,
  getEncKey, encryptBuffer, decryptBuffer,
  encryptString, decryptString, decodeToken,
} = require('../utils');

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

// Memory storage — we process (compress/encrypt) before writing to disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
});

// ── POST /api/upload ──────────────────────────────────────────────────────────
router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const auth = decodeToken(req.headers.authorization);

  // rate-limit: 5 uploads per 24h per authenticated user
  if (auth) {
    const row = db.prepare(
      "SELECT COUNT(*) AS count FROM files WHERE user_id = ? AND uploaded_at > datetime('now', '-1 day')"
    ).get(auth.userId);

    if (row.count >= 5) {
      return res.status(429).json({ error: 'Upload limit reached (5 files per 24h)' });
    }
  }

  const rawHours = parseFloat(req.body.expires_hours) || 1;
  const expiresHours = Math.max(rawHours, 1 / 60); // minimum 1 minute
  const expires_at = new Date(Date.now() + expiresHours * 3600 * 1000).toISOString();

  const allow_annotations = req.body.allow_annotations === '1' ? 1 : 0;
  const allow_download    = req.body.allow_download    === '1' ? 1 : 0;

  const shortId    = generateId(8);
  const deleteToken = generateId(24);
  const mimeType   = req.file.mimetype || 'application/octet-stream';
  const rawBuffer  = req.file.buffer;

  // integrity hash of original bytes
  const integrity_hash = sha256hex(rawBuffer);

  // compress then optionally encrypt
  let processed = compress(rawBuffer);
  const encKey = getEncKey();
  const isEncrypted = encKey ? 1 : 0;
  if (encKey) processed = encryptBuffer(processed, encKey);

  // write to disk
  const storedFilename = generateId(32) + '.bin';
  fs.writeFileSync(path.join(UPLOADS_DIR, storedFilename), processed);

  // encrypt metadata strings
  const encFilename = encryptString(req.file.originalname, encKey);
  const encMime     = encryptString(mimeType, encKey);

  db.prepare(`
    INSERT INTO files (
      short_id, original_filename, mime_type, size_bytes, stored_filename,
      integrity_hash, compressed, encrypted, expires_at, delete_token, user_id,
      cluster_id, allow_annotations, allow_download
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    shortId, encFilename, encMime, req.file.size, storedFilename,
    integrity_hash, isEncrypted, expires_at, deleteToken,
    auth ? auth.userId : null,
    shortId, // cluster_id = shortId for root uploads
    allow_annotations, allow_download
  );

  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  res.json({
    shortId,
    shortUrl: `${baseUrl}/r/${shortId}`,
    filename: req.file.originalname,
    size: req.file.size,
    expiresAt: expires_at,
    deleteToken,
  });
});

// ── GET /api/info/:shortId ────────────────────────────────────────────────────
router.get('/info/:shortId', (req, res) => {
  const file = db.prepare(`
    SELECT short_id, original_filename, mime_type, size_bytes, uploaded_at,
           expires_at, download_count, integrity_hash, parent_short_id,
           allow_annotations, allow_download
    FROM files WHERE short_id = ? AND is_active = 1
  `).get(req.params.shortId);

  if (!file) return res.status(404).json({ error: 'File not found' });
  if (file.expires_at && new Date(file.expires_at) < new Date()) {
    return res.status(410).json({ error: 'Link expired' });
  }

  const encKey   = getEncKey();
  const filename = decryptString(file.original_filename, encKey);
  const mimeType = decryptString(file.mime_type, encKey);

  res.json({
    filename,
    size: file.size_bytes,
    mimeType,
    uploadedAt: file.uploaded_at,
    expiresAt: file.expires_at,
    views: file.download_count,
    integrityHash: file.integrity_hash,
    isRoot: !file.parent_short_id,
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
    try { data = decryptBuffer(data, encKey); }
    catch { return res.status(500).send('Decryption failed'); }
  }

  if (file.compressed) {
    try { data = decompress(data); }
    catch { return res.status(500).send('Decompression failed'); }
  }

  const filename = decryptString(file.original_filename, encKey);
  const mimeType = decryptString(file.mime_type, encKey);

  // increment view count
  db.prepare('UPDATE files SET download_count = download_count + 1 WHERE short_id = ?')
    .run(file.short_id);

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Content-Length', data.length);
  res.setHeader('Cache-Control', 'no-store');
  res.send(data);
}

// ── GET /api/raw/:shortId ─────────────────────────────────────────────────────
router.get('/raw/:shortId', (req, res) => {
  const file = db.prepare(
    'SELECT * FROM files WHERE short_id = ? AND is_active = 1'
  ).get(req.params.shortId);

  if (!file) return res.status(404).send('Not found');
  if (file.expires_at && new Date(file.expires_at) < new Date()) return res.status(410).send('Expired');

  pipeFile(res, file, 'inline');
});

// ── GET /api/download/:shortId ────────────────────────────────────────────────
router.get('/download/:shortId', (req, res) => {
  const file = db.prepare(
    'SELECT * FROM files WHERE short_id = ? AND is_active = 1'
  ).get(req.params.shortId);

  if (!file) return res.status(404).json({ error: 'Not found' });
  if (file.expires_at && new Date(file.expires_at) < new Date()) return res.status(410).json({ error: 'Expired' });
  if (!file.allow_download) return res.status(403).json({ error: 'Download not permitted for this file' });

  pipeFile(res, file, 'attachment');
});

// ── POST /api/delete/:shortId ─────────────────────────────────────────────────
router.post('/delete/:shortId', (req, res) => {
  const auth         = decodeToken(req.headers.authorization);
  const deleteToken  = req.body && req.body.deleteToken;
  const short_id     = req.params.shortId;

  const file = db.prepare(
    'SELECT short_id, user_id, delete_token, cluster_id FROM files WHERE short_id = ?'
  ).get(short_id);

  if (!file) return res.status(404).json({ error: 'File not found' });

  const isOwner  = auth && file.user_id && String(file.user_id) === String(auth.userId);
  const hasToken = deleteToken && file.delete_token && file.delete_token === deleteToken;

  if (!isOwner && !hasToken) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  // cascade: delete this cluster (original + all reshares)
  const clusterId = file.cluster_id || short_id;

  // collect distinct stored filenames before deleting DB rows
  const clusterFiles = db.prepare(
    'SELECT DISTINCT stored_filename FROM files WHERE cluster_id = ?'
  ).all(clusterId);

  db.prepare('DELETE FROM files WHERE cluster_id = ?').run(clusterId);

  // remove disk files that are no longer referenced anywhere
  const stillUsed = new Set(
    db.prepare('SELECT DISTINCT stored_filename FROM files WHERE stored_filename IS NOT NULL').all()
      .map(r => r.stored_filename)
  );

  for (const row of clusterFiles) {
    if (row.stored_filename && !stillUsed.has(row.stored_filename)) {
      const fp = path.join(UPLOADS_DIR, row.stored_filename);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
  }

  res.json({ deleted: true });
});

// ── POST /api/reshare/:shortId ────────────────────────────────────────────────
router.post('/reshare/:shortId', (req, res) => {
  const file = db.prepare(
    'SELECT * FROM files WHERE short_id = ? AND is_active = 1'
  ).get(req.params.shortId);

  if (!file) return res.status(404).json({ error: 'File not found' });
  if (file.expires_at && new Date(file.expires_at) < new Date()) return res.status(410).json({ error: 'Expired' });

  const newShortId     = generateId(8);
  const newDeleteToken = generateId(24);
  const baseUrl        = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

  // reshared rows share the same stored_filename (no file copy needed)
  db.prepare(`
    INSERT INTO files (
      short_id, original_filename, mime_type, size_bytes, stored_filename,
      integrity_hash, compressed, encrypted, expires_at, delete_token,
      cluster_id, parent_short_id, uploaded_at, allow_annotations, allow_download
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
  `).run(
    newShortId, file.original_filename, file.mime_type, file.size_bytes, file.stored_filename,
    file.integrity_hash, file.compressed, file.encrypted, file.expires_at, newDeleteToken,
    file.cluster_id || file.short_id,
    file.short_id,
    file.allow_annotations, file.allow_download
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
    'SELECT annotations FROM files WHERE short_id = ? AND is_active = 1'
  ).get(req.params.shortId);

  if (!file) return res.status(404).json({ error: 'File not found' });

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
    'SELECT short_id FROM files WHERE short_id = ? AND is_active = 1'
  ).get(req.params.shortId);

  if (!file) return res.status(404).json({ error: 'File not found' });

  const encKey    = getEncKey();
  const encAnnot  = encryptString(annotStr, encKey);

  db.prepare('UPDATE files SET annotations = ? WHERE short_id = ?')
    .run(encAnnot, req.params.shortId);

  res.json({ saved: true });
});

module.exports = router;
