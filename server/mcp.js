'use strict';
// MCP (Model Context Protocol) endpoint for the desktop app and self-hosted
// installs, so assistants like Claude, Claude Code and Codex can share files
// and send them to ShareSecure usernames by themselves.
//
// The owner creates a personal token in the account menu; only its SHA-256 is
// kept. An assistant can hand over what it wants to share in several ways:
// text it wrote, the file's bytes (inline or in chunks), or a public link for
// ShareSecure to download. Reading a file straight from its path only works
// for requests made on this computer: nothing arriving through the public
// tunnel can read files here.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const https = require('https');
const net = require('net');

const { db } = require('./db');
const settings = require('./settings');
const { decryptString, getEncKey } = require('./utils');
const { purgeLink } = require('./purge');
const { storeFile } = require('./routes/files');
const { sendToCloud } = require('./routes/cloud');

const router = express.Router();
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BYTES = 10 * 1024 * 1024;      // same as the upload endpoint
const INLINE_MAX = 2 * 1024 * 1024;      // content_base64, decoded
const CHUNK_SIZE = 512 * 1024;           // upload_chunk, decoded
const TEXT_MAX = 200000;                 // share_text, characters
const UPLOAD_TTL_MS = 30 * 60 * 1000;
const MAX_OPEN_UPLOADS = 3;
const MAX_BATCH = 10;
const VERSION = require('../package.json').version;

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// ── personal token ───────────────────────────────────────────────────────────
function tokenStatus() {
  return { hasToken: Boolean(settings.get('mcpTokenHash')), createdAt: settings.get('mcpTokenCreatedAt') || null };
}

function createToken() {
  const token = 'ss_' + crypto.randomBytes(27).toString('base64url');
  settings.set('mcpTokenHash', sha256(token));
  settings.set('mcpTokenCreatedAt', new Date().toISOString());
  return token;
}

function revokeToken() {
  settings.set('mcpTokenHash', null);
  settings.set('mcpTokenCreatedAt', null);
  uploads.clear();
}

function tokenOk(header) {
  const token = String(header || '').replace(/^Bearer\s+/i, '');
  const stored = settings.get('mcpTokenHash');
  if (!stored || !token.startsWith('ss_')) return false;
  const a = Buffer.from(sha256(token)), b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Requests through the public tunnel carry the tunnel's host name.
function fromThisComputer(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const addr = String(req.socket.remoteAddress || '');
  const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  return loopback && ['localhost', '127.0.0.1', '::1'].includes(host);
}

const baseUrl = () => (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

// ── share options ────────────────────────────────────────────────────────────
function shareOptions(args = {}) {
  return {
    expires_hours: Math.min(Math.max(Number(args.expires_hours) || 24, 1), 240),
    allow_download: Boolean(args.allow_download),
    name: args.name ? String(args.name).slice(0, 200) : null,
    send_to: toRecipients(args.send_to),
    note: args.note ? String(args.note).trim().slice(0, 140) : '',
  };
}

// "alice, bob", "@alice bob" or ["alice", "bob"] → ["alice", "bob"], at most 20
function toRecipients(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/);
  return [...new Set(list.map(u => String(u).trim().replace(/^@/, '')).filter(Boolean))].slice(0, 20);
}

// ── storing and sending ──────────────────────────────────────────────────────
// file: { buffer, originalname, mimetype? } → result or { error }
async function share(file, opts) {
  if (file.error) return { error: file.error };
  const stored = storeFile(
    { buffer: file.buffer, originalname: file.originalname, mimetype: file.mimetype, size: file.buffer.length },
    {
      expires_hours: String(opts.expires_hours),
      allow_download: opts.allow_download ? '1' : '0',
      allow_annotations: '0',
      display_name: opts.name || '',
    }
  );
  if (stored.error) return { error: stored.error };
  const result = { url: `${baseUrl()}/r/${stored.shortId}`, name: stored.displayName || opts.name || file.originalname, expires_at: stored.expires_at, id: stored.shortId };
  return { ...result, ...await sendOn(stored.shortId, opts.send_to, opts.note) };
}

// Usernames live on the ShareSecure website, so sending goes through the
// account the owner linked in the app (routes/cloud.js).
async function sendOn(shortId, recipients, note) {
  if (!recipients.length) return { sent_to: [], not_sent: [] };
  const out = await sendToCloud(shortId, recipients, note);
  // names it never got to because the account isn't linked (or needs signing
  // in again) are listed apart, with what the user has to do
  const needsLink = x => out.error && /ShareSecure account/.test(x.reason || '');
  return {
    sent_to: out.sent_to,
    not_sent: out.not_sent.filter(x => !needsLink(x)),
    unsent: out.not_sent.filter(needsLink).map(x => x.username),
    cloud_error: out.error || null,
  };
}

const cloudHelp = (err, id) => err === 'link_expired'
  ? `The ShareSecure account linked to this app needs signing in again, so it couldn’t send to usernames. Ask the user to open the account menu in the ShareSecure app, choose “ShareSecure account” and sign in, then call send_share with id ${id}.`
  : `No ShareSecure account is linked to this app, so it can’t send to usernames. Ask the user to link one: in the ShareSecure app, open the account menu and choose “ShareSecure account”. Then call send_share with id ${id}. Until then, they can give people the link.`;

// What a share tool tells the assistant
function resultText(r) {
  const lines = [];
  if (r.url) lines.push(`Link: ${r.url}`);
  if (r.name) lines.push(`Name: ${r.name}`);
  if (r.expires_at) lines.push(`Expires: ${r.expires_at}`);
  if (r.id) lines.push(`Share id: ${r.id} (for send_share or delete_share)`);
  const sentTo = r.sent_to || [], notSent = r.not_sent || [], unsent = r.unsent || [];
  if (!sentTo.length && !notSent.length && !unsent.length) lines.push('Sent to: no one (just the link)');
  else {
    lines.push(`Sent to: ${sentTo.length ? sentTo.join(', ') : 'no one'}`);
    if (notSent.length) lines.push(`Not sent: ${notSent.map(x => `${x.username} (${x.reason})`).join('; ')}`);
    if (unsent.length) lines.push(`Not sent: ${unsent.join(', ')}. ${cloudHelp(r.cloud_error, r.id)}`);
  }
  lines.push('The link works while ShareSecure is running on the owner’s computer.');
  return lines.join('\n');
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
const looksLikeHtml = buffer => /^\s*<(!doctype html|html|head|body)\b/i.test(buffer.subarray(0, 512).toString('utf8'));

// A file named to match what its bytes are ("chart" + PNG bytes → "chart.png").
// Anything that isn't PDF, PNG, JPG or DOCX is offered as text; storeFile
// checks it really is. Returns { error } when the name says PDF (or another
// non-text type) but the bytes aren't one.
function fileFor(buffer, filename, fallback = 'file') {
  let name = cleanName(filename) || fallback;
  const sig = SIGNATURES.find(s => s.bytes.every((b, i) => buffer[i] === b));
  if (sig) {
    const ok = sig.ext === 'jpg' ? /\.jpe?g$/i : new RegExp(`\\.${sig.ext}$`, 'i');
    if (!ok.test(name)) name = `${name.replace(/\.(pdf|docx|png|jpe?g|txt|md|markdown|csv)$/i, '')}.${sig.ext}`;
    return { buffer, originalname: name };
  }
  const binary = BINARY_EXT.exec(name);
  if (binary) {
    const kind = binary[1].toUpperCase();
    return {
      error: looksLikeHtml(buffer)
        ? `That isn’t a real ${kind}: it’s a web page (often a preview or sign-in page). Use the file’s direct download link, or its actual bytes.`
        : `That isn’t a real ${kind}: its contents don’t match the name. ShareSecure can share PDF, DOCX, PNG, JPG and text.`
    };
  }
  if (!/\.[a-z0-9]{1,10}$/i.test(name)) name += '.txt';
  return { buffer, originalname: name, mimetype: 'text/plain' };
}

// Base64 from a tool call → bytes. The size and characters are checked before
// decoding; a data: prefix, whitespace and url-safe base64 are all fine.
function decodeBase64(input, maxBytes) {
  const raw = String(input || '');
  const maxChars = Math.ceil(maxBytes / 3) * 4;
  const tooBig = { error: `That’s over ${maxBytes >= 1024 * 1024 ? `${maxBytes / 1024 / 1024} MB` : `${maxBytes / 1024} KB`} once decoded.` };
  if (raw.length > maxChars * 2 + 256) return tooBig;
  const s = raw.replace(/^data:[^,]{0,200},/, '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (!s) return { error: 'The base64 is empty.' };
  if (s.length > maxChars) return tooBig;
  if (!/^[A-Za-z0-9+/]+$/.test(s) || s.length % 4 === 1) return { error: 'That isn’t valid base64.' };
  const bytes = Buffer.from(s, 'base64');
  if (bytes.length > maxBytes) return tooBig;
  return { bytes };
}

// ── downloading a file from a link ───────────────────────────────────────────
// This server can reach the owner's home network and this computer, so a link
// must be public https, every address its name resolves to must be public, and
// the connection goes to the address that was checked (so the name can't
// switch to a private one in between). Every redirect is checked again, and
// this ShareSecure itself is never fetched.
const PRIVATE_NAMES = /(^|\.)(localhost|local|internal|lan|intranet|home\.arpa)$/i;

const blocked = new net.BlockList();
for (const [ip, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(ip, bits, 'ipv4');
// No ::ffff:0:0/96 rule: BlockList already checks IPv4-mapped addresses
// (::ffff:10.0.0.1) against the IPv4 rules, and that rule would block every
// IPv4 address.
for (const [ip, bits] of [
  ['::', 128], ['::1', 128], ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blocked.addSubnet(ip, bits, 'ipv6');

const isPublicIp = (address, family) => !blocked.check(address, family === 6 ? 'ipv6' : 'ipv4');

function ownHosts() {
  const own = new Set(['localhost']);
  try { own.add(new URL(baseUrl()).hostname.toLowerCase()); } catch {}
  return [...own];
}

function badUrl(url) {
  if (url.protocol !== 'https:') return 'Only https links can be downloaded.';
  if (url.port && url.port !== '443') return 'Only links on the normal https port can be downloaded.';
  if (url.username || url.password) return 'Links with a user name or password in them can’t be downloaded.';
  const host = url.hostname.replace(/\.$/, '').toLowerCase();
  if (host.startsWith('[') || net.isIP(host) || /^[\d.]+$/.test(host) || !host.includes('.') || PRIVATE_NAMES.test(host)) {
    return 'That address can’t be downloaded. Use a public https link.';
  }
  if (ownHosts().some(h => host === h || host.endsWith('.' + h))) {
    return 'That’s a link to this ShareSecure. To send an existing share to people, use send_share.';
  }
  return null;
}

// → { address, family } of a checked public address, or { error }
async function publicAddress(host) {
  let found;
  try { found = await dns.promises.lookup(host, { all: true, verbatim: true }); } catch { return { error: 'Couldn’t find that website. Check the link.' }; }
  if (!found.length || found.some(a => !isPublicIp(a.address, a.family))) {
    return { error: 'That address can’t be downloaded. Use a public https link.' };
  }
  return found[0];
}

// One GET, connecting only to the address given. Resolves with the response.
function getPinned(url, { address, family }, signal) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      protocol: 'https:',
      hostname: url.hostname,
      servername: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: 'GET',
      agent: false,
      signal,
      headers: { Accept: '*/*', 'User-Agent': 'ShareSecure', 'Accept-Encoding': 'identity' },
      lookup: (_host, opts, cb) => (opts && opts.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
    }, resolve);
    req.on('error', reject);
    req.end();
  });
}

// read a response, giving up once it passes max bytes → Buffer, or null if too big
function readCapped(res, max) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let total = 0;
    res.on('data', chunk => {
      total += chunk.length;
      if (total > max) { res.destroy(); resolve(null); return; }
      parts.push(chunk);
    });
    res.on('end', () => resolve(Buffer.concat(parts)));
    res.on('error', reject);
    res.on('aborted', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    // closed before the end (timed out, or the connection dropped); does nothing once settled
    res.on('close', () => reject(Object.assign(new Error('closed'), { name: 'AbortError' })));
  });
}

// the name from Content-Disposition, or else the last part of the URL
function nameFromResponse(res, url) {
  const cd = String(res.headers['content-disposition'] || '');
  const star = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(cd);
  if (star) { try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch {} }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  if (plain) return plain[1].trim();
  const last = url.pathname.split('/').pop() || '';
  try { return decodeURIComponent(last); } catch { return last; }
}

// → { bytes, filename } or { error }. Nothing of the user's (cookies, sign-in)
// is sent, so the link is fetched as a stranger would see it.
async function fetchFile(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl || '').trim()); } catch { return { error: 'That isn’t a valid link.' }; }
  const signal = AbortSignal.timeout(15000);
  try {
    for (let hop = 0; ; hop++) {
      const bad = badUrl(url);
      if (bad) return { error: bad };
      const target = await publicAddress(url.hostname.replace(/\.$/, ''));
      if (target.error) return target;
      const res = await getPinned(url, target, signal);
      const location = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && location) {
        res.resume();
        if (hop >= 3) return { error: 'That link redirects too many times.' };
        url = new URL(location, url);
        continue;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return { error: `The link answered ${res.statusCode}, so it couldn’t be downloaded. It has to work without signing in.` };
      }
      if (Number(res.headers['content-length']) > MAX_BYTES) {
        res.destroy();
        return { error: 'That file is over 10 MB.' };
      }
      const bytes = await readCapped(res, MAX_BYTES);
      if (!bytes) return { error: 'That file is over 10 MB.' };
      if (!bytes.length) return { error: 'That link gave back an empty file.' };
      return { bytes, filename: nameFromResponse(res, url) };
    }
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || signal.aborted) return { error: 'The download took longer than 15 seconds, so it was stopped.' };
    console.error('[mcp] download failed:', err.message);
    return { error: 'Couldn’t download that link. Check it works without signing in.' };
  }
}

// ── chunked uploads ──────────────────────────────────────────────────────────
// Kept in memory: this server is one process, and an upload is gone after 30
// minutes or once it's finished.
const uploads = new Map();   // upload_id → { filename, sha256, opts, size, parts, received, next, expires }

function dropExpiredUploads() {
  const now = Date.now();
  for (const [id, up] of uploads) if (up.expires <= now) uploads.delete(id);
}

function openUpload(uploadId) {
  dropExpiredUploads();
  return uploads.get(String(uploadId || '')) || null;
}

const NO_UPLOAD = { error: 'No open upload with that upload_id. It may have expired (they last 30 minutes); start again with begin_upload.' };

function beginUpload(args) {
  dropExpiredUploads();
  const size = Number(args.size);
  if (!Number.isInteger(size) || size < 1 || size > MAX_BYTES) {
    return { error: `size must be the file’s size in bytes, from 1 to ${MAX_BYTES} (10 MB).` };
  }
  const filename = cleanName(args.filename);
  if (!filename) return { error: 'filename is required, e.g. "report.pdf".' };
  const sha = args.sha256 ? String(args.sha256).trim().toLowerCase() : '';
  if (sha && !/^[0-9a-f]{64}$/.test(sha)) return { error: 'sha256 must be 64 hex characters.' };
  if (uploads.size >= MAX_OPEN_UPLOADS) {
    return { error: `There are already ${MAX_OPEN_UPLOADS} unfinished uploads. Finish one, or wait up to 30 minutes for them to expire.` };
  }

  const uploadId = 'up_' + crypto.randomBytes(24).toString('base64url');
  uploads.set(uploadId, { filename, sha256: sha, opts: shareOptions(args), size, parts: [], received: 0, next: 0, expires: Date.now() + UPLOAD_TTL_MS });
  const chunks = Math.ceil(size / CHUNK_SIZE);
  return {
    text: [
      `upload_id: ${uploadId}`,
      `chunk_size: ${CHUNK_SIZE} bytes`,
      `chunks: ${chunks} (index 0${chunks > 1 ? ` to ${chunks - 1}` : ''})`,
      'Send each chunk with upload_chunk, in order, then call finish_upload. The upload expires in 30 minutes.',
    ].join('\n'),
  };
}

function uploadChunk(args) {
  const up = openUpload(args.upload_id);
  if (!up) return NO_UPLOAD;
  const index = Number(args.index);
  const retry = up.next > 0 && index === up.next - 1;
  if (!Number.isInteger(index) || index < 0 || (index !== up.next && !retry)) {
    return { error: `Send chunk ${up.next} next${up.next ? ` (or ${up.next - 1} again)` : ''}.` };
  }
  const decoded = decodeBase64(args.data_base64, CHUNK_SIZE);
  if (decoded.error) return decoded;
  const bytes = decoded.bytes;
  if (args.sha256 && sha256(bytes) !== String(args.sha256).trim().toLowerCase()) {
    return { error: `Chunk ${index} doesn’t match its sha256. Encode it again and resend it.` };
  }
  const received = up.received - (retry ? up.parts[index].length : 0) + bytes.length;
  if (received > up.size) return { error: `That’s more than the ${up.size} bytes begin_upload was told the file is.` };

  up.parts[index] = bytes;
  up.received = received;
  up.next = index + 1;
  return {
    text: `Got chunk ${index} (${received} of ${up.size} bytes).` +
      (received === up.size ? ' That’s all of it: call finish_upload.' : ` Next: index ${index + 1}.`),
  };
}

async function finishUpload(args) {
  const id = String(args.upload_id || '');
  const up = openUpload(id);
  if (!up) return NO_UPLOAD;
  if (up.received !== up.size) {
    return { error: `Only ${up.received} of ${up.size} bytes have arrived. Send chunk ${up.next} next.` };
  }
  const bytes = Buffer.concat(up.parts.slice(0, up.next));
  if (up.sha256 && sha256(bytes) !== up.sha256) {
    uploads.delete(id);
    return { error: 'The file doesn’t match the sha256 given to begin_upload. Start again with begin_upload.' };
  }
  const result = await share(fileFor(bytes, up.filename), up.opts);
  if (!result.error) uploads.delete(id);
  return result;
}

// ── shares ───────────────────────────────────────────────────────────────────
const liveShare = id => db.prepare(`
  SELECT short_id, expires_at FROM files
  WHERE short_id = ? AND is_active = 1 AND inbox_status IS NULL AND (expires_at IS NULL OR expires_at > ?)
`).get(id, new Date().toISOString());

async function sendShare(args) {
  const id = String(args.id || '').trim();
  if (!id) return { error: 'id is required: the share id from list_shares or a share tool.' };
  const recipients = toRecipients(args.send_to);
  if (!recipients.length) return { error: 'send_to needs at least one ShareSecure username.' };
  const file = liveShare(id);
  if (!file) return { error: `No live share with id ${id}.` };
  const note = args.note ? String(args.note).trim().slice(0, 140) : '';
  const sent = await sendOn(id, recipients, note);
  if (sent.cloud_error && !sent.sent_to.length && !sent.not_sent.length) return { error: cloudHelp(sent.cloud_error, id) };
  return { id, url: `${baseUrl()}/r/${id}`, expires_at: file.expires_at, ...sent };
}

// Text the assistant wrote → a .md, .txt or .csv share
const TEXT_FORMATS = { markdown: '.md', plain: '.txt', csv: '.csv' };
function shareWrittenText(args) {
  // only tab, newlines and form feed survive of the control characters
  const text = String(args.text ?? '').replace(/[\x00-\x08\x0B\x0E-\x1F\x7F]/g, '');
  if (!text.trim()) return { error: 'text is empty. Pass the full content to share.' };
  if (text.length > TEXT_MAX) return { error: 'text is over 200,000 characters. Split it into parts and share each one.' };
  const ext = TEXT_FORMATS[args.format] || TEXT_FORMATS.markdown;
  // a title isn't a path, so "Q3 / Q4" keeps both halves
  const title = cleanName(String(args.title || '').replace(/[\\/]/g, '-')).replace(/\.(md|markdown|txt|csv)$/i, '') || 'Shared text';
  return share({ buffer: Buffer.from(text, 'utf8'), originalname: title + ext, mimetype: 'text/plain' }, shareOptions(args));
}

// ── tools ────────────────────────────────────────────────────────────────────
const COMMON = {
  expires_hours: { type: 'number', description: 'Hours until the link stops working, 1 to 240. Default 24.' },
  allow_download: { type: 'boolean', description: 'Let people who open the link download the file. Default false (view only).' },
  name: { type: 'string', description: 'Name shown to people who open the link. Defaults to the file name.' },
  send_to: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'ShareSecure usernames to send it to, e.g. ["alice", "bob"]. Each gets their own copy in their inbox to accept or decline. Use this whenever the user says who it’s for. Up to 20. Needs a ShareSecure account linked in the app; if none is linked, the link is still made and you’re told what the user needs to do.' },
  note: { type: 'string', maxLength: 140, description: 'Short note shown to the people it’s sent to. Up to 140 characters.' },
};

const SHARING = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const UPLOADING = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const TOOLS = [
  {
    name: 'share_text',
    title: 'Share text as a document',
    description: 'Share something you wrote or have in the conversation (a report, notes, a summary, an email draft, code, a table as CSV) as a private ShareSecure document with a link that expires, and optionally send it straight to ShareSecure usernames. Use this for anything you wrote or have in the conversation, and do it yourself: never ask the user to copy, save or upload it. Pass the full text; it’s shown exactly as written.',
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
      '1. content_base64 + filename: the file’s bytes, when you can read them. For a file you made or opened in a code sandbox, base64 it there and pass the result. Up to 2 MB, but base64 costs many tokens, so it’s best under about 100 KB.',
      '2. source_url: a public https link to the file; ShareSecure downloads it.',
      '3. Bigger files you can read in code: begin_upload, upload_chunk, finish_upload.',
      '4. path: a file on the computer ShareSecure runs on. Only works when you run on that same computer (for example Claude Code or Codex there), not through the public link.',
      'For text you wrote, use share_text instead. For a file the user attached in a chat app (such as claude.ai): if you can run code, it’s usually already in your sandbox (look through its files), so read it and base64 it there. Otherwise it reaches you as text or images, not the file itself, so share its content with share_text.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        content_base64: { type: 'string', description: 'The file’s bytes as base64 (standard or url-safe; a data: prefix is fine). At most 2 MB once decoded.' },
        filename: { type: 'string', description: 'The file’s name with its extension, e.g. "chart.png". Use it with content_base64.' },
        source_url: { type: 'string', description: 'A public https link to download the file from.' },
        path: { type: 'string', description: 'Absolute path to a file on the computer ShareSecure runs on. Only for assistants running on that computer.' },
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
    description: 'Send one of the existing shares here (the id from list_shares or a share tool) to ShareSecure usernames. Each gets their own copy in their inbox to accept or decline. Needs a ShareSecure account linked in the app; if none is linked, you’re told what the user needs to do.',
    inputSchema: {
      type: 'object',
      required: ['id', 'send_to'],
      properties: { id: { type: 'string', description: 'The share id.' }, send_to: COMMON.send_to, note: COMMON.note },
    },
    annotations: SHARING,
  },
  {
    name: 'list_shares',
    title: 'List shares',
    description: 'List files shared from this ShareSecure that are still live, with their links and time left.',
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

const NO_FILE = 'No file was given, so nothing was shared. Share it yourself: pass content_base64 + filename if you can read the file (for example in your code sandbox), source_url if it’s at a public https link, begin_upload for bigger files, or path if you run on the computer ShareSecure runs on. For text you wrote or have in the conversation, use share_text.';

const NOT_HERE = 'This request came through the public link, not from the computer ShareSecure runs on, so path can’t be used. Share it another way: content_base64 + filename if you can read the file (for example in your code sandbox), source_url if it’s at a public https link, begin_upload for bigger files, or share_text for text you wrote or have in the conversation.';

async function callTool(name, args, req) {
  const shared = result => result.error ? result : { text: resultText(result) };

  if (name === 'share_text') return shared(await shareWrittenText(args));

  if (name === 'share_file') {
    const opts = shareOptions(args);
    if (args.content_base64) {
      const decoded = decodeBase64(args.content_base64, INLINE_MAX);
      if (decoded.error) return decoded;
      return shared(await share(fileFor(decoded.bytes, args.filename || args.name), opts));
    }
    if (args.source_url) {
      const got = await fetchFile(args.source_url);
      if (got.error) return got;
      return shared(await share(fileFor(got.bytes, args.filename || got.filename), opts));
    }
    if (!args.path) return { error: NO_FILE };
    if (!fromThisComputer(req)) return { error: NOT_HERE };

    const filePath = path.resolve(String(args.path));
    let stat;
    try { stat = fs.statSync(filePath); } catch { return { error: `No file at ${filePath}` }; }
    if (!stat.isFile()) return { error: `${filePath} isn't a file.` };
    if (stat.size > MAX_BYTES) return { error: 'That file is over 10 MB.' };
    return shared(await share(fileFor(fs.readFileSync(filePath), path.basename(filePath)), opts));
  }

  if (name === 'begin_upload') return beginUpload(args);
  if (name === 'upload_chunk') return uploadChunk(args);
  if (name === 'finish_upload') return shared(await finishUpload(args));

  if (name === 'send_share') return shared(await sendShare(args));

  if (name === 'list_shares') {
    const rows = db.prepare(`
      SELECT short_id, original_filename, expires_at FROM files
      WHERE is_active = 1 AND inbox_status IS NULL AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY uploaded_at DESC LIMIT 50
    `).all(new Date().toISOString());
    if (!rows.length) return { text: 'No live shares.' };
    const key = getEncKey();
    return {
      text: rows.map(r => {
        let fname = r.original_filename;
        try { fname = decryptString(r.original_filename, key); } catch {}
        return `- ${fname} — ${baseUrl()}/r/${r.short_id} (id ${r.short_id}, expires ${r.expires_at})`;
      }).join('\n'),
    };
  }

  if (name === 'delete_share') {
    const id = String(args.id || '');
    const file = db.prepare('SELECT short_id, cluster_id FROM files WHERE short_id = ?').get(id);
    if (!file) return { error: `No share with id ${id}.` };
    purgeLink(file);
    return { text: `Deleted ${id}. Its link, and every link shared from it, no longer work.` };
  }

  return { error: `Unknown tool ${name}` };
}

const INSTRUCTIONS = [
  'ShareSecure shares files and documents through private links that expire, and can send them straight to ShareSecure usernames. This ShareSecure runs on the user’s own computer. Do the whole job yourself; never tell the user to download, save or upload something you can share with these tools.',
  '- Text you wrote or have in the conversation (reports, notes, drafts, code, CSV): share_text.',
  '- A file you can read, such as one you made or opened in a code sandbox: share_file with content_base64 and filename (best under about 100 KB), or begin_upload, upload_chunk and finish_upload for bigger files, computing the base64 in code.',
  '- A file at a public https link: share_file with source_url.',
  '- A file on the computer ShareSecure runs on, when you run there too: share_file with path.',
  'When the user says who it’s for, pass send_to (and a short note if it helps); to send something already shared, use send_share. Sending to usernames needs a ShareSecure account linked in the app; if it isn’t, tell the user how to link it. Reply with the link, when it expires, and who received it.',
].join('\n');

// ── JSON-RPC over Streamable HTTP ────────────────────────────────────────────
async function handleMessage(msg, req) {
  const { id, method, params = {} } = msg || {};
  if (id === undefined || id === null) return null; // notification: nothing to answer
  const reply = result => ({ jsonrpc: '2.0', id, result });

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'sharesecure', title: 'ShareSecure', version: VERSION },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      try {
        const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
        const out = await callTool(params.name, args, req);
        return reply(out.error
          ? { content: [{ type: 'text', text: out.error }], isError: true }
          : { content: [{ type: 'text', text: out.text }] });
      } catch (err) {
        console.error('[mcp] tool failed:', params.name, err);
        return reply({ content: [{ type: 'text', text: 'Something went wrong. Try again.' }], isError: true });
      }
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

const rpcError = (res, status, code, message) => res.status(status).json({ jsonrpc: '2.0', id: null, error: { code, message } });

// Checked before the body is read, so nobody without the token can make it
// read a big one. tokenFrom: apps like Claude and ChatGPT only take a URL when
// adding a connector, so their connector URL carries the token (/connect/<token>).
function guard(tokenFrom = null) {
  return (req, res, next) => {
    if (req.method !== 'POST') {
      return res.status(405).set('Allow', 'POST').send('ShareSecure MCP endpoint. Connect with an MCP client using POST.');
    }
    const token = tokenFrom ? tokenFrom(req) : null;
    if (!tokenOk(token ? `Bearer ${token}` : req.headers.authorization)) {
      res.set('WWW-Authenticate', 'Bearer');
      return rpcError(res, 401, -32001, 'Missing or invalid ShareSecure token. Create one in the account menu under Connect an AI assistant.');
    }
    next();
  };
}

// 2 MB of base64 plus the rest of the message fits in 4 MB
const body = express.json({ limit: '4mb' });

async function handle(req, res) {
  const msg = req.body;
  if (Array.isArray(msg)) {
    if (msg.length > MAX_BATCH) return rpcError(res, 400, -32600, `Too many messages in one batch (at most ${MAX_BATCH}).`);
    // one at a time, so chunks in a batch arrive in order
    const out = [];
    for (const m of msg) {
      const r = await handleMessage(m, req);
      if (r) out.push(r);
    }
    return out.length ? res.json(out) : res.status(202).end();
  }
  const out = await handleMessage(msg, req);
  return out ? res.json(out) : res.status(202).end();
}

// a body that's too big or isn't JSON still gets a JSON-RPC answer
function bodyErrors(err, _req, res, next) {
  if (!err) return next();
  if (err.type === 'entity.too.large') return rpcError(res, 413, -32600, 'That message is over 4 MB. Send files over 2 MB in chunks with begin_upload.');
  if (err.type === 'entity.parse.failed') return rpcError(res, 400, -32700, 'Parse error');
  console.error('[mcp] request failed:', err.message);
  return rpcError(res, 500, -32603, 'Something went wrong. Try again.');
}

router.all('/', guard(), body, (req, res, next) => handle(req, res).catch(next));
router.use(bodyErrors);

// /connect/<token>: the connector URL for apps that only accept a URL
const connectRouter = express.Router();
connectRouter.all('/:token', guard(req => req.params.token), body, (req, res, next) => handle(req, res).catch(next));
connectRouter.use(bodyErrors);

module.exports = { router, connectRouter, tokenStatus, createToken, revokeToken };
