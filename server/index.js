'use strict';
require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const { db, UPLOADS_DIR } = require('./db');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, '../public');

// ── middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.static(PUBLIC_DIR, { maxAge: '1h', etag: true }));

// ── api routes ───────────────────────────────────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/files'));

// ── viewer ───────────────────────────────────────────────────────────────────
app.get('/r/:shortId', (req, res) => {
  const file = db.prepare(
    'SELECT short_id, expires_at, is_active FROM files WHERE short_id = ?'
  ).get(req.params.shortId);

  if (!file || !file.is_active) {
    return res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
  }
  if (file.expires_at && new Date(file.expires_at) < new Date()) {
    return res.status(410).sendFile(path.join(PUBLIC_DIR, 'expired.html'));
  }
  res.sendFile(path.join(PUBLIC_DIR, 'viewer.html'));
});

// ── home ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// ── 404 fallback ─────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html')));

// ── expired file cleanup ──────────────────────────────────────────────────────
function cleanupExpired() {
  try {
    // collect stored filenames before deleting rows
    const expired = db.prepare(
      "SELECT DISTINCT stored_filename FROM files WHERE expires_at < datetime('now') AND stored_filename IS NOT NULL"
    ).all();

    const result = db.prepare(
      "DELETE FROM files WHERE expires_at < datetime('now')"
    ).run();

    // remove orphaned disk files (only if no other active file still references them)
    const stillReferenced = new Set(
      db.prepare('SELECT DISTINCT stored_filename FROM files WHERE stored_filename IS NOT NULL').all()
        .map(r => r.stored_filename)
    );

    let diskDeleted = 0;
    for (const row of expired) {
      if (row.stored_filename && !stillReferenced.has(row.stored_filename)) {
        const fp = path.join(UPLOADS_DIR, row.stored_filename);
        if (fs.existsSync(fp)) {
          fs.unlinkSync(fp);
          diskDeleted++;
        }
      }
    }

    if (result.changes > 0) {
      console.log(`[cleanup] Removed ${result.changes} expired record(s), ${diskDeleted} file(s) from disk.`);
    }
  } catch (err) {
    console.error('[cleanup] Error:', err.message);
  }
}

cleanupExpired();
setInterval(cleanupExpired, 60 * 60 * 1000); // hourly

// ── start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const { DATA_DIR, DB_PATH } = require('./db');
  console.log(`\n  ShareSecure  →  http://localhost:${PORT}`);
  console.log(`  Database     →  ${DB_PATH}`);
  console.log(`  Uploads      →  ${UPLOADS_DIR}`);
  if (!process.env.ENCRYPTION_KEY) {
    console.warn('\n  [warn] ENCRYPTION_KEY not set — files stored unencrypted on disk.');
    console.warn('         Generate one with: node -e "require(\'crypto\').randomBytes(32).toString(\'hex\') |> console.log"');
    console.warn('         Or run: npm run generate-key\n');
  } else {
    console.log('  Encryption   →  AES-256-GCM enabled');
  }
});
