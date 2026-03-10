const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { nanoid } = require('nanoid');
const { db, getFileClient } = require('../db');

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
  limits: { fileSize: 10 * 1024 * 1024 } // 10mb
});

// helper to get user from auth header
function getAuthUser(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  try {
    const decoded = Buffer.from(authHeader.replace('Bearer ', ''), 'base64').toString('ascii');
    const [username, userId] = decoded.split(':');
    return { username, userId };
  } catch (err) {
    return null;
  }
}

// post /api/upload
router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const user = getAuthUser(req);
  let userId = null;

  if (user) {
    userId = user.userId;
    // check daily limit (5 files per 24h)
    const recentUploads = await db.execute({
      sql: `SELECT COUNT(*) as count FROM files 
            WHERE user_id = ? 
            AND uploaded_at > datetime('now', '-1 day')`,
      args: [userId]
    });

    if (recentUploads.rows[0].count >= 5) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(429).json({ error: 'Upload limit reached (5 files per 24h)' });
    }
  }

  const short_id = nanoid(8);
  const expiresHours = parseFloat(req.body.expires_hours) || null;
  const expires_at = expiresHours
    ? new Date(Date.now() + expiresHours * 3600 * 1000).toISOString()
    : null;

  try {
    await db.execute({
      sql: `INSERT INTO files (short_id, original_filename, stored_filename, mime_type, size_bytes, expires_at, user_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        short_id,
        req.file.originalname,
        req.file.filename,
        req.file.mimetype,
        req.file.size,
        expires_at,
        userId
      ]
    });

    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    res.json({
      shortId: short_id,
      shortUrl: `${baseUrl}/r/${short_id}`,
      filename: req.file.originalname,
      size: req.file.size,
      expiresAt: expires_at
    });
  } catch (err) {
    console.error('Upload DB error:', err);
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// get /api/info/:shortid
router.get('/info/:shortId', async (req, res) => {
  const result = await db.execute({
    sql: 'SELECT * FROM files WHERE short_id = ? AND is_active = 1',
    args: [req.params.shortId]
  });
  const file = result.rows[0];

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

// get /api/raw/:shortid
router.get('/raw/:shortId', async (req, res) => {
  const result = await db.execute({
    sql: 'SELECT * FROM files WHERE short_id = ? AND is_active = 1',
    args: [req.params.shortId]
  });
  const file = result.rows[0];

  if (!file) return res.status(404).send('Not found');

  if (file.expires_at && new Date(file.expires_at) < new Date()) {
    return res.status(410).send('Expired');
  }

  const filePath = path.join(UPLOADS_DIR, file.stored_filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');

  await db.execute({
    sql: 'UPDATE files SET download_count = download_count + 1 WHERE short_id = ?',
    args: [req.params.shortId]
  });

  res.setHeader('Content-Type', file.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${file.original_filename}"`);
  res.setHeader('Content-Length', file.size_bytes);
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(filePath);
});

// get /api/download/:shortid
router.get('/download/:shortId', async (req, res) => {
  const result = await db.execute({
    sql: 'SELECT * FROM files WHERE short_id = ? AND is_active = 1',
    args: [req.params.shortId]
  });
  const file = result.rows[0];

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

// post /api/delete/:shortid
router.post('/delete/:shortId', async (req, res) => {
  const user = getAuthUser(req);
  const short_id = req.params.shortId;

  try {
    const result = await db.execute({
      sql: 'SELECT * FROM files WHERE short_id = ?',
      args: [short_id]
    });
    const file = result.rows[0];

    if (!file) return res.status(404).json({ error: 'File not found' });

    // For now, allow deletion if the user is the owner
    // OR if they provided a delete token (if we implement those)
    // Here we check userId association
    if (file.user_id && (!user || user.userId != file.user_id)) {
      return res.status(403).json({ error: 'Unauthorized to delete this file' });
    }

    // Mark as inactive (soft delete) or hard delete
    await db.execute({
      sql: 'UPDATE files SET is_active = 0 WHERE short_id = ?',
      args: [short_id]
    });

    // Delete physical file if it exists on disk
    if (file.stored_filename) {
      const filePath = path.join(UPLOADS_DIR, file.stored_filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    res.json({ success: true, deleted: true });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

module.exports = router;
