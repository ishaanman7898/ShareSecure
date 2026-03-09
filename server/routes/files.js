const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { nanoid } = require('nanoid');
const db = require('../db');

const UPLOADS_DIR = path.join(__dirname, '../../uploads');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, nanoid(32) + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// POST /api/upload
router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const short_id = nanoid(8);
  const expiresHours = parseInt(req.body.expires_hours) || null;
  const expires_at = expiresHours
    ? new Date(Date.now() + expiresHours * 3600 * 1000).toISOString()
    : null;

  try {
    db.prepare(`
      INSERT INTO files (short_id, original_filename, stored_filename, mime_type, size_bytes, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      short_id,
      req.file.originalname,
      req.file.filename,
      req.file.mimetype,
      req.file.size,
      expires_at
    );

    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    res.json({
      shortId: short_id,
      shortUrl: `${baseUrl}/r/${short_id}`,
      filename: req.file.originalname,
      size: req.file.size,
      expiresAt: expires_at
    });
  } catch (err) {
    fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// GET /api/info/:shortId — metadata (no uploader info)
router.get('/info/:shortId', (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE short_id = ? AND is_active = 1').get(req.params.shortId);
  if (!file) return res.status(404).json({ error: 'File not found' });

  if (file.expires_at && new Date(file.expires_at) < new Date()) {
    return res.status(410).json({ error: 'Link expired' });
  }

  res.json({
    filename: file.original_filename,
    size: file.size_bytes,
    mimeType: file.mime_type,
    uploadedAt: file.uploaded_at,
    expiresAt: file.expires_at,
    views: file.download_count
  });
});

// GET /api/raw/:shortId — stream the actual file bytes (used by viewer)
router.get('/raw/:shortId', (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE short_id = ? AND is_active = 1').get(req.params.shortId);
  if (!file) return res.status(404).send('Not found');

  if (file.expires_at && new Date(file.expires_at) < new Date()) {
    return res.status(410).send('Expired');
  }

  const filePath = path.join(UPLOADS_DIR, file.stored_filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');

  db.prepare('UPDATE files SET download_count = download_count + 1 WHERE short_id = ?').run(req.params.shortId);

  res.setHeader('Content-Type', file.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${file.original_filename}"`);
  res.setHeader('Content-Length', file.size_bytes);
  // Allow PDF.js (same origin) to load the file
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(filePath);
});

// GET /api/download/:shortId — force-download
router.get('/download/:shortId', (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE short_id = ? AND is_active = 1').get(req.params.shortId);
  if (!file) return res.status(404).send('Not found');

  if (file.expires_at && new Date(file.expires_at) < new Date()) {
    return res.status(410).send('Expired');
  }

  const filePath = path.join(UPLOADS_DIR, file.stored_filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');

  res.setHeader('Content-Disposition', `attachment; filename="${file.original_filename}"`);
  res.setHeader('Content-Type', file.mime_type);
  res.sendFile(filePath);
});

module.exports = router;
