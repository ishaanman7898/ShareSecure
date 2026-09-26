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

  // the public tunnel's name is picked once and kept in settings.json (see startTunnel)
  fs.writeFileSync(envPath, content);
  console.log('✅ Generated secure ENCRYPTION_KEY');
  console.log('Setup complete. Starting server...\n');
}

require('dotenv').config({ path: envPath });

const express = require('express');
const { db, UPLOADS_DIR } = require('./db');
const { purgeExpired, purgeOrphans } = require('./purge');
const { requireOwner } = require('./session');
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

// Same policy as the website. Pages only run the app's own scripts, plus pdf.js
// and mammoth from jsDelivr for the viewer; pdf.js starts its worker from a
// blob: URL and decodes some images with WebAssembly ('wasm-unsafe-eval' allows
// WebAssembly, not JS eval). Everything that isn't a page keeps just the
// framing rule. The type is only known once a route has set it, so the header
// is added just before the response goes out (not on a 304, which would
// replace the cached page's policy).
// only the exact versions the viewer loads, not everything jsDelivr serves
const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/';
const MAMMOTH = 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/';
const PAGE_CSP = [
  "default-src 'self'",
  `script-src 'self' ${PDFJS} ${MAMMOTH} 'wasm-unsafe-eval'`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  `connect-src 'self' ${PDFJS}`,
  `worker-src 'self' blob: ${PDFJS}`,
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
app.use('/api', require('./routes/files'));
// the linked ShareSecure account, for sending to usernames
app.use('/api', require('./routes/cloud'));
// assistants (Claude Code, Codex, …) connect here to share files
app.use('/mcp', require('./mcp').router);
app.use('/connect', require('./mcp').connectRouter);

// ── mode endpoint (self-host detection) ───────────────────────────────────────
// Returns selfHostMode: true so the frontend can skip auth and show admin UI.
// This endpoint only exists in the Express server, not in Cloudflare Pages functions,
// so the frontend uses its presence to detect self-hosted mode.
app.get('/api/mode', (_req, res) => {
  const setupRequired = db.prepare("SELECT COUNT(*) AS n FROM users WHERE access_code LIKE 'scrypt$%'").get().n === 0;
  // the public https address links are made with (the tunnel, or your domain), so
  // the app never hands out a localhost link it can't be opened from elsewhere
  const publicUrl = /^https:\/\//.test(process.env.BASE_URL || '') ? process.env.BASE_URL.replace(/\/$/, '') : null;
  res.json({ selfHostMode: true, setupRequired, version: updater.status().current, publicUrl });
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
app.get('/download', (req, res) => res.redirect(301, '/self-host'));

// ── 404 fallback ─────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html')));

// a body that's too big or isn't JSON gets a short answer, not a stack trace
app.use((err, _req, res, next) => {
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'That request is too big.' });
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

// ── public tunnel ─────────────────────────────────────────────────────────────
// The public link (and the AI connector URL built from it) has to stay the same
// across restarts and dropped connections, or everything shared or connected
// before stops working. So the tunnel always asks for the same name: the one in
// TUNNEL_SUBDOMAIN, or else a random one picked on first run and kept in
// settings. When the connection drops it comes back with the same name.
const TUNNEL_MAX_WAIT = 30 * 1000;
const TUNNEL_CHECK_EVERY = 2 * 60 * 1000;
let tunnel = null;         // the open connection
let tunnelHasName = false; // whether it got the name it asked for
let tunnelRetry = null;
let tunnelWait = 1000;
let nameTries = 0;
let failedChecks = 0;
let lastTunnelUrl = null;
let checking = false;

// the names the localtunnel relay accepts; it answers anything else with a 403,
// which localtunnel retries forever without a word
const TUNNEL_NAME = /^(?:[a-z0-9][a-z0-9-]{4,63}[a-z0-9]|[a-z0-9]{4,63})$/;
let warnedBadName = false;

function tunnelSubdomain() {
  const fromEnv = String(process.env.TUNNEL_SUBDOMAIN || '').trim().toLowerCase();
  if (fromEnv && TUNNEL_NAME.test(fromEnv)) return fromEnv;
  if (fromEnv && !warnedBadName) {
    warnedBadName = true;
    console.warn(`  [tunnel] TUNNEL_SUBDOMAIN "${fromEnv}" can't be used: use lowercase letters, numbers and dashes, not starting or ending with a dash (4 to 63 characters, or at least 6 with a dash). Using the saved name instead.`);
  }
  const settings = require('./settings');
  let name = settings.get('tunnelSubdomain');
  if (!TUNNEL_NAME.test(name || '')) {
    const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
    name = 'sharesecure-' + Array.from(crypto.randomBytes(10), b => abc[b % abc.length]).join('');
    settings.set('tunnelSubdomain', name);
  }
  return name;
}

const openTunnel = subdomain => require('localtunnel')({ port: PORT, subdomain });
const nameOf = t => new URL(t.url).hostname.split('.')[0];

// Close a connection without it counting as a drop. Only our own listeners
// come off: localtunnel's own 'close' listeners are what shut its sockets to the
// relay, and without them a closed tunnel keeps holding its name.
function closeQuietly(t) {
  if (!t) return;
  if (t.ssOnError) t.off('error', t.ssOnError);
  if (t.ssOnClose) t.off('close', t.ssOnClose);
  t.on('error', () => {});
  try { t.close(); } catch {}
}

// Try again later, waiting twice as long each time, up to 30 seconds.
function retryTunnel(why) {
  closeQuietly(tunnel);
  tunnel = null;
  if (tunnelRetry) return;
  if (why) console.warn(`  [tunnel] ${why}. Reconnecting in ${Math.round(tunnelWait / 1000)}s…`);
  tunnelRetry = setTimeout(() => { tunnelRetry = null; startTunnel(); }, tunnelWait);
  tunnelRetry.unref?.();
  tunnelWait = Math.min(tunnelWait * 2, TUNNEL_MAX_WAIT);
}

// Make t the public link, and point new links and the AI connector at it.
function useTunnel(t, hasName) {
  const old = tunnel;
  tunnel = t;
  tunnelHasName = hasName;
  closeQuietly(old);
  tunnelWait = 1000;
  failedChecks = 0;

  const url = t.url.replace(/\/$/, '');
  if (process.env.BASE_URL !== url) {
    if (old || lastTunnelUrl) console.log(`  [tunnel] The public link is now ${url}.`);
    process.env.BASE_URL = url;
  }
  lastTunnelUrl = url;
  console.log(`  Public Link  →  ${url}`);
  console.log(`  (Share this public link with anyone on different devices)`);
  if (!hasName) console.warn(`  [tunnel] Got ${url} instead of https://${tunnelSubdomain()}.loca.lt. Will keep trying for the usual one.`);

  t.ssOnError = err => { if (tunnel === t) retryTunnel(`Connection lost (${err.message})`); };
  t.ssOnClose = () => { if (tunnel === t) retryTunnel('Connection closed'); };
  t.on('error', t.ssOnError);
  t.on('close', t.ssOnClose);
}

async function startTunnel() {
  const want = tunnelSubdomain();
  let t;
  try {
    t = await openTunnel(want);
  } catch (err) {
    return retryTunnel(`Couldn’t open the public link (${err.message})`);
  }
  // A dropped connection can hold the name for a little while. Wait for it
  // rather than take a random one; after a few tries, use what we got.
  const hasName = nameOf(t) === want;
  if (!hasName && nameTries < 4) {
    nameTries++;
    closeQuietly(t);
    return retryTunnel(`${want} is still in use`);
  }
  nameTries = 0;
  useTunnel(t, hasName);
}

// The tunnel can die without telling us (the relay forgot us), and then every
// request to the public link gets a 503. Check it now and then from outside,
// and win the usual name back if we had to take another one.
async function checkTunnel() {
  if (!tunnel || checking) return;
  checking = true;
  try { await checkTunnelOnce(); } finally { checking = false; }
}

async function checkTunnelOnce() {
  if (!tunnelHasName) {
    const want = tunnelSubdomain();
    try {
      const t = await openTunnel(want);
      if (nameOf(t) === want && tunnel) return useTunnel(t, true);
      closeQuietly(t);
    } catch { /* keep the one we have */ }
  }
  if (!tunnel) return; // dropped meanwhile; retryTunnel is already on it
  let ok = false;
  try {
    const res = await fetch(`${tunnel.url.replace(/\/$/, '')}/api/mode`, {
      headers: { 'bypass-tunnel-reminder': '1', 'User-Agent': 'ShareSecure' },
      signal: AbortSignal.timeout(15000),
    });
    ok = res.ok;
    await res.body?.cancel().catch(() => {});
  } catch { /* offline or timed out */ }
  failedChecks = ok ? 0 : failedChecks + 1;
  if (failedChecks >= 2 && tunnel) retryTunnel('The public link stopped answering');
}

// ── start ─────────────────────────────────────────────────────────────────────
if (process.env.USE_LOCAL_TUNNEL !== 'false') setInterval(checkTunnel, TUNNEL_CHECK_EVERY).unref();

app.listen(PORT, async () => {
  const { DATA_DIR, DB_PATH } = require('./db');
  console.log(`\n  ShareSecure  →  http://localhost:${PORT}`);
  
  if (process.env.USE_LOCAL_TUNNEL !== 'false') startTunnel();

  updater.start();

  console.log(`\n  Your data    →  ${DATA_DIR}`);
  console.log(`  Database     →  ${DB_PATH}`);
  console.log(`  Uploads      →  ${UPLOADS_DIR}`);
  if (!process.env.ENCRYPTION_KEY) {
    console.warn('\n  [warn] ENCRYPTION_KEY not set — files stored unencrypted on disk.');
    console.warn('         Generate one with: node -e "require(\'crypto\').randomBytes(32).toString(\'hex\') |> console.log"');
    console.warn('         Or run: npm run generate-key\n');
  } else {
    console.log('  Encryption   →  AES-256-GCM enabled\n');
  }
});
