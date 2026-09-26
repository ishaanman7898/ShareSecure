// MCP (Model Context Protocol) server for the hosted site, so assistants and
// agents (Claude, ChatGPT, Claude Code, Codex, any MCP client) can share files
// for the signed-in user and send them to people, all by themselves.
//
// Auth is a personal token the user creates in the account menu; only its
// SHA-256 is stored. The assistant hands over the content itself, whichever
// way it can:
//   share_text        text it wrote or has in the conversation (.md/.txt/.csv)
//   share_file        content_base64 (small files it can read, e.g. in a code
//                     sandbox) or source_url (the server downloads it)
//   begin_upload…     chunks, for bigger files from clients that base64 in code
//   share_file path   a one-time curl command, for assistants with a shell
// Only when none of those can work does it hand the user an upload page
// (/drop/<ticket>); upload_status then gives the assistant the link.
// Everything goes through the normal upload endpoint, so the type check, the
// 5-a-day limit and encryption all apply.

import {
  getAuthClient, getFilesClient, getUserTag, signToken, sha256, getEncKey,
  encryptStr, decryptStr, encryptField, decryptField, migrateOnce, deleteBranch
} from './_turso.js';
import { onRequestPost as uploadHandler } from './api/upload.js';
import { onRequestPost as sendHandler } from './api/send/[shortId].js';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
// long enough for a person to open the upload page, pick a file and send it
const TICKET_TTL_MS = 30 * 60 * 1000;
const UPLOAD_TTL_MS = 30 * 60 * 1000;
const MAX_BYTES = 10 * 1024 * 1024;      // same as the upload endpoint
const INLINE_MAX = 2 * 1024 * 1024;      // content_base64, decoded
const CHUNK_SIZE = 512 * 1024;           // upload_chunk, decoded
const TEXT_MAX = 200000;                 // share_text, characters
const MAX_OPEN_TICKETS = 10;
const MAX_OPEN_UPLOADS = 3;
const MAX_BATCH = 10;
// the path a shell command uploads has to be one of these
const SHAREABLE = /\.(pdf|docx|png|jpe?g|txt|md|markdown|csv)$/i;
const TYPES_ERROR = 'Only PDF, DOCX, PNG, JPG and text (.txt, .md, .csv) files can be shared.';

function randomToken(bytes = 30) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => chars[b % chars.length]).join('');
}

const nowIso = () => new Date().toISOString();

async function ensureTables(env) {
  await migrateOnce('mcp2', getAuthClient(env), [
    `CREATE TABLE IF NOT EXISTS api_tokens (
       user_id    INTEGER PRIMARY KEY,
       token_hash TEXT UNIQUE NOT NULL,
       created_at TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS mcp_tickets (
       ticket_hash TEXT PRIMARY KEY,
       user_id     INTEGER NOT NULL,
       options     TEXT NOT NULL,
       expires_at  TEXT NOT NULL
     )`,
    // a public id the assistant checks with upload_status, and what happened
    // once the ticket was used (the result is encrypted)
    'ALTER TABLE mcp_tickets ADD COLUMN ticket_id TEXT',
    'ALTER TABLE mcp_tickets ADD COLUMN status TEXT',
    'ALTER TABLE mcp_tickets ADD COLUMN result TEXT',
    'CREATE INDEX IF NOT EXISTS idx_mcp_tickets_user ON mcp_tickets(user_id)',
    // chunked uploads; meta and every chunk are encrypted
    `CREATE TABLE IF NOT EXISTS mcp_uploads (
       upload_hash TEXT PRIMARY KEY,
       user_id     INTEGER NOT NULL,
       meta        TEXT NOT NULL,
       size        INTEGER NOT NULL,
       received    INTEGER NOT NULL DEFAULT 0,
       next_index  INTEGER NOT NULL DEFAULT 0,
       expires_at  TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS mcp_upload_chunks (
       upload_hash TEXT NOT NULL,
       idx         INTEGER NOT NULL,
       len         INTEGER NOT NULL,
       data        TEXT NOT NULL,
       PRIMARY KEY (upload_hash, idx)
     )`,
  ]);
}

// Old tickets and unfinished uploads are removed now and then, in the background.
let lastCleanUp = 0;
function cleanUp(context) {
  if (Date.now() - lastCleanUp < 60 * 1000) return;
  lastCleanUp = Date.now();
  const db = getAuthClient(context.env);
  const now = nowIso();
  context.waitUntil((async () => {
    await db.execute({ sql: 'DELETE FROM mcp_tickets WHERE expires_at < ?', args: [now] });
    await db.execute({ sql: 'DELETE FROM mcp_uploads WHERE expires_at < ?', args: [now] });
    await db.execute({ sql: 'DELETE FROM mcp_upload_chunks WHERE upload_hash NOT IN (SELECT upload_hash FROM mcp_uploads)', args: [] });
  })().catch(() => {}));
}

// ── personal tokens ──────────────────────────────────────────────────────────
export async function tokenStatus(userId, env) {
  await ensureTables(env);
  const row = (await getAuthClient(env).execute({ sql: 'SELECT created_at FROM api_tokens WHERE user_id = ?', args: [userId] })).rows[0];
  return { hasToken: Boolean(row), createdAt: row?.created_at || null };
}

// Creating a token replaces the old one, so a leaked token can be cut off.
export async function createToken(userId, env) {
  await ensureTables(env);
  await revokeToken(userId, env);
  const token = 'ss_' + randomToken(36);
  await getAuthClient(env).execute({
    sql: 'INSERT OR REPLACE INTO api_tokens (user_id, token_hash, created_at) VALUES (?, ?, ?)',
    args: [userId, await sha256(token), new Date().toISOString()]
  });
  return token;
}

export async function revokeToken(userId, env) {
  await ensureTables(env);
  const db = getAuthClient(env);
  await db.execute({ sql: 'DELETE FROM api_tokens WHERE user_id = ?', args: [userId] });
  await db.execute({ sql: 'DELETE FROM mcp_tickets WHERE user_id = ?', args: [userId] });
  await db.execute({ sql: 'DELETE FROM mcp_upload_chunks WHERE upload_hash IN (SELECT upload_hash FROM mcp_uploads WHERE user_id = ?)', args: [userId] });
  await db.execute({ sql: 'DELETE FROM mcp_uploads WHERE user_id = ?', args: [userId] });
}

// "Bearer ss_…" → { userId, username } or null
export async function userForToken(header, env) {
  const token = (header || '').replace(/^Bearer\s+/i, '');
  if (!token.startsWith('ss_')) return null;
  await ensureTables(env);
  const db = getAuthClient(env);
  const row = (await db.execute({ sql: 'SELECT user_id FROM api_tokens WHERE token_hash = ?', args: [await sha256(token)] })).rows[0];
  if (!row) return null;
  const user = (await db.execute({ sql: 'SELECT id, username FROM users WHERE id = ?', args: [row.user_id] })).rows[0];
  return user ? { userId: Number(user.id), username: user.username } : null;
}

// A normal session token for the user, so MCP calls reuse the regular endpoints.
async function sessionHeader(user, env) {
  const token = await signToken({ username: user.username, userId: user.userId, iat: Math.floor(Date.now() / 1000) }, env);
  return `Bearer ${token}`;
}

// ── options every share tool takes ───────────────────────────────────────────
export function shareOptions(args = {}) {
  return {
    expires_hours: Math.min(Math.max(Number(args.expires_hours) || 24, 1), 240),
    allow_download: Boolean(args.allow_download),
    require_account: Boolean(args.require_account),
    name: args.name ? String(args.name).slice(0, 200) : null,
    send_to: toRecipients(args.send_to),
    note: args.note ? String(args.note).trim().slice(0, 140) : '',
  };
}

// "alice, bob", "@alice bob" or ["alice", "bob"] → ["alice", "bob"], at most 20
export function toRecipients(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/);
  return [...new Set(list.map(u => String(u).trim().replace(/^@/, '')).filter(Boolean))].slice(0, 20);
}

// ── uploads ──────────────────────────────────────────────────────────────────
// Hand a regular endpoint a new request; waitUntil must stay bound to the real context.
function withRequest(context, request, params = {}) {
  return { request, env: context.env, params, waitUntil: p => context.waitUntil(p) };
}

export async function upload(user, file, opts, context) {
  if (file?.error) return { error: file.error };
  const fd = new FormData();
  fd.append('file', file);
  fd.append('expires_hours', String(opts.expires_hours));
  fd.append('allow_download', opts.allow_download ? '1' : '0');
  fd.append('allow_annotations', '0');
  fd.append('require_account', opts.require_account ? '1' : '0');
  if (opts.name) fd.append('display_name', opts.name);
  const request = new Request(new URL('/api/upload', context.request.url), {
    method: 'POST',
    headers: { Authorization: await sessionHeader(user, context.env) },
    body: fd,
  });
  const res = await uploadHandler(withRequest(context, request));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: data.error || `Upload failed (${res.status})` };

  const result = { url: data.shortUrl, name: data.displayName || opts.name || data.filename, expires_at: data.expiresAt, id: data.shortId };
  return { ...result, ...await sendToUsers(user, data.shortId, opts.send_to, opts.note, data.deleteToken, context) };
}

// Each recipient gets their own copy as a request they accept or decline. The
// delete token proves the account owns the share it's sending.
export async function sendToUsers(user, shortId, list, note, deleteToken, context) {
  const sent_to = [], not_sent = [];
  const recipients = toRecipients(list);
  if (!recipients.length) return { sent_to, not_sent };
  const auth = await sessionHeader(user, context.env);
  for (const username of recipients) {
    const body = { targetUsername: username };
    if (note) body.note = note;
    if (deleteToken) body.deleteToken = deleteToken;
    const sendReq = new Request(new URL(`/api/send/${shortId}`, context.request.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify(body),
    });
    let sent = {};
    try {
      sent = await (await sendHandler(withRequest(context, sendReq, { shortId }))).json().catch(() => ({}));
    } catch (err) {
      console.error('mcp send failed', err);
    }
    if (sent.sent) sent_to.push(username);
    else not_sent.push({ username, reason: sent.error === 'User not found' ? 'No user with that name' : (sent.error || 'Couldn’t send it') });
  }
  return { sent_to, not_sent };
}

// ── turning what the assistant gave into a file ──────────────────────────────
const SIGNATURES = [
  { ext: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { ext: 'png', bytes: [0x89, 0x50, 0x4E, 0x47] },
  { ext: 'jpg', bytes: [0xFF, 0xD8, 0xFF] },
  { ext: 'docx', bytes: [0x50, 0x4B, 0x03, 0x04] },
];

// just the name: no folders, no characters file systems choke on
function cleanName(name) {
  return String(name || '').split(/[\\/]/).pop().replace(/[\x00-\x1F\x7F<>:"|?*]/g, '').trim().slice(0, 150);
}

// names that promise a file which is never text, so text under them is a mistake
// (usually a web page or error page downloaded instead of the real file)
const BINARY_EXT = /\.(pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|heic|zip)$/i;
const looksLikeHtml = bytes => /^\s*<(!doctype html|html|head|body)\b/i.test(new TextDecoder().decode(bytes.subarray(0, 512)));

// A file named to match what its bytes are ("chart" + PNG bytes → "chart.png").
// Anything that isn't PDF, PNG, JPG or DOCX is offered as text; the upload
// endpoint checks it really is. Returns { error } when the name says PDF (or
// another non-text type) but the bytes aren't one.
export function fileFor(bytes, filename, fallback = 'file') {
  let name = cleanName(filename) || fallback;
  const sig = SIGNATURES.find(s => s.bytes.every((b, i) => bytes[i] === b));
  if (sig) {
    const ok = sig.ext === 'jpg' ? /\.jpe?g$/i : new RegExp(`\\.${sig.ext}$`, 'i');
    if (!ok.test(name)) name = `${name.replace(/\.(pdf|docx|png|jpe?g|txt|md|markdown|csv)$/i, '')}.${sig.ext}`;
    return new File([bytes], name);
  }
  const binary = BINARY_EXT.exec(name);
  if (binary) {
    const kind = binary[1].toUpperCase();
    return {
      error: looksLikeHtml(bytes)
        ? `That isn’t a real ${kind}: it’s a web page (often a preview or sign-in page). Use the file’s direct download link, or its actual bytes.`
        : `That isn’t a real ${kind}: its contents don’t match the name. ShareSecure can share PDF, DOCX, PNG, JPG and text.`
    };
  }
  if (!/\.[a-z0-9]{1,10}$/i.test(name)) name += '.txt';
  return new File([bytes], name, { type: 'text/plain' });
}

// Base64 from a tool call → bytes. The size and characters are checked before
// decoding; a data: prefix, whitespace and url-safe base64 are all fine.
function decodeBase64(input, maxBytes) {
  const raw = String(input || '');
  const maxChars = Math.ceil(maxBytes / 3) * 4;
  const tooBig = { error: `That’s over ${maxBytes / 1024 >= 1024 ? `${maxBytes / 1024 / 1024} MB` : `${maxBytes / 1024} KB`} once decoded.` };
  if (raw.length > maxChars * 2 + 256) return tooBig;
  const s = raw.replace(/^data:[^,]{0,200},/, '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (!s) return { error: 'The base64 is empty.' };
  if (s.length > maxChars) return tooBig;
  if (!/^[A-Za-z0-9+/]+$/.test(s) || s.length % 4 === 1) return { error: 'That isn’t valid base64.' };
  let bytes;
  try { bytes = base64ToBytes(s + '='.repeat((4 - s.length % 4) % 4)); } catch { return { error: 'That isn’t valid base64.' }; }
  if (bytes.length > maxBytes) return tooBig;
  return { bytes };
}

// the runtime's own decoder when it has one, otherwise atob a piece at a time
// (a per-byte callback over the whole string is too slow for Workers)
function base64ToBytes(b64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const out = new Uint8Array(b64.length / 4 * 3 - pad);
  let o = 0;
  for (let i = 0; i < b64.length; i += 32768) {
    const bin = atob(b64.slice(i, i + 32768));
    for (let j = 0; j < bin.length; j++) out[o++] = bin.charCodeAt(j);
  }
  return out;
}

async function hexDigest(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

// ── downloading a file from a link ───────────────────────────────────────────
// Only public https addresses: no IPs, no local or internal names, and never
// this site itself. Every redirect is checked again.
const PRIVATE_NAMES = /(^|\.)(localhost|local|internal|lan|intranet|home\.arpa)$/i;

function badUrl(url, context, hostOk) {
  if (url.protocol !== 'https:') return 'Only https links can be downloaded.';
  if (url.port && url.port !== '443') return 'Only links on the normal https port can be downloaded.';
  if (url.username || url.password) return 'Links with a user name or password in them can’t be downloaded.';
  const host = url.hostname.replace(/\.$/, '').toLowerCase();
  if (host.startsWith('[') || /^[\d.]+$/.test(host) || !host.includes('.') || PRIVATE_NAMES.test(host)) {
    return 'That address can’t be downloaded. Use a public https link.';
  }
  const own = [new URL(context.request.url).hostname];
  try { if (context.env.BASE_URL) own.push(new URL(context.env.BASE_URL).hostname); } catch {}
  if (own.some(h => host === h || host.endsWith('.' + h))) {
    return 'That’s a ShareSecure link. To send an existing share to people, use send_share.';
  }
  if (hostOk && !hostOk(host)) return 'That link isn’t from an allowed host.';
  return null;
}

// read a body, giving up once it passes max bytes
async function readCapped(body, max) {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

// the name from Content-Disposition, or else the last part of the URL
function nameFromResponse(res, url) {
  const cd = res.headers.get('content-disposition') || '';
  const star = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(cd);
  if (star) { try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch {} }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  if (plain) return plain[1].trim();
  const last = url.pathname.split('/').pop() || '';
  try { return decodeURIComponent(last); } catch { return last; }
}

// → { bytes, filename } or { error }. Workers' fetch never sends the user's
// cookies or sign-in, so the link is fetched as a stranger would see it.
export async function fetchFile(rawUrl, context, { hostOk } = {}) {
  let url;
  try { url = new URL(String(rawUrl || '').trim()); } catch { return { error: 'That isn’t a valid link.' }; }
  const signal = AbortSignal.timeout(15000);
  try {
    for (let hop = 0; ; hop++) {
      const bad = badUrl(url, context, hostOk);
      if (bad) return { error: bad };
      const res = await fetch(url, { redirect: 'manual', signal, headers: { Accept: '*/*', 'User-Agent': 'ShareSecure' } });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => {});
        if (hop >= 3) return { error: 'That link redirects too many times.' };
        url = new URL(location, url);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return { error: `The link answered ${res.status}, so it couldn’t be downloaded. It has to work without signing in.` };
      }
      if (Number(res.headers.get('content-length')) > MAX_BYTES) {
        await res.body?.cancel().catch(() => {});
        return { error: 'That file is over 10 MB.' };
      }
      const bytes = await readCapped(res.body, MAX_BYTES);
      if (!bytes) return { error: 'That file is over 10 MB.' };
      if (!bytes.length) return { error: 'That link gave back an empty file.' };
      return { bytes, filename: nameFromResponse(res, url) };
    }
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return { error: 'The download took longer than 15 seconds, so it was stopped.' };
    console.error('fetchFile failed', err);
    return { error: 'Couldn’t download that link. Check it works without signing in.' };
  }
}

// ── one-time upload commands and pages ───────────────────────────────────────
// POST /api/mcp/upload/:ticket (multipart, field "file"): the curl command and
// the /drop page both use it. The ticket works once; afterwards it keeps the
// result for a while so the assistant can read it with upload_status.
export async function redeemTicket(ticket, context) {
  const { env, request } = context;
  await ensureTables(env);
  cleanUp(context);
  const db = getAuthClient(env);
  const hash = await sha256(String(ticket || ''));
  const gone = () => Response.json({ error: 'This upload command has expired or was already used. Ask for a new one.' }, { status: 410 });

  // claim it first, so two uploads at once can't both use it
  const claim = await db.execute({
    sql: "UPDATE mcp_tickets SET status = 'uploading' WHERE ticket_hash = ? AND status IS NULL AND expires_at > ?",
    args: [hash, nowIso()]
  });
  if (!claim.rowsAffected) return gone();
  // if this upload doesn't work, the page can be used again
  const release = () => db.execute({ sql: 'UPDATE mcp_tickets SET status = NULL WHERE ticket_hash = ?', args: [hash] }).catch(() => {});

  const row = (await db.execute({ sql: 'SELECT user_id, options FROM mcp_tickets WHERE ticket_hash = ?', args: [hash] })).rows[0];
  if (!row) return gone();
  const user = (await db.execute({ sql: 'SELECT id, username FROM users WHERE id = ?', args: [row.user_id] })).rows[0];
  if (!user) {
    await db.execute({ sql: 'DELETE FROM mcp_tickets WHERE ticket_hash = ?', args: [hash] }).catch(() => {});
    return Response.json({ error: 'Account not found' }, { status: 404 });
  }

  let form;
  try { form = await request.formData(); } catch {
    await release();
    return Response.json({ error: 'Send the file as multipart form data in a field named "file".' }, { status: 400 });
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') {
    await release();
    return Response.json({ error: 'No file in the "file" field.' }, { status: 400 });
  }

  let result;
  try {
    const opts = JSON.parse(await decryptStr(row.options, await getEncKey(env), env, 'mcpticket:' + hash));
    result = await upload({ userId: Number(user.id), username: user.username }, file, { note: '', ...opts }, context);
  } catch (err) {
    console.error('ticket upload failed', err);
    await release();
    return Response.json({ error: 'Something went wrong. Try again.' }, { status: 500 });
  }
  if (result.error) {
    await release();
    return Response.json(result, { status: 400 });
  }
  await db.execute({
    sql: "UPDATE mcp_tickets SET status = 'done', options = '{}', result = ?, expires_at = ? WHERE ticket_hash = ?",
    args: [await encryptStr(JSON.stringify(result), await getEncKey(env), env, 'mcpticket:' + hash), new Date(Date.now() + TICKET_TTL_MS).toISOString(), hash]
  }).catch(err => console.error('ticket result not saved', err));
  return Response.json(result);
}

async function newTicket(user, opts, context) {
  const db = getAuthClient(context.env);
  const open = (await db.execute({
    sql: "SELECT COUNT(*) AS n FROM mcp_tickets WHERE user_id = ? AND expires_at > ? AND (status IS NULL OR status = 'uploading')",
    args: [user.userId, nowIso()]
  })).rows[0];
  if (Number(open?.n) >= MAX_OPEN_TICKETS) {
    return { error: `There are already ${MAX_OPEN_TICKETS} unused upload pages or commands. Use one of them, or wait up to 30 minutes for them to expire.` };
  }
  const ticket = randomToken(32);
  const ticketId = randomToken(12);
  const hash = await sha256(ticket);
  // the options hold the note and who it's sent to, so they're encrypted like the result
  const options = await encryptStr(JSON.stringify(opts), await getEncKey(context.env), context.env, 'mcpticket:' + hash);
  await db.execute({
    sql: 'INSERT INTO mcp_tickets (ticket_hash, user_id, options, expires_at, ticket_id) VALUES (?, ?, ?, ?, ?)',
    args: [hash, user.userId, options, new Date(Date.now() + TICKET_TTL_MS).toISOString(), ticketId]
  });
  const origin = new URL(context.request.url).origin;
  return { ticketId, uploadUrl: `${origin}/api/mcp/upload/${ticket}`, pageUrl: `${origin}/drop/${ticket}` };
}

async function uploadStatus(user, ticketId, context) {
  const { env } = context;
  const row = ticketId && (await getAuthClient(env).execute({
    sql: 'SELECT ticket_hash, status, result, expires_at FROM mcp_tickets WHERE ticket_id = ? AND user_id = ?',
    args: [ticketId, user.userId]
  })).rows[0];
  if (!row || row.expires_at < nowIso()) {
    return { error: 'No upload page with that ticket_id. It may have expired (they last 30 minutes); make a new one with share_file.' };
  }
  if (row.status === 'done') {
    const result = JSON.parse(await decryptStr(row.result, await getEncKey(env), env, 'mcpticket:' + row.ticket_hash));
    return { text: `Upload complete.\n${resultText(result)}` };
  }
  if (row.status === 'uploading') return { text: 'The file is uploading right now. Check again in a few seconds.' };
  return { text: `No file has arrived yet. Run the upload command in your code environment, then check again. It expires at ${row.expires_at}.` };
}

// ── chunked uploads ──────────────────────────────────────────────────────────
async function openUpload(user, uploadId, env) {
  if (!uploadId) return null;
  const hash = await sha256(String(uploadId));
  return (await getAuthClient(env).execute({
    sql: 'SELECT upload_hash, meta, size, received, next_index FROM mcp_uploads WHERE upload_hash = ? AND user_id = ? AND expires_at > ?',
    args: [hash, user.userId, nowIso()]
  })).rows[0] || null;
}

const NO_UPLOAD = { error: 'No open upload with that upload_id. It may have expired (they last 30 minutes); start again with begin_upload.' };

async function beginUpload(user, args, context) {
  const { env } = context;
  const size = Number(args.size);
  if (!Number.isInteger(size) || size < 1 || size > MAX_BYTES) {
    return { error: `size must be the file’s size in bytes, from 1 to ${MAX_BYTES} (10 MB).` };
  }
  const filename = cleanName(args.filename);
  if (!filename) return { error: 'filename is required, e.g. "report.pdf".' };
  const sha = args.sha256 ? String(args.sha256).trim().toLowerCase() : '';
  if (sha && !/^[0-9a-f]{64}$/.test(sha)) return { error: 'sha256 must be 64 hex characters.' };

  const db = getAuthClient(env);
  const open = (await db.execute({
    sql: 'SELECT COUNT(*) AS n FROM mcp_uploads WHERE user_id = ? AND expires_at > ?',
    args: [user.userId, nowIso()]
  })).rows[0];
  if (Number(open?.n) >= MAX_OPEN_UPLOADS) {
    return { error: `There are already ${MAX_OPEN_UPLOADS} unfinished uploads. Finish one, or wait up to 30 minutes for them to expire.` };
  }

  const uploadId = 'up_' + randomToken(24);
  const hash = await sha256(uploadId);
  const meta = await encryptStr(JSON.stringify({ filename, sha256: sha, opts: shareOptions(args) }), await getEncKey(env), env, 'mcpup:' + hash);
  await db.execute({
    sql: 'INSERT INTO mcp_uploads (upload_hash, user_id, meta, size, expires_at) VALUES (?, ?, ?, ?, ?)',
    args: [hash, user.userId, meta, size, new Date(Date.now() + UPLOAD_TTL_MS).toISOString()]
  });
  const chunks = Math.ceil(size / CHUNK_SIZE);
  return {
    text: [
      `upload_id: ${uploadId}`,
      `chunk_size: ${CHUNK_SIZE} bytes`,
      `chunks: ${chunks} (index 0${chunks > 1 ? ` to ${chunks - 1}` : ''})`,
      'Send each chunk with upload_chunk, in order, then call finish_upload. The upload expires in 30 minutes.',
    ].join('\n')
  };
}

async function uploadChunk(user, args, context) {
  const { env } = context;
  const up = await openUpload(user, args.upload_id, env);
  if (!up) return NO_UPLOAD;
  const index = Number(args.index);
  const retry = up.next_index > 0 && index === up.next_index - 1;
  if (!Number.isInteger(index) || index < 0 || (index !== up.next_index && !retry)) {
    return { error: `Send chunk ${up.next_index} next${up.next_index ? ` (or ${up.next_index - 1} again)` : ''}.` };
  }
  const decoded = decodeBase64(args.data_base64, CHUNK_SIZE);
  if (decoded.error) return decoded;
  const bytes = decoded.bytes;
  if (args.sha256 && (await hexDigest(bytes)) !== String(args.sha256).trim().toLowerCase()) {
    return { error: `Chunk ${index} doesn’t match its sha256. Encode it again and resend it.` };
  }

  const db = getAuthClient(env);
  let received = up.received + bytes.length;
  if (retry) {
    const old = (await db.execute({ sql: 'SELECT len FROM mcp_upload_chunks WHERE upload_hash = ? AND idx = ?', args: [up.upload_hash, index] })).rows[0];
    received -= Number(old?.len || 0);
  }
  if (received > up.size) return { error: `That’s more than the ${up.size} bytes begin_upload was told the file is.` };

  const data = await encryptField(bytes, await getEncKey(env), env, `mcpup:${up.upload_hash}:${index}`);
  await db.execute({
    sql: 'INSERT OR REPLACE INTO mcp_upload_chunks (upload_hash, idx, len, data) VALUES (?, ?, ?, ?)',
    args: [up.upload_hash, index, bytes.length, data]
  });
  const moved = await db.execute({
    sql: 'UPDATE mcp_uploads SET next_index = ?, received = ? WHERE upload_hash = ? AND next_index = ?',
    args: [index + 1, received, up.upload_hash, up.next_index]
  });
  if (!moved.rowsAffected) return { error: 'Another chunk arrived at the same time. Send them one at a time, in order.' };
  return {
    text: `Got chunk ${index} (${received} of ${up.size} bytes).` +
      (received === up.size ? ' That’s all of it: call finish_upload.' : ` Next: index ${index + 1}.`)
  };
}

async function finishUpload(user, args, context) {
  const { env } = context;
  const up = await openUpload(user, args.upload_id, env);
  if (!up) return NO_UPLOAD;
  if (up.received !== up.size) {
    return { error: `Only ${up.received} of ${up.size} bytes have arrived. Send chunk ${up.next_index} next.` };
  }

  const db = getAuthClient(env);
  const key = await getEncKey(env);
  const drop = () => Promise.all([
    db.execute({ sql: 'DELETE FROM mcp_upload_chunks WHERE upload_hash = ?', args: [up.upload_hash] }),
    db.execute({ sql: 'DELETE FROM mcp_uploads WHERE upload_hash = ?', args: [up.upload_hash] }),
  ]).catch(() => {});

  // read the chunks back a few at a time, so no single response is huge
  const bytes = new Uint8Array(up.size);
  let o = 0;
  for (let from = 0; from < up.next_index; from += 5) {
    const rows = (await db.execute({
      sql: 'SELECT idx, data FROM mcp_upload_chunks WHERE upload_hash = ? AND idx >= ? AND idx < ? ORDER BY idx',
      args: [up.upload_hash, from, from + 5]
    })).rows;
    for (const r of rows) {
      const piece = new Uint8Array(await decryptField(r.data, key, env, `mcpup:${up.upload_hash}:${r.idx}`));
      if (o + piece.length > up.size) break;
      bytes.set(piece, o);
      o += piece.length;
    }
  }
  if (o !== up.size) {
    await drop();
    return { error: 'Some chunks went missing. Start again with begin_upload.' };
  }

  const meta = JSON.parse(await decryptStr(up.meta, key, env, 'mcpup:' + up.upload_hash));
  if (meta.sha256 && (await hexDigest(bytes)) !== meta.sha256) {
    await drop();
    return { error: 'The file doesn’t match the sha256 given to begin_upload. Start again with begin_upload.' };
  }
  const result = await upload(user, fileFor(bytes, meta.filename), meta.opts, context);
  if (!result.error) await drop();
  return result.error ? result : { text: resultText(result) };
}

// ── shares (used by the MCP tools and the ChatGPT actions) ──────────────────
// Live links the server can tie to the account. Private uploads from the
// browser the account was made in have no account link, so they aren't here.
export async function liveShares(user, context) {
  const { env, request } = context;
  const tag = await getUserTag(user.userId, env);
  const rows = (await getFilesClient(env).execute({
    sql: `SELECT short_id, original_filename, expires_at FROM files
          WHERE is_active = 1 AND (user_tag = ? OR (user_tag IS NULL AND user_id = ?))
            AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          ORDER BY uploaded_at DESC LIMIT 50`,
    args: [tag, user.userId]
  })).rows;
  const key = await getEncKey(env);
  const base = new URL(request.url).origin;
  return Promise.all(rows.map(async r => {
    let name = r.original_filename;
    try { name = await decryptStr(r.original_filename, key, env, r.short_id); } catch {}
    return { id: r.short_id, name, url: `${base}/r/${r.short_id}`, expires_at: r.expires_at };
  }));
}

// one of the account's own shares, or undefined
async function ownShare(user, id, env) {
  const tag = await getUserTag(user.userId, env);
  return (await getFilesClient(env).execute({
    sql: 'SELECT short_id, cluster_id, delete_token, expires_at, is_active FROM files WHERE short_id = ? AND (user_tag = ? OR (user_tag IS NULL AND user_id = ?))',
    args: [id, tag, user.userId]
  })).rows[0];
}

// Deletes one of the account's shares; it's an original, so every link to it goes.
export async function deleteShare(user, id, context) {
  const file = await ownShare(user, id, context.env);
  if (!file) return false;
  await deleteBranch(getFilesClient(context.env), file);
  return true;
}

// Sends one of the account's live shares to usernames → result or { error }.
export async function sendShare(user, args, context) {
  const { env, request } = context;
  const id = String(args.id || '').trim();
  if (!id) return { error: 'id is required: the share id from list_shares or a share tool.' };
  const recipients = toRecipients(args.send_to);
  if (!recipients.length) return { error: 'send_to needs at least one ShareSecure username.' };
  const file = await ownShare(user, id, env);
  if (!file || !file.is_active || (file.expires_at && file.expires_at < nowIso())) {
    return { error: `No live share with id ${id} on this account.` };
  }
  const note = args.note ? String(args.note).trim().slice(0, 140) : '';
  const base = env.BASE_URL || new URL(request.url).origin;
  return {
    id, url: `${base}/r/${id}`, expires_at: file.expires_at,
    ...await sendToUsers(user, id, recipients, note, file.delete_token, context),
  };
}

// Text the assistant wrote → a .md, .txt or .csv share → result or { error }.
const TEXT_FORMATS = { markdown: '.md', plain: '.txt', csv: '.csv' };
export async function shareWrittenText(user, args, context) {
  // only tab, newlines and form feed survive of the control characters
  const text = String(args.text ?? '').replace(/[\x00-\x08\x0B\x0E-\x1F\x7F]/g, '');
  if (!text.trim()) return { error: 'text is empty. Pass the full content to share.' };
  if (text.length > TEXT_MAX) return { error: 'text is over 200,000 characters. Split it into parts and share each one.' };
  const ext = TEXT_FORMATS[args.format] || TEXT_FORMATS.markdown;
  // a title isn't a path, so "Q3 / Q4" keeps both halves
  const title = cleanName(String(args.title || '').replace(/[\\/]/g, '-')).replace(/\.(md|markdown|txt|csv)$/i, '') || 'Shared text';
  return upload(user, new File([text], title + ext, { type: 'text/plain' }), shareOptions(args), context);
}

// What a share tool tells the assistant
function resultText(r) {
  const lines = [];
  if (r.url) lines.push(`Link: ${r.url}`);
  if (r.name) lines.push(`Name: ${r.name}`);
  if (r.expires_at) lines.push(`Expires: ${r.expires_at}`);
  if (r.id) lines.push(`Share id: ${r.id} (for send_share or delete_share)`);
  const sentTo = r.sent_to || [], notSent = r.not_sent || [];
  if (!sentTo.length && !notSent.length) lines.push('Sent to: no one (just the link)');
  else {
    lines.push(`Sent to: ${sentTo.length ? sentTo.join(', ') : 'no one'}`);
    if (notSent.length) lines.push(`Not sent: ${notSent.map(x => `${x.username} (${x.reason})`).join('; ')}`);
  }
  return lines.join('\n');
}

// ── tools ────────────────────────────────────────────────────────────────────
const COMMON = {
  expires_hours: { type: 'number', description: 'Hours until the link stops working, 1 to 240. Default 24.' },
  allow_download: { type: 'boolean', description: 'Let people who open the link download the file. Default false (view only).' },
  require_account: { type: 'boolean', description: 'Only people signed in to ShareSecure can open the link. Default false (anyone with the link).' },
  name: { type: 'string', description: 'Name shown to people who open the link. Defaults to the file name.' },
  send_to: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'ShareSecure usernames to send it to, e.g. ["alice", "bob"]. Each gets their own copy in their inbox to accept or decline. Use this whenever the user says who it’s for. Up to 20.' },
  note: { type: 'string', maxLength: 140, description: 'Short note shown to the people it’s sent to. Up to 140 characters.' },
};

const SHARING = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const UPLOADING = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const TOOLS = [
  {
    name: 'share_text',
    title: 'Share text as a document',
    description: 'Share something you wrote or have in the conversation (a report, notes, a summary, an email draft, code, a table as CSV) as a private ShareSecure document with a link that expires, and optionally send it straight to ShareSecure usernames. Use this for anything you wrote or have in the conversation, and do it yourself: never ask the user to copy, save or upload it. Pass the full text; it’s shown exactly as written. Counts toward the 5 shares a day.',
    inputSchema: {
      type: 'object',
      required: ['text', 'title'],
      properties: {
        text: { type: 'string', maxLength: TEXT_MAX, description: 'The full content to share. Up to 200,000 characters.' },
        title: { type: 'string', description: 'Title, used as the file name, e.g. "Q3 summary".' },
        format: { type: 'string', enum: ['markdown', 'plain', 'csv'], description: 'markdown (.md, the default), plain (.txt) or csv (.csv).' },
        ...COMMON,
      },
    },
    annotations: SHARING,
  },
  {
    name: 'share_file',
    title: 'Share a file',
    description: [
      'Share a file (PDF, DOCX, PNG, JPG, or text such as .txt, .md or .csv; up to 10 MB) through a private link that expires, and optionally send it straight to ShareSecure usernames. Do it yourself: don’t ask the user to download, save or upload anything. Give the file one of these ways:',
      'For a document you GENERATED with code (including Claude file creation), prefer path: pass its absolute path in YOUR sandbox, then execute the returned curl command there. The server does not read that path; your code uploads the bytes. This preserves the original PDF, DOCX or image and avoids putting base64 in the conversation.',
      '1. content_base64 + filename: fallback when your sandbox cannot make the upload request. Compute base64 with code, never invent it. Up to 2 MB; best under about 100 KB.',
      '2. source_url: a public https link to the file; ShareSecure downloads it.',
      '3. Bigger files you can read in code: begin_upload, upload_chunk, finish_upload.',
      '4. path: only when you can run shell commands on the computer that has the file. Returns a one-time curl command for you to run.',
      'For text you wrote, use share_text instead. For a file the user attached in a chat app (such as claude.ai): if you can run code, it’s usually already in your sandbox (look through its files), so read it and base64 it there. Otherwise it reaches you as text or images, not the file itself, so share its content with share_text.',
      'Use ask_user only when the USER explicitly asks to upload manually. Do not send them an upload page for a document you generated. If neither code upload nor byte transfer is possible, explain the client restriction; never claim delivery or silently replace a requested PDF/DOCX with text. Counts toward the 5 shares a day.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        content_base64: { type: 'string', description: 'The file’s bytes as base64 (standard or url-safe; a data: prefix is fine). At most 2 MB once decoded.' },
        filename: { type: 'string', description: 'The file’s name with its extension, e.g. "chart.png". Use it with content_base64.' },
        source_url: { type: 'string', description: 'A public https link to download the file from.' },
        path: { type: 'string', description: 'Path to the file, only when you can run shell commands on the computer that has it.' },
        ask_user: { type: 'boolean', description: 'Only if the user explicitly requests manual upload. Never use for a document you generated.' },
        ...COMMON,
      },
    },
    annotations: SHARING,
  },
  {
    name: 'begin_upload',
    title: 'Start a chunked upload',
    description: 'Start uploading a file of up to 10 MB in chunks, for clients that can compute base64 in code (for example a script in your sandbox that prints each chunk). Every chunk you pass costs output tokens (about 1 per 3 base64 characters), so don’t use this to copy out a large file by hand. Returns upload_id and chunk_size; then call upload_chunk for index 0, 1, 2… and finally finish_upload. Uploads expire after 30 minutes, and at most 3 can be open at once.',
    inputSchema: {
      type: 'object',
      required: ['filename', 'size'],
      properties: {
        filename: { type: 'string', description: 'The file’s name with its extension, e.g. "report.pdf".' },
        size: { type: 'integer', minimum: 1, maximum: MAX_BYTES, description: 'The file’s size in bytes.' },
        sha256: { type: 'string', description: 'Optional SHA-256 of the whole file in hex, checked when it’s finished.' },
        ...COMMON,
      },
    },
    annotations: UPLOADING,
  },
  {
    name: 'upload_chunk',
    title: 'Send one chunk',
    description: 'Send one chunk of a chunked upload: the bytes from index × chunk_size, as base64, at most 512 KB once decoded. Send them in order starting at 0; sending the last one again is safe.',
    inputSchema: {
      type: 'object',
      required: ['upload_id', 'index', 'data_base64'],
      properties: {
        upload_id: { type: 'string', description: 'From begin_upload.' },
        index: { type: 'integer', minimum: 0, description: 'Which chunk this is, from 0.' },
        data_base64: { type: 'string', description: 'The chunk’s bytes as base64.' },
        sha256: { type: 'string', description: 'Optional SHA-256 of this chunk’s bytes in hex, to catch copying mistakes.' },
      },
    },
    annotations: UPLOADING,
  },
  {
    name: 'finish_upload',
    title: 'Finish a chunked upload',
    description: 'Finish a chunked upload once every chunk is in. Creates the link, and sends it to the send_to given to begin_upload.',
    inputSchema: {
      type: 'object',
      required: ['upload_id'],
      properties: { upload_id: { type: 'string', description: 'From begin_upload.' } },
    },
    annotations: SHARING,
  },
  {
    name: 'send_share',
    title: 'Send a share to people',
    description: 'Send one of this account’s existing shares (the id from list_shares or a share tool) to ShareSecure usernames. Each gets their own copy in their inbox to accept or decline.',
    inputSchema: {
      type: 'object',
      required: ['id', 'send_to'],
      properties: { id: { type: 'string', description: 'The share id.' }, send_to: COMMON.send_to, note: COMMON.note },
    },
    annotations: SHARING,
  },
  {
    name: 'upload_status',
    title: 'Check an upload page',
    description: 'Check an upload page from share_file, using its ticket_id. Once the user has picked the file, returns the link and who it was sent to.',
    inputSchema: {
      type: 'object',
      required: ['ticket_id'],
      properties: { ticket_id: { type: 'string', description: 'The ticket_id share_file gave you.' } },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_shares',
    title: 'List shares',
    description: 'List files shared from this ShareSecure account that are still live, with their links and time left. Private uploads made in the browser the account was created in are not listed.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'delete_share',
    title: 'Delete a share',
    description: 'Delete a shared file now, so its link stops working. Use the id from list_shares or a share tool.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The share id.' } }, required: ['id'] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

const shellQuote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

const NO_FILE = 'No file was given, so nothing was shared. Share it yourself: pass content_base64 + filename if you can read the file (for example in your code sandbox), source_url if it’s at a public https link, or path if you can run shell commands. For text you wrote or have in the conversation, use share_text. Only if you truly can’t get the file, call share_file again with ask_user: true to get an upload page for the user.';

async function callTool(name, args, user, context) {
  const shared = result => result.error ? result : { text: resultText(result) };

  if (name === 'share_text') return shared(await shareWrittenText(user, args, context));

  if (name === 'share_file') {
    const opts = shareOptions(args);
    if (args.content_base64) {
      const decoded = decodeBase64(args.content_base64, INLINE_MAX);
      if (decoded.error) return decoded;
      return shared(await upload(user, fileFor(decoded.bytes, args.filename || args.name), opts, context));
    }
    if (args.source_url) {
      const got = await fetchFile(args.source_url, context);
      if (got.error) return got;
      return shared(await upload(user, fileFor(got.bytes, args.filename || got.filename), opts, context));
    }

    const path = String(args.path || '').trim();
    if (!path && !args.ask_user) return { error: NO_FILE };
    if (path && !SHAREABLE.test(path)) return { error: TYPES_ERROR };
    cleanUp(context);
    const ticket = await newTicket(user, opts, context);
    if (ticket.error) return ticket;
    const sent = opts.send_to.length
      ? ` "sent_to" lists who it was sent to (${opts.send_to.join(', ')}), and "not_sent" lists anyone it couldn't reach and why.`
      : '';
    const lines = path
      ? [
          `Run this command yourself to upload ${path} (it works once, within 30 minutes):`,
          '',
          `curl --fail-with-body --silent --show-error --max-time 120 -F ${shellQuote('file=@' + path)} ${shellQuote(ticket.uploadUrl)}`,
          '',
          `It prints JSON: "url" is the share link and "expires_at" is when it stops working.${sent}`,
          'On Windows PowerShell, use curl.exe instead of curl.',
          'If your network blocks this address, read the file and use content_base64 (or the chunk tools) instead.',
          '',
          'This is an upload command for YOU to execute, not a link to give the user. Do not say it was sent until the response confirms it.',
          `If you need to check the result, call upload_status with ticket_id "${ticket.ticketId}".`,
        ]
      : [
          'Give the user this page. They pick the file there and it’s shared with the settings you chose (it works once, within 30 minutes):',
          '',
          ticket.pageUrl,
          '',
          `When they say it’s done, call upload_status with ticket_id "${ticket.ticketId}" to get the link${opts.send_to.length ? ' and who it was sent to' : ''}.`,
        ];
    return { text: lines.join('\n') };
  }

  if (name === 'begin_upload') { cleanUp(context); return beginUpload(user, args, context); }
  if (name === 'upload_chunk') return uploadChunk(user, args, context);
  if (name === 'finish_upload') return finishUpload(user, args, context);

  if (name === 'send_share') return shared(await sendShare(user, args, context));

  if (name === 'upload_status') {
    cleanUp(context);
    return uploadStatus(user, String(args.ticket_id || '').trim().slice(0, 64), context);
  }

  if (name === 'list_shares') {
    const shares = await liveShares(user, context);
    if (!shares.length) return { text: 'No live shares.' };
    return { text: shares.map(x => `- ${x.name} — ${x.url} (id ${x.id}, expires ${x.expires_at})`).join('\n') };
  }

  if (name === 'delete_share') {
    const id = String(args.id || '');
    return (await deleteShare(user, id, context))
      ? { text: `Deleted ${id}. Its link, and every link shared from it, no longer work.` }
      : { error: `No share with id ${id} on this account.` };
  }

  return { error: `Unknown tool ${name}` };
}

const INSTRUCTIONS = [
  'ShareSecure shares files and documents through private links that expire, and can send them straight to ShareSecure usernames. Do the whole job yourself; never tell the user to download, save or upload something you can share with these tools.',
  '- Text you wrote or have in the conversation (reports, notes, drafts, code, CSV): share_text.',
  '- A document you generated with code: call share_file with its path in your sandbox, then execute the returned upload command yourself. If sandbox networking is unavailable, use content_base64 and filename (best under 100 KB), or the chunk tools. Preserve the requested file format.',
  '- A file at a public https link: share_file with source_url.',
  '- A file on a computer where you can run shell commands: share_file with path, then run the command it returns.',
  '- Only if the user explicitly requests a manual upload: share_file with ask_user. Never default to this for a document you generated.',
  'When the user says who it’s for, pass send_to (and a short note if it helps); to send something already shared, use send_share. Reply with the link, when it expires, and who received it.',
].join('\n');

// ── JSON-RPC over Streamable HTTP ────────────────────────────────────────────
async function handleMessage(msg, user, context) {
  const { id, method, params = {} } = msg || {};
  if (id === undefined || id === null) return null; // notification: nothing to answer
  const reply = result => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'sharesecure', title: 'ShareSecure', version: '1.10.0' },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      try {
        const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
        const out = await callTool(params.name, args, user, context);
        return reply(out.error
          ? { content: [{ type: 'text', text: out.error }], isError: true }
          : { content: [{ type: 'text', text: out.text }] });
      } catch (err) {
        console.error('mcp tool failed', params.name, err);
        return reply({ content: [{ type: 'text', text: 'Something went wrong. Try again.' }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

// pathToken: apps like Claude and ChatGPT only take a URL when adding a
// connector, so their connector URL carries the token (/connect/<token>).
export async function handleMcp(context, pathToken = null) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return new Response('ShareSecure MCP endpoint. Connect with an MCP client using POST.', { status: 405, headers: { Allow: 'POST' } });
  }
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ error: 'Origin not allowed' }, { status: 403 });
  }
  const user = await userForToken(pathToken ? `Bearer ${pathToken}` : request.headers.get('Authorization'), env);
  if (!user) {
    return Response.json(
      { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Missing or invalid ShareSecure token. Create one in the account menu under Connect an AI assistant.' } },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } }
    );
  }
  let body;
  try {
    const bytes = await readCapped(request.body, 4 * 1024 * 1024);
    if (!bytes) return Response.json({ error: 'MCP message exceeds 4 MB. Use the upload command or chunk tools.' }, { status: 413 });
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400 });
  }
  if (Array.isArray(body)) {
    if (body.length > MAX_BATCH) {
      return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `Too many messages in one batch (at most ${MAX_BATCH}).` } }, { status: 400 });
    }
    // one at a time, like the desktop app, so the send and upload limits see
    // each call's result before the next one runs
    const out = [];
    for (const m of body) {
      const r = await handleMessage(m, user, context);
      if (r) out.push(r);
    }
    return out.length ? Response.json(out) : new Response(null, { status: 202 });
  }
  const out = await handleMessage(body, user, context);
  return out ? Response.json(out) : new Response(null, { status: 202 });
}
