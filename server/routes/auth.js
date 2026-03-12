'use strict';
const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');

const { db }                    = require('../db');
const { decodeToken, getUserTag } = require('../utils');

function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

// ── POST /api/auth/register ───────────────────────────────────────────────────
router.post('/register', (req, res) => {
  const { username, access_code } = req.body || {};

  if (!username || !access_code) {
    return res.status(400).json({ error: 'Username and access code required' });
  }
  if (username.length < 2 || username.length > 32) {
    return res.status(400).json({ error: 'Username must be 2–32 characters' });
  }
  if (access_code.length < 6) {
    return res.status(400).json({ error: 'Access code must be at least 6 characters' });
  }

  const hashed = hashCode(access_code);

  try {
    const result = db.prepare(
      'INSERT INTO users (username, access_code) VALUES (?, ?)'
    ).run(username.trim(), hashed);

    res.json({ success: true, userId: String(result.lastInsertRowid) });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Username already taken' });
    }
    console.error('[auth] Registration error:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const { username, access_code } = req.body || {};

  if (!username || !access_code) {
    return res.status(400).json({ error: 'Username and access code required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());

  if (!user || user.access_code !== hashCode(access_code)) {
    return res.status(401).json({ error: 'Invalid username or access code' });
  }

  const token = Buffer.from(`${user.username}:${user.id}`).toString('base64');

  res.json({
    success:  true,
    userId:   String(user.id),
    username: user.username,
    token,
  });
});

// ── GET /api/auth/user/files ──────────────────────────────────────────────────
router.get('/user/files', (req, res) => {
  const auth = decodeToken(req.headers.authorization);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { getEncKey, decryptString } = require('../utils');
    const encKey  = getEncKey();
    const userTag = getUserTag(auth.userId);

    // Query active files by pseudonymous tag — no username or user_id in query
    const files = db.prepare(`
      SELECT short_id, original_filename, mime_type, size_bytes, uploaded_at, expires_at, download_count
      FROM files
      WHERE user_tag = ? AND is_active = 1
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY uploaded_at DESC
    `).all(userTag);

    // Count from upload_log — persists even after files are deleted
    const dailyRow = db.prepare(
      "SELECT COUNT(*) AS count FROM upload_log WHERE user_tag = ? AND uploaded_at > datetime('now', '-1 day')"
    ).get(userTag);

    const decrypted = files.map(f => ({
      ...f,
      original_filename: decryptString(f.original_filename, encKey),
      mime_type:         decryptString(f.mime_type, encKey),
    }));

    res.json({
      files: decrypted,
      dailyUploadCount: Number(dailyRow.count),
    });
  } catch (err) {
    console.error('[auth] Dashboard error:', err.message);
    res.status(500).json({ error: 'Failed to load files' });
  }
});

module.exports = router;
