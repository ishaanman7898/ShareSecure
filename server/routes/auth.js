'use strict';
// Self-hosted sign-in. A self-hosted ShareSecure has exactly one account: the
// owner, created on first run from the setup page. After that registration is closed.
const express = require('express');
const router  = express.Router();

const { db } = require('../db');
const session = require('../session');

const MIN_PASSWORD = 8;

// Only accounts created by the setup page count. Older rows (unsalted hashes,
// including one that used to ship inside the repo's database) are ignored and
// cleared when the owner is created.
function ownerExists() {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE access_code LIKE 'scrypt$%'").get().n > 0;
}

// ── GET /api/auth/status ──────────────────────────────────────────────────────
router.get('/status', (_req, res) => {
  res.json({ setupRequired: !ownerExists() });
});

// ── POST /api/auth/register (first-run setup only) ──────────────────────────
router.post('/register', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.access_code || '');

  if (username.length < 2 || username.length > 32) {
    return res.status(400).json({ error: 'Username must be 2–32 characters.' });
  }
  if (password.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
  }

  const hashed = session.hashPassword(password);
  const create = db.transaction(() => {
    if (ownerExists()) return null;
    db.prepare('DELETE FROM users').run();
    return db.prepare('INSERT INTO users (username, access_code) VALUES (?, ?)').run(username, hashed);
  });

  const result = create();
  if (!result) return res.status(403).json({ error: 'This ShareSecure already has an owner. Sign in instead.' });
  res.json({ success: true });
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const wait = session.lockoutRemainingMs();
  if (wait > 0) {
    return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(wait / 1000)} seconds.` });
  }

  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.access_code || '');
  const user = db.prepare("SELECT * FROM users WHERE username = ? AND access_code LIKE 'scrypt$%'").get(username);
  const check = user ? session.verifyPassword(password, user.access_code) : { ok: false };

  if (!check.ok) {
    session.recordFailure();
    return res.status(401).json({ error: 'Wrong username or password.' });
  }

  session.recordSuccess();

  res.json({ success: true, username: user.username, token: session.issueToken(user) });
});

// ── GET /api/auth/user/files ──────────────────────────────────────────────────
// The dashboard list lives in the browser. Self-hosted instances have no daily limit.
router.get('/user/files', session.requireOwner, (_req, res) => {
  res.json({ files: [], dailyUploadCount: 0, unlimited: true });
});

module.exports = router;
