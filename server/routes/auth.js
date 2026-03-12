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
// The dashboard is now client-side (localStorage).  This endpoint only returns
// the authoritative daily upload count so the UI can show "Used X/5 today"
// even if the user clears localStorage.  No file records are returned from the
// server — there is no longer a server-side link between files and accounts.
router.get('/user/files', (req, res) => {
  const auth = decodeToken(req.headers.authorization);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const userTag = getUserTag(auth.userId);

    const dailyRow = db.prepare(
      "SELECT COUNT(*) AS count FROM upload_log WHERE user_tag = ? AND uploaded_at > datetime('now', '-1 day')"
    ).get(userTag);

    res.json({
      files: [],                             // always empty — list lives in localStorage
      dailyUploadCount: Number(dailyRow.count),
    });
  } catch (err) {
    console.error('[auth] Dashboard error:', err.message);
    res.status(500).json({ error: 'Failed to load files' });
  }
});

module.exports = router;
