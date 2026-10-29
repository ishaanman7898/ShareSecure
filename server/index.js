'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ENV_FILE lets Docker keep .env (and its encryption key) inside the data volume
const envPath = process.env.ENV_FILE
  ? path.resolve(process.env.ENV_FILE)
  : path.join(__dirname, '../.env');
if (!fs.existsSync(envPath)) {
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
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

  fs.writeFileSync(envPath, content);
  console.log('✅ Generated secure ENCRYPTION_KEY');
  console.log('Setup complete. Starting server...\n');
}

require('dotenv').config({ path: envPath });

const express = require('express');
const { db, UPLOADS_DIR } = require('./db');
const { purgeExpired, purgeOrphans } = require('./purge');
const { requireOwner, fromThisComputer, getSetupCode } = require('./session');
const updater = require('./updater');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, '../public');

// ── IP privacy ───────────────────────────────────────────────────────────────
// Disable trust proxy so Express never treats X-Forwarded-For as real client IP.
app.set('trust proxy', false);

// Strip IP-revealing headers before they reach any route handler.
// This ensures that even if logging is added later, no real client IP
// can be read from standard forwarding headers in application code.
app.use((req, _res, next) => {
  delete req.headers['x-forwarded-for'];
  delete req.headers['x-real-ip'];
  delete req.headers['x-client-ip'];
  delete req.headers['cf-connecting-ip'];
  delete req.headers['true-client-ip'];
  delete req.headers['x-forwarded-host'];
  delete req.headers['forwarded'];
  next();
});

// ── only this computer (desktop) ─────────────────────────────────────────────
// The desktop app's server listens on loopback only (HOST, set by
// desktop/main.js): links reach it through the relay, never the local network.
// A web page could still point a domain of its own at 127.0.0.1 (DNS
// rebinding) to read /api/mode and learn this computer's relay id, which would
// tie a visitor to every link they've shared. So the Host must be this
// computer's own name, or the relay's (relay.js sets it on what it forwards).
const LOOPBACK_ONLY = ['127.0.0.1', '::1', 'localhost'].includes(process.env.HOST);
const OWN_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', 'relay.sharesecure']);
if (LOOPBACK_ONLY) {
  app.use((req, res, next) => {
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    if (OWN_HOSTS.has(host)) return next();
    res.status(421).json({ error: 'Not found' });
  });
}

// ── security headers ─────────────────────────────────────────────────────────
app.use((_req, res, next) => {
  // Prevent the browser from sending the current URL as a Referer on any request
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Prevent MIME-type sniffing (protects against content-type confusion attacks)
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Deny embedding in iframes (prevents clickjacking)
  res.setHeader('X-Frame-Options', 'DENY');
  // Disable browser features that could leak location or enable covert capture
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  next();
});

// Same policy as the website. Pages only run the app's own scripts (pdf.js and
// mammoth are served from /vendor); pdf.js starts its worker from a
// blob: URL and decodes some images with WebAssembly ('wasm-unsafe-eval' allows
// WebAssembly, not JS eval). Everything that isn't a page keeps just the
// framing rule. The type is only known once a route has set it, so the header
// is added just before the response goes out (not on a 304, which would
// replace the cached page's policy).
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

app.use((_req, res, next) => {
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    const status = typeof args[0] === 'number' ? args[0] : this.statusCode;
    if (!this.headersSent && status !== 304) {
      const isPage = String(this.getHeader('Content-Type') || '').includes('text/html');
      this.setHeader('Content-Security-Policy', isPage ? PAGE_CSP : "frame-ancestors 'none'");
    }
    return writeHead.apply(this, args);
  };
  next();
});

// ── middleware ───────────────────────────────────────────────────────────────
// Assistants send files inline to /mcp and /connect, so those read their own,
// bigger bodies (see mcp.js); everything else keeps the 2 MB limit.
const jsonBody = express.json({ limit: '2mb' });
app.use((req, res, next) => (/^\/(mcp|connect)(\/|$)/.test(req.path) ? next() : jsonBody(req, res, next)));

// nothing about a file or a session may be cached by the browser
app.use(['/api', '/r'], (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
// revalidate on every load so an update never leaves a browser on stale code
app.use(express.static(PUBLIC_DIR, { maxAge: 0, etag: true }));

// ── api routes ───────────────────────────────────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/inbox'));
const filesRouter = require('./routes/files');
const MAX_UPLOAD = filesRouter.MAX_BYTES;
app.use('/api', filesRouter);
// the linked ShareSecure account, for sending to usernames
app.use('/api', require('./routes/cloud'));
// assistants (Claude Code, Codex, …) connect here to share files
app.use('/mcp', require('./mcp').router);
app.use('/connect', require('./mcp').connectRouter);

// ── mode endpoint (self-host detection) ───────────────────────────────────────
// Returns selfHostMode: true so the frontend can skip auth and show admin UI.
// This endpoint only exists in the Express server, not in Cloudflare Pages functions,
// so the frontend uses its presence to detect self-hosted mode.
app.get('/api/mode', (req, res) => {
  const setupRequired = db.prepare("SELECT COUNT(*) AS n FROM users WHERE access_code LIKE 'scrypt$%'").get().n === 0;
  // the public https address links are made with (the relay, or your domain), so
  // the app never hands out a localhost link it can't be opened from elsewhere
  const publicUrl = /^https:\/\//.test(process.env.BASE_URL || '') ? process.env.BASE_URL.replace(/\/$/, '') : null;
  res.json({ selfHostMode: true, setupRequired, setupCodeNeeded: setupRequired && !fromThisComputer(req), version: updater.status().current, publicUrl, maxUpload: MAX_UPLOAD });
});

// ── updates (owner only) ──────────────────────────────────────────────────────
app.get('/api/update/status', requireOwner, (_req, res) => res.json(updater.status()));
app.post('/api/update/check', requireOwner, async (_req, res) => res.json(await updater.check()));
app.post('/api/update/apply', requireOwner, async (_req, res) => {
  try { res.json(await updater.apply()); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/update/settings', requireOwner, (req, res) => {
  res.json(updater.setAutoUpdate(req.body?.autoUpdate === true));
});

// ── viewer ───────────────────────────────────────────────────────────────────
app.get('/r/:shortId', (req, res) => {
  const file = db.prepare(
    'SELECT short_id, expires_at, is_active FROM files WHERE short_id = ?'
  ).get(req.params.shortId);

  if (!file || !file.is_active) {
    return res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
  }
  if (file.expires_at && file.expires_at <= new Date().toISOString()) {
    purgeExpired();
    return res.status(410).sendFile(path.join(PUBLIC_DIR, 'expired.html'));
  }
  res.sendFile(path.join(PUBLIC_DIR, 'viewer.html'));
});

// ── home ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// ── terms and conditions ─────────────────────────────────────────────────────
app.get('/terms', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'terms.html'));
});
// legacy redirect
app.get('/TERMS_AND_CONDITIONS.md', (req, res) => res.redirect(301, '/terms'));

// ── privacy and security ──────────────────────────────────────────────────────
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'privacy.html'));
});
app.get('/security', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'security.html'));
});

// ── changelog ─────────────────────────────────────────────────────────────────
app.get('/changelog', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'changelog.html'));
});

// ── old "send me a file" page ─────────────────────────────────────────────────
// Gone: sending now goes to usernames. Old links land on the home page.
app.get('/send', (req, res) => res.redirect(302, '/'));

// ── sign in ───────────────────────────────────────────────────────────────────
app.get('/signin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'signin.html')));

// ── self-host guide ───────────────────────────────────────────────────────────
app.get('/self-host', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'self-host.html'));
});
app.get('/download', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'download.html')));

// ── 404 fallback ─────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html')));

// a body that's too big or isn't JSON gets a short answer, not a stack trace
app.use((err, _req, res, next) => {
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'That request is too big.' });
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `File too large. Max ${MAX_UPLOAD / 1024 / 1024} MB.` });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request isn’t valid JSON.' });
  next(err);
});

// ── erase expired files ───────────────────────────────────────────────────────
// Expired links are erased within 30 seconds (and instantly if someone opens one).
function sweep() {
  try {
    const n = purgeExpired();
    if (n > 0) console.log(`  [cleanup] Erased ${n} expired link(s).`);
  } catch (err) {
    console.error('[cleanup] Error:', err.message);
  }
}

// Self-hosted instances have no daily limit, so the old upload log isn't needed.
db.exec('DELETE FROM upload_log');
purgeOrphans();
sweep();
setInterval(sweep, 30 * 1000);

// ── start ─────────────────────────────────────────────────────────────────────
// Links reach this computer through ShareSecure's relay (relay.js), unless
// it's turned off (you have your own domain in BASE_URL). USE_LOCAL_TUNNEL is
// its old name, from when that was localtunnel.
const useRelay = process.env.USE_RELAY !== 'false' && process.env.USE_LOCAL_TUNNEL !== 'false';

// HOST limits who can connect (the desktop app: loopback only); without it,
// every interface, as a self-hosted server needs.
const HOST = process.env.HOST || null;
const onListen = async () => {
  const { DATA_DIR, DB_PATH } = require('./db');
  console.log(`\n  ShareSecure  →  http://localhost:${PORT}`);
  
  if (useRelay) require('./relay').start(PORT);

  updater.start();

  console.log(`\n  Your data    →  ${DATA_DIR}`);
  console.log(`  Database     →  ${DB_PATH}`);
  console.log(`  Uploads      →  ${UPLOADS_DIR}`);
  if (!db.prepare("SELECT COUNT(*) AS n FROM users WHERE access_code LIKE 'scrypt$%'").get().n) {
    console.log(`
  Setup code   →  ${getSetupCode()}`);
    console.log('  (Setting up the owner account from another device asks for it.)');
  }
  if (!process.env.ENCRYPTION_KEY) {
    console.warn('\n  [warn] ENCRYPTION_KEY not set — files stored unencrypted on disk.');
    console.warn('         Generate one with: node -e "require(\'crypto\').randomBytes(32).toString(\'hex\') |> console.log"');
    console.warn('         Or run: npm run generate-key\n');
  } else {
    console.log('  Encryption   →  AES-256-GCM enabled\n');
  }
};
if (!HOST) app.listen(PORT, onListen);
else {
  app.listen(PORT, HOST, onListen);
  // "localhost" can be IPv6 first; that loopback too, where there is one
  if (HOST === '127.0.0.1') require('http').createServer(app).listen(PORT, '::1').on('error', () => {});
}
