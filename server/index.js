'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const envPath = path.join(__dirname, '../.env');
if (!fs.existsSync(envPath)) {
  console.log('--- FIRST TIME SETUP ---');
  console.log('Creating .env configuration file...');
  const examplePath = path.join(__dirname, '../.env.example');
  let content = fs.existsSync(examplePath) ? fs.readFileSync(examplePath, 'utf8') : '';
  
  const key = crypto.randomBytes(32).toString('hex');
  if (content.includes('ENCRYPTION_KEY=')) {
    content = content.replace(/ENCRYPTION_KEY=.*/, `ENCRYPTION_KEY=${key}`);
  } else {
    content += `\nENCRYPTION_KEY=${key}\n`;
  }

  const subdomain = 'sharesecure-local-' + crypto.randomBytes(4).toString('hex');
  if (content.includes('TUNNEL_SUBDOMAIN=')) {
    content = content.replace(/#?\s*TUNNEL_SUBDOMAIN=.*/, `TUNNEL_SUBDOMAIN=${subdomain}`);
  } else {
    content += `\nTUNNEL_SUBDOMAIN=${subdomain}\n`;
  }

  fs.writeFileSync(envPath, content);
  console.log('✅ Generated secure ENCRYPTION_KEY');
  console.log(`✅ Assigned stable public subdomain: ${subdomain}`);
  console.log('Setup complete. Starting server...\n');
}

require('dotenv').config({ path: envPath });

const express = require('express');
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

// ── terms and conditions ─────────────────────────────────────────────────────
app.get('/TERMS_AND_CONDITIONS.md', (req, res) => {
  res.sendFile(path.join(__dirname, '../TERMS_AND_CONDITIONS.md'));
});

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
// ── start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  const { DATA_DIR, DB_PATH } = require('./db');
  console.log(`\n  ShareSecure  →  http://localhost:${PORT}`);
  
  if (process.env.USE_LOCAL_TUNNEL !== 'false') {
    try {
      const localtunnel = require('localtunnel');
      const options = { port: PORT };
      if (process.env.TUNNEL_SUBDOMAIN) {
        options.subdomain = process.env.TUNNEL_SUBDOMAIN;
      }
      
      const tunnel = await localtunnel(options);
      console.log(`  Public Link  →  ${tunnel.url}`);
      console.log(`  (Share this public link with anyone on different devices)`);
      process.env.BASE_URL = tunnel.url;

      tunnel.on('close', () => {
        console.log('  [tunnel] Connection closed.');
      });
    } catch (err) {
      console.warn('  [warn] Could not start public tunnel:', err.message);
    }
  }

  console.log(`\n  Database     →  ${DB_PATH}`);
  console.log(`  Uploads      →  ${UPLOADS_DIR}`);
  if (!process.env.ENCRYPTION_KEY) {
    console.warn('\n  [warn] ENCRYPTION_KEY not set — files stored unencrypted on disk.');
    console.warn('         Generate one with: node -e "require(\'crypto\').randomBytes(32).toString(\'hex\') |> console.log"');
    console.warn('         Or run: npm run generate-key\n');
  } else {
    console.log('  Encryption   →  AES-256-GCM enabled\n');
  }
});
