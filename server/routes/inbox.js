'use strict';
// Files sent to the owner of a self-hosted ShareSecure.
//
// Each file arrives as a request (stored inactive, so no link can open it) and
// waits until the owner accepts it; declining erases it right away. The public
// page that let people send files here is gone, but requests it left behind can
// still be accepted or declined.
const express = require('express');
const router = express.Router();

const { db } = require('../db');
const { requireOwner } = require('../session');
const { decryptString, getEncKey } = require('../utils');
const { purgeOne } = require('../purge');

const nowIso = () => new Date().toISOString();

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

module.exports = router;
