'use strict';
// Self-hosted sign-in. A self-hosted ShareSecure has exactly one account: the
// owner, created on first run from the setup page. After that registration is closed.
const express = require('express');
const router  = express.Router();

const crypto = require('crypto');
const { db } = require('../db');
const session = require('../session');
const settings = require('../settings');
const { purgeAll } = require('../purge');
const { getEncKey, decryptString } = require('../utils');

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

// ── POST /api/auth/delete-account ─────────────────────────────────────────────
// Deleting the owner account erases every file, the account and its sessions,
// and puts this ShareSecure back to first-run setup. The encryption key and
// public link stay, so a new owner can start straight away.
router.post('/delete-account', session.requireOwner, (req, res) => {
  const password = String(req.body?.access_code || '');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.userId);
  if (!user || !session.verifyPassword(password, user.access_code).ok) {
    return res.status(403).json({ error: 'Wrong password' });
  }

  // take back what was sent to usernames first, while the copies are still known
  require('./cloud').forgetAllCloudCopies().catch(() => {});
  purgeAll();
  db.transaction(() => {
    db.prepare('DELETE FROM users').run();
    try { db.prepare('DELETE FROM upload_log').run(); } catch {}
  })();
  // a new signing secret ends every existing session and assistant token
  settings.set('sessionSecret', crypto.randomBytes(32).toString('hex'));
  // unlink the ShareSecure account too; the next owner can link their own
  settings.set('cloudToken', null);
  settings.set('cloudUsername', null);
  settings.set('mcpTokenHash', null);
  res.json({ deleted: true });
});

// ── /api/auth/mcp-token: the token assistants use to connect ──────────────────
const mcpUrl = () => `http://localhost:${process.env.PORT || 3000}/mcp`;
// apps like Claude and ChatGPT need a public https address: the tunnel, or your domain
const reach = () => ({
  publicUrl: /^https:\/\//.test(process.env.BASE_URL || '') ? process.env.BASE_URL.replace(/\/$/, '') : null,
  gptActions: false,
});

router.get('/mcp-token', session.requireOwner, (_req, res) => {
  res.json({ ...require('../mcp').tokenStatus(), mcpUrl: mcpUrl(), ...reach() });
});

router.post('/mcp-token', session.requireOwner, (_req, res) => {
  res.json({ token: require('../mcp').createToken(), mcpUrl: mcpUrl(), ...reach() });
});

router.delete('/mcp-token', session.requireOwner, (_req, res) => {
  require('../mcp').revokeToken();
  res.json({ hasToken: false });
});

// ── GET /api/auth/user/files ──────────────────────────────────────────────────
// Live shares, so ones made by an assistant show up in the dashboard too.
// Self-hosted instances have no daily limit.
router.get('/user/files', session.requireOwner, (_req, res) => {
  const key = getEncKey();
  const rows = db.prepare(`
    SELECT short_id, original_filename, mime_type, size_bytes, uploaded_at, expires_at, delete_token
    FROM files WHERE is_active = 1 AND inbox_status IS NULL AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY uploaded_at DESC LIMIT 50
  `).all(new Date().toISOString());
  const plain = v => { try { return decryptString(v, key); } catch { return v; } };
  const base = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  const files = rows.map(r => ({
    ...r,
    original_filename: plain(r.original_filename),
    mime_type: plain(r.mime_type),
    short_url: `${base}/r/${r.short_id}`,
  }));
  res.json({ files, dailyUploadCount: 0, unlimited: true, publicUrl: reach().publicUrl });
});

module.exports = router;
