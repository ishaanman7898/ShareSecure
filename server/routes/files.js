'use strict';
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const { db, UPLOADS_DIR } = require('../db');
const {
  generateId, LINK_ID_LENGTH, hmacHex, compress, decompress, getEncKey, encryptString, decryptString,
  quantizeToHour, padSize, randomHex, encryptWithPerFileKey, decryptWithPerFileKey,
  stripDocxMetadata, stripPdfMetadata,
} = require('../utils');
const { requireOwner, verifyToken } = require('../session');
const { purgeExpired, purgeLink } = require('../purge');

const isExpired = file => Boolean(file.expires_at && file.expires_at <= new Date().toISOString());

// A link that has expired is erased the moment anyone touches it, not at the next sweep.
function goneIfExpired(file, res, asJson = true) {
  if (!file) {
    asJson ? res.status(404).json({ error: 'File not found' }) : res.status(404).send('Not found');
    return true;
  }
  if (isExpired(file)) {
    purgeExpired();
    asJson ? res.status(410).json({ error: 'Link expired' }) : res.status(410).send('Expired');
    return true;
  }
  return false;
}

// The website keeps files to 10 MB, but here they're on the owner's own disk,
// so they can be bigger. Each one is still read into memory to strip, compress
// and encrypt it, so there's a cap.
const MAX_BYTES = 100 * 1024 * 1024; // 100 MB

// ── file types ───────────────────────────────────────────────────────────────
// The website's own checks (public/filetypes.js), from the bytes, never the name.
// It's an ES module, so it's loaded once and awaited where it's used.
let types;
const typesReady = import('../../public/filetypes.js').then(m => { types = m; });
const TEXT_MIMES = ['text/plain', 'text/markdown', 'text/csv'];
const isTextMime = mime => TEXT_MIMES.includes(String(mime || '').split(';')[0].trim().toLowerCase());

// Memory storage — we process (compress/encrypt) before writing to disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
});

// The browser modules that lock files end to end (public/sealed.js).
let sealed;
const sealedReady = import('../../public/sealed.js').then(m => { sealed = m; });

// Validate, strip metadata, compress, encrypt and store an uploaded file.
// Used for the owner's uploads and for files people send to the owner
// (`incoming`), which are stored inactive until the owner accepts them.
//
// Shares are locked end to end, so the relay that carries their links only
// ever sees locked bytes (relay.js):
//   - the app locks them in the browser (body.e2e = '1', body.meta), and the
//     key stays in the link;
//   - `seal` locks one here (an assistant's share), keeping its key encrypted
//     with the share (local_key) so this computer can list and send it.
// → { shortId, deleteToken, expires_at, paddedSize, displayName, linkKey? }
async function storeFile(file, body, { incoming = false, note = null, seal = false } = {}) {
  await typesReady;
  await sealedReady;
  const lockedInBrowser = !incoming && body.e2e === '1';
  const encKey = getEncKey();

  // This computer hosts its own shares, so they can last as long as you like,
  // or until you delete them ("never"); at least a minute. Files sent to you
  // keep the website's 10 days at most.
  const rawHours = parseFloat(body.expires_hours) || 1;
  const expiresHours = Math.min(Math.max(rawHours, 1 / 60), incoming ? 240 : 100 * 365 * 24);
  const expires_at = body.expires_hours === 'never' && !incoming ? null
    : new Date(Date.now() + expiresHours * 3600 * 1000).toISOString();
  const allow_annotations = body.allow_annotations === '1' ? 1 : 0;
  const view = { watermark: body.watermark === '1', discourage: body.discourage === '1' };

  let mimeType, displayName, allow_download, rawBuffer, meta = null, linkKey = null;
  if (lockedInBrowser) {
    // already a locked box: nothing here can (or needs to) look inside
    if (!sealed.isSealed(body.meta) || String(body.meta).length > 4096) return { error: 'A locked file needs its locked name.', status: 400 };
    if (body.passcode_salt && !/^[A-Za-z0-9_-]{16,64}$/.test(String(body.passcode_salt))) return { error: 'Bad passcode salt.', status: 400 };
    mimeType = 'application/octet-stream';
    displayName = null;
    meta = String(body.meta);
    allow_download = body.allow_download === '1' ? 1 : 0;
    rawBuffer = file.buffer;
  } else {
    mimeType = types.detectType(file.buffer, file.originalname, file.mimetype);   // never the client's claim
    if (!mimeType || mimeType === types.NOT_UTF8) return { error: mimeType ? types.ENCODING_ERROR : types.TYPES_ERROR, status: 415 };
    // a file the viewer can't show can always be saved, or it's no use at all
    allow_download = body.allow_download === '1' || !types.canView(mimeType) ? 1 : 0;
    displayName = types.nameFor(body.display_name, file.originalname, mimeType);
    // ── strip in-file metadata (author, creator, timestamps, XMP) ────────────
    // (text has none to strip)
    rawBuffer = file.buffer;
    // Word, Excel and PowerPoint files all keep it in docProps/
    if ([types.DOCX, types.XLSX, types.PPTX].includes(mimeType)) rawBuffer = stripDocxMetadata(rawBuffer);
    if (mimeType === 'application/pdf') rawBuffer = stripPdfMetadata(rawBuffer);
    if (seal) {
      linkKey = sealed.newFileKey();
      meta = await sealed.lockMeta(linkKey, { name: displayName, type: mimeType, ...view });
      rawBuffer = Buffer.from(await sealed.lockFile(linkKey, new Uint8Array(rawBuffer), MAX_BYTES));
    }
  }
  const e2e = Boolean(meta);

  const shortId     = generateId(LINK_ID_LENGTH);
  const deleteToken = generateId(24);

  // HMAC-SHA256 integrity hash (keyed — not searchable in public hash databases)
  const integrity_hash = hmacHex(rawBuffer);

  // compress then optionally encrypt with per-file key wrapping
  let processed = compress(rawBuffer);
  const isEncrypted = encKey ? 1 : 0;
  let wrappedKey = null;
  if (encKey) {
    const result = encryptWithPerFileKey(processed, encKey);
    processed  = result.data;
    wrappedKey = result.wrappedKey;
  }

  const storedFilename = generateId(32) + '.bin';
  fs.writeFileSync(path.join(UPLOADS_DIR, storedFilename), processed);

  // privacy: quantize upload time to hour boundary; pad size to 100 KB boundary
  const uploaded_at = quantizeToHour();
  const paddedSize  = padSize(rawBuffer.length);

  db.prepare(`
    INSERT INTO files (
      short_id, original_filename, mime_type, size_bytes, stored_filename,
      integrity_hash, compressed, encrypted, uploaded_at, expires_at, delete_token,
      wrapped_key, cluster_id, allow_annotations, allow_download,
      is_active, inbox_status, inbox_note, view_opts, e2e, passcode_salt, local_key
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    shortId, encryptString(e2e ? meta : displayName, encKey), encryptString(mimeType, encKey), paddedSize, storedFilename,
    integrity_hash, isEncrypted, uploaded_at, expires_at, deleteToken,
    wrappedKey,
    shortId, // cluster_id = shortId (own random cluster, not shared with reshares)
    allow_annotations, allow_download,
    incoming ? 0 : 1,
    incoming ? 'pending' : null,
    note ? encryptString(note, encKey) : null,
    // locked shares carry these in their locked name instead
    !incoming && !e2e && (view.watermark || view.discourage) ? encryptString(JSON.stringify(view), encKey) : null,
    e2e ? 1 : 0,
    lockedInBrowser && body.passcode_salt ? String(body.passcode_salt) : null,
    linkKey ? encryptString(sealed.toB64url(linkKey), encKey) : null
  );

  return { shortId, deleteToken, expires_at, paddedSize, displayName, linkKey };
}

// A share's name, type and key, for this computer's own lists and sends.
// Locked ones open with the key kept for them (local_key), or one the caller
// has (the browser that made it). → { name, type, key } or null
async function openShare(file, keyB64 = null) {
  await sealedReady;
  const encKey = getEncKey();
  const stored = decryptString(file.original_filename, encKey);
  if (!file.e2e) return { name: stored, type: decryptString(file.mime_type, encKey), key: null };
  const b64 = keyB64 || (file.local_key ? decryptString(file.local_key, encKey) : null);
  if (!b64) return null;
  try {
    const key = sealed.fromB64url(b64);
    return { ...(await sealed.unlockMeta(key, stored)), key };
  } catch { return null; }
}

// Came through the relay (relay.js): only shares locked end to end are
// answered, so nothing readable ever passes through it.
const viaRelay = req => req.headers['x-sharesecure-relay'] === '1';
router.use(['/info/:shortId', '/raw/:shortId', '/download/:shortId', '/reshare/:shortId', '/annotations/:shortId', '/delete/:shortId'], (req, res, next) => {
  if (!viaRelay(req)) return next();
  const file = db.prepare('SELECT e2e FROM files WHERE short_id = ?').get(req.params.shortId);
  if (!file?.e2e) return res.status(404).json({ error: 'File not found' });
  next();
});

// ── POST /api/upload ──────────────────────────────────────────────────────────
// Only the signed-in owner can upload to a self-hosted instance, so there is
// no daily limit and no upload log.
router.post('/upload', requireOwner, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const stored = await storeFile(req.file, req.body);
  if (stored.error) return res.status(stored.status).json({ error: stored.error });

  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  res.json({
    shortId: stored.shortId,
    shortUrl: `${baseUrl}/r/${stored.shortId}`,
    filename: req.file.originalname,
    size: stored.paddedSize,
    expiresAt: stored.expires_at,
    deleteToken: stored.deleteToken,
  });
});

// ── GET /api/info/:shortId ────────────────────────────────────────────────────
router.get('/info/:shortId', (req, res) => {
  const file = db.prepare(`
    SELECT short_id, original_filename, mime_type, size_bytes,
           expires_at, download_count, integrity_hash,
           allow_annotations, allow_download, cluster_id, parent_short_id, view_opts, e2e, passcode_salt
    FROM files WHERE short_id = ? AND is_active = 1
  `).get(req.params.shortId);

  if (goneIfExpired(file, res)) return;

  const encKey   = getEncKey();
  const filename = decryptString(file.original_filename, encKey);
  const mimeType = decryptString(file.mime_type, encKey);

  res.json({
    // a locked share's name is still locked: the viewer opens it with the key
    filename,
    size: file.size_bytes,
    mimeType: file.e2e ? null : mimeType,
    e2e: Boolean(file.e2e),
    passcodeSalt: file.passcode_salt || null,
    expiresAt: file.expires_at,
    views: file.download_count,
    integrityHash: file.integrity_hash,
    allowAnnotations: file.allow_annotations ?? 1,
    allowDownload:    file.allow_download    ?? 0,
    // the original upload: deleting it removes every link to the file
    isRoot: !file.parent_short_id && (!file.cluster_id || file.cluster_id === file.short_id),
    viewOpts: file.view_opts ? (() => { try { return JSON.parse(decryptString(file.view_opts, encKey)); } catch { return null; } })() : null,
  });
});

// ── internal: decompress + decrypt and send a file ───────────────────────────
function pipeFile(res, file, disposition) {
  if (!file.stored_filename) return res.status(404).send('File not found');

  const fp = path.join(UPLOADS_DIR, file.stored_filename);
  if (!fs.existsSync(fp)) return res.status(404).send('File not found on disk');

  let data = fs.readFileSync(fp);
  const encKey = getEncKey();

  if (file.encrypted) {
    if (!encKey) return res.status(500).send('File is encrypted but ENCRYPTION_KEY is not set');
    try { data = decryptWithPerFileKey(data, file.wrapped_key || null, encKey); }
    catch { return res.status(500).send('Decryption failed'); }
  }

  if (file.compressed) {
    try { data = decompress(data); }
    catch { return res.status(500).send('Decompression failed'); }
  }

  // increment view count
  db.prepare('UPDATE files SET download_count = download_count + 1 WHERE short_id = ?')
    .run(file.short_id);

  const mimeType = decryptString(file.mime_type, encKey);
  const isText = isTextMime(mimeType);
  if (disposition === 'attachment' && file.e2e) {
    // locked: the browser opens it and names it
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="sealed.bin"');
  } else if (disposition === 'attachment') {
    // download: reveal original mime + filename (owner-only action).
    // Only the types we accept are named; anything else goes out as plain bytes.
    const filename = decryptString(file.original_filename, encKey);
    const known = isText || types.isAllowedType(mimeType);
    res.setHeader('Content-Type', isText ? `${mimeType}; charset=utf-8` : known ? mimeType : 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  } else {
    // inline (raw viewer): strip mime type and filename from headers — privacy.
    // Text is always plain text, so a browser never runs it as a page.
    res.setHeader('Content-Type', isText ? 'text/plain; charset=utf-8' : 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');

  res.setHeader('Content-Length', data.length);
  res.setHeader('Cache-Control', 'no-store');
  res.send(data);
}

// ── GET /api/raw/:shortId ─────────────────────────────────────────────────────
router.get('/raw/:shortId', (req, res) => {
  const file = db.prepare(
    'SELECT * FROM files WHERE short_id = ? AND is_active = 1'
  ).get(req.params.shortId);

  if (goneIfExpired(file, res, false)) return;

  pipeFile(res, file, 'inline');
});

// ── GET /api/download/:shortId ────────────────────────────────────────────────
router.get('/download/:shortId', (req, res) => {
  const file = db.prepare(
    'SELECT * FROM files WHERE short_id = ? AND is_active = 1'
  ).get(req.params.shortId);

  if (goneIfExpired(file, res)) return;
  if (!file.allow_download) return res.status(403).json({ error: 'Download not permitted for this file' });

  pipeFile(res, file, 'attachment');
});

// ── POST /api/delete/:shortId ─────────────────────────────────────────────────
// ── POST /api/alive { ids } → { alive } ──────────────────────────────────────
// Which of these links still work, so "Your shares" drops ones deleted elsewhere.
router.post('/alive', (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter(id => /^[A-Za-z0-9]{4,32}$/.test(id)).slice(0, 100);
  if (!ids.length) return res.json({ alive: [] });
  const rows = db.prepare(`
    SELECT short_id FROM files
    WHERE short_id IN (${ids.map(() => '?').join(',')})
      AND (is_active = 1 OR inbox_status = 'pending') AND (expires_at IS NULL OR expires_at > ?)
  `).all(...ids, new Date().toISOString());
  res.json({ alive: rows.map(r => r.short_id) });
});

router.post('/delete/:shortId', (req, res) => {
  const auth         = verifyToken(req.headers.authorization);
  const deleteToken  = req.body && req.body.deleteToken;
  const short_id     = req.params.shortId;

  const file = db.prepare(
    'SELECT short_id, delete_token, cluster_id FROM files WHERE short_id = ?'
  ).get(short_id);

  if (!file) return res.status(404).json({ error: 'File not found' });

  const isOwner = Boolean(auth);   // the only account on a self-hosted instance is the owner
  const hasToken = deleteToken && file.delete_token && file.delete_token === deleteToken;

  if (!isOwner && !hasToken) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  // the original takes every link with it; any other link takes only its branch
  const everyone = file.cluster_id === short_id;
  purgeLink(file);

  res.json({ deleted: true, scope: everyone ? 'everyone' : 'branch' });
});

// ── POST /api/reshare/:shortId ────────────────────────────────────────────────
router.post('/reshare/:shortId', (req, res) => {
  const file = db.prepare(
    'SELECT * FROM files WHERE short_id = ? AND is_active = 1'
  ).get(req.params.shortId);

  if (goneIfExpired(file, res)) return;

  const newShortId      = generateId(LINK_ID_LENGTH);
  const newDeleteToken  = generateId(24);
  const newIntegrity    = randomHex(32);    // privacy: random hash, breaks content-fingerprint correlation
  const reshareUploadAt = quantizeToHour(); // privacy: quantize to hour boundary
  const baseUrl         = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

  // A reshare shares the stored file (no copy) and is a branch of the link it
  // came from: deleting that link, or the original, deletes this one too.
  db.prepare(`
    INSERT INTO files (
      short_id, original_filename, mime_type, size_bytes, stored_filename,
      integrity_hash, compressed, encrypted, expires_at, delete_token,
      cluster_id, parent_short_id, uploaded_at, allow_annotations, allow_download, wrapped_key, view_opts,
      e2e, passcode_salt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newShortId, file.original_filename, file.mime_type, file.size_bytes, file.stored_filename,
    newIntegrity, file.compressed, file.encrypted, file.expires_at, newDeleteToken,
    file.cluster_id || file.short_id, file.short_id, reshareUploadAt,
    file.allow_annotations, file.allow_download, file.wrapped_key || null, file.view_opts || null,
    file.e2e || 0, file.passcode_salt || null
  );

  res.json({
    shortId:     newShortId,
    shortUrl:    `${baseUrl}/r/${newShortId}`,
    deleteToken: newDeleteToken,
    // the viewer adds the key back to a locked share's new link
    e2e:         Boolean(file.e2e),
  });
});

// ── annotations ──────────────────────────────────────────────────────────────
// Annotations are the private notes of whoever owns a link: every other viewer
// gets a fresh link of their own before annotations load. Reading and saving
// both need the link's delete token in the X-Delete-Token header.
const annCrypto = require('crypto');

const ANN_MAX_BYTES   = 1024 * 1024;
const ANN_MAX_STROKES = 5000;
const ANN_MAX_POINTS  = 20000;
const ANN_COLOR = /^(#[0-9a-f]{6}|rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(0|1|0?\.\d+)\s*\))$/i;

// hashing both sides first keeps the compare fixed-length and constant-time
function annTokenMatches(given, stored) {
  if (!given || !stored || typeof given !== 'string') return false;
  const a = annCrypto.createHash('sha256').update(given).digest();
  const b = annCrypto.createHash('sha256').update(String(stored)).digest();
  return annCrypto.timingSafeEqual(a, b);
}

const annIsNum = n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e6;

// Keep only well-formed strokes, rebuilt with known fields, or null if any is bad.
function cleanStrokes(list) {
  if (!Array.isArray(list) || list.length > ANN_MAX_STROKES) return null;
  const out = [];
  for (const s of list) {
    if (typeof s !== 'object' || s === null) return null;
    if (!Number.isInteger(s.page) || s.page < 1 || s.page > 10000) return null;
    if (typeof s.color !== 'string' || !ANN_COLOR.test(s.color)) return null;
    if (!annIsNum(s.width) || s.width <= 0 || s.width > 64) return null;
    if (!Array.isArray(s.points) || s.points.length > ANN_MAX_POINTS) return null;
    if (!s.points.every(p => typeof p === 'object' && p !== null && annIsNum(p.x) && annIsNum(p.y))) return null;
    out.push({
      page: s.page,
      color: s.color,
      width: s.width,
      eraser: s.eraser === true,
      highlight: s.highlight === true,
      points: s.points.map(p => ({ x: p.x, y: p.y })),
    });
  }
  return out;
}

// ── GET /api/annotations/:shortId ────────────────────────────────────────────
router.get('/annotations/:shortId', async (req, res) => {
  const file = db.prepare(
    'SELECT annotations, expires_at, allow_annotations, delete_token, e2e FROM files WHERE short_id = ? AND is_active = 1'
  ).get(req.params.shortId);

  if (goneIfExpired(file, res)) return;
  if (!annTokenMatches(req.get('X-Delete-Token'), file.delete_token)) {
    return res.status(403).json({ error: 'Only the owner of this link can use its annotations' });
  }
  if (!file.allow_annotations) return res.json({ annotations: [] });

  await sealedReady;
  const encKey = getEncKey();
  const raw    = decryptString(file.annotations, encKey);
  // a locked share's drawing is sealed with its key, which only the browser has
  if (raw && sealed.isSealed(raw)) return res.json({ sealed: raw, annotations: [] });

  let annotations = [];
  if (raw) {
    try { annotations = JSON.parse(raw); } catch {}
  }

  res.json({ annotations });
});

// ── POST /api/annotations/:shortId ───────────────────────────────────────────
router.post('/annotations/:shortId', async (req, res) => {
  const file = db.prepare(
    'SELECT short_id, expires_at, allow_annotations, delete_token, e2e FROM files WHERE short_id = ? AND is_active = 1'
  ).get(req.params.shortId);

  if (goneIfExpired(file, res)) return;
  if (!annTokenMatches(req.get('X-Delete-Token'), file.delete_token)) {
    return res.status(403).json({ error: 'Only the owner of this link can use its annotations' });
  }
  if (!file.allow_annotations) return res.status(403).json({ error: 'Annotations are turned off for this file' });

  // On a locked share the drawing comes sealed with the file's key: it can't
  // be checked here, only limited in size.
  let annotStr;
  if (file.e2e) {
    await sealedReady;
    const box = (req.body || {}).sealed;
    if (typeof box !== 'string' || !sealed.isSealed(box)) return res.status(400).json({ error: 'Drawings on this file have to be sealed.' });
    annotStr = box;
  } else {
    const annotations = cleanStrokes((req.body || {}).annotations);
    if (!annotations) return res.status(400).json({ error: 'Invalid annotations' });
    annotStr = JSON.stringify(annotations);
  }
  if (annotStr.length > ANN_MAX_BYTES * (file.e2e ? 2 : 1)) return res.status(413).json({ error: 'Annotations too large (max 1 MB)' });

  const encKey    = getEncKey();
  const encAnnot  = encryptString(annotStr, encKey);

  db.prepare('UPDATE files SET annotations = ? WHERE short_id = ?')
    .run(encAnnot, req.params.shortId);

  res.json({ saved: true });
});

module.exports = router;
module.exports.storeFile = storeFile;
module.exports.openShare = openShare;
module.exports.upload = upload;
module.exports.MAX_BYTES = MAX_BYTES;
