'use strict';
// Files people send to the owner of a self-hosted ShareSecure.
//
// Anyone who can reach this server can send the owner a file by entering the
// owner's username on /send — but only after the owner turns that on. Each file
// arrives as a request (stored inactive, so no link can open it) and waits
// until the owner accepts it; declining erases it right away.
const express = require('express');
const router = express.Router();

const { db } = require('../db');
const { requireOwner } = require('../session');
const { decryptString, getEncKey } = require('../utils');
const { purgeOne } = require('../purge');
const settings = require('../settings');
const { storeFile, upload } = require('./files');

const MAX_PENDING = 20;          // requests waiting at once
const MAX_PER_HOUR = 30;         // incoming files per hour, from everyone combined
const NOTE_MAX = 140;

let recent = [];                 // timestamps of recent incoming files (memory only)

const nowIso = () => new Date().toISOString();

function owner() {
  return db.prepare("SELECT username FROM users WHERE access_code LIKE 'scrypt$%' LIMIT 1").get();
}

function pendingCount() {
  return db.prepare(
    "SELECT COUNT(*) AS n FROM files WHERE inbox_status = 'pending' AND expires_at > ?"
  ).get(nowIso()).n;
}

// ── public: can people send files here? ───────────────────────────────────────
router.get('/incoming/status', (_req, res) => {
  res.json({ enabled: settings.get('acceptIncoming') === true && Boolean(owner()) });
});

// ── public: send the owner a file ─────────────────────────────────────────────
router.post('/incoming', (req, res, next) => {
  // refuse before reading the upload body when sending is switched off
  if (settings.get('acceptIncoming') !== true) {
    return res.status(403).json({ error: 'This ShareSecure isn’t accepting files right now.' });
  }
  next();
}, upload.single('file'), (req, res) => {
  const o = owner();
  const username = String(req.body.username || '').trim();
  if (!o || username.toLowerCase() !== o.username.toLowerCase()) {
    return res.status(404).json({ error: 'No one with that username accepts files here.' });
  }
  if (!req.file) return res.status(400).json({ error: 'Choose a file to send.' });

  const hourAgo = Date.now() - 60 * 60 * 1000;
  recent = recent.filter(t => t > hourAgo);
  if (recent.length >= MAX_PER_HOUR || pendingCount() >= MAX_PENDING) {
    return res.status(429).json({ error: 'Their inbox is full right now. Try again later.' });
  }

  const note = String(req.body.note || '').trim().slice(0, NOTE_MAX);
  const stored = storeFile(req.file, req.body, { incoming: true, note });
  if (stored.error) return res.status(stored.status).json({ error: stored.error });

  recent.push(Date.now());
  console.log('  [inbox] A new file is waiting for you to accept or decline.');
  res.json({ sent: true });
});

// ── owner: list files sent to you ─────────────────────────────────────────────
router.get('/inbox', requireOwner, (_req, res) => {
  const encKey = getEncKey();
  const rows = db.prepare(`
    SELECT short_id, original_filename, mime_type, size_bytes, expires_at, delete_token,
           inbox_status, inbox_note
    FROM files
    WHERE inbox_status IN ('pending', 'accepted') AND expires_at > ?
    ORDER BY uploaded_at DESC, id DESC
    LIMIT 50
  `).all(nowIso());

  res.json({
    files: rows.map(r => {
      const pending = r.inbox_status === 'pending';
      return {
        short_id: r.short_id,
        original_filename: decryptString(r.original_filename, encKey),
        mime_type: decryptString(r.mime_type, encKey),
        size_bytes: r.size_bytes,
        expires_at: r.expires_at,
        status: pending ? 'pending' : 'accepted',
        note: r.inbox_note ? decryptString(r.inbox_note, encKey) : null,
        delete_token: pending ? null : r.delete_token,
      };
    }),
  });
});

// ── owner: accept or decline a request ───────────────────────────────────────
router.post('/inbox/:shortId', requireOwner, (req, res) => {
  const action = req.body?.action;
  if (action !== 'accept' && action !== 'decline') {
    return res.status(400).json({ error: 'action must be accept or decline' });
  }
  const row = db.prepare(
    "SELECT short_id FROM files WHERE short_id = ? AND inbox_status = 'pending' AND expires_at > ?"
  ).get(req.params.shortId, nowIso());
  if (!row) return res.status(404).json({ error: 'Request not found' });

  if (action === 'accept') {
    db.prepare("UPDATE files SET is_active = 1, inbox_status = 'accepted' WHERE short_id = ?").run(row.short_id);
    return res.json({ accepted: true });
  }
  purgeOne(row.short_id);
  res.json({ declined: true });
});

// ── owner: turn incoming files on or off ─────────────────────────────────────
// sendUrl is the public address (the tunnel or BASE_URL) people use to reach /send.
function receiveSettings(req) {
  const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  return { enabled: settings.get('acceptIncoming') === true, username: req.auth.username, sendUrl: `${base}/send` };
}

router.get('/settings/incoming', requireOwner, (req, res) => res.json(receiveSettings(req)));

router.post('/settings/incoming', requireOwner, (req, res) => {
  settings.set('acceptIncoming', req.body?.enabled === true);
  res.json(receiveSettings(req));
});

module.exports = router;
