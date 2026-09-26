'use strict';
// Sending to ShareSecure usernames from a private ShareSecure.
//
// Usernames only exist on the ShareSecure website, so the owner links their
// ShareSecure account here. Sending a share to someone uploads an encrypted copy
// to the website with that account (once per share, however many people get it)
// and asks the website to deliver it. That way the recipient can open it even
// when this computer is off. The copy expires when the share here does.
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const { db, UPLOADS_DIR } = require('../db');
const { requireOwner } = require('../session');
const {
  getEncKey, encryptString, decryptString, decryptWithPerFileKey, decompress,
} = require('../utils');
const settings = require('../settings');

const NOTE_MAX = 140;
const cloud = () => (process.env.SHARESECURE_CLOUD || 'https://sharesecure-du8.pages.dev').replace(/\/+$/, '');

// ── the linked account ────────────────────────────────────────────────────────
function cloudToken() {
  const stored = settings.get('cloudToken');
  return stored ? decryptString(stored, getEncKey()) : null;
}

function status() {
  return { linked: Boolean(settings.get('cloudToken')), username: settings.get('cloudUsername') || null, cloudUrl: cloud() };
}

// The website turned the token down (it expired, or the account was deleted).
// Keep the username so linking again only needs the password, and keep the
// copies: their delete keys still work without signing in, so deleting a share
// here can still take its copy back.
function forgetToken() {
  settings.set('cloudToken', null);
}

// ── copies already on the website, one per share here ─────────────────────────
// { localShortId: { id, deleteToken, expiresAt } }, stored encrypted.
function loadCopies() {
  const stored = settings.get('cloudCopies');
  if (!stored) return {};
  try {
    const all = JSON.parse(decryptString(stored, getEncKey()));
    const now = new Date().toISOString();
    return Object.fromEntries(Object.entries(all).filter(([, c]) => c && c.expiresAt > now));
  } catch {
    return {};
  }
}

function saveCopies(copies) {
  settings.set('cloudCopies', Object.keys(copies).length ? encryptString(JSON.stringify(copies), getEncKey()) : null);
}

async function cloudFetch(pathname, options = {}) {
  const res = await fetch(cloud() + pathname, { ...options, signal: AbortSignal.timeout(120000) });
  let body = {};
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

// Reads a stored share back into its original bytes.
function readShare(file) {
  const data = fs.readFileSync(path.join(UPLOADS_DIR, file.stored_filename));
  const encKey = getEncKey();
  let bytes = file.encrypted ? decryptWithPerFileKey(data, file.wrapped_key || null, encKey) : data;
  if (file.compressed) bytes = decompress(bytes);
  return bytes;
}

const uploading = new Map();   // shortId → promise, so a burst of sends uploads once
// A share deleted, or every copy taken back, while its upload is still running:
// the upload must not keep (or deliver) its copy when it finishes.
const forgotten = new Set();    // shortIds deleted mid-upload
let copiesGeneration = 0;       // bumped by forgetAllCloudCopies

// Returns { id, deleteToken } for the website's copy of a share, uploading it if needed,
// or { status, error } when that isn't possible.
function cloudCopy(shortId, token) {
  const cached = loadCopies()[shortId];
  if (cached) return Promise.resolve(cached);
  if (uploading.has(shortId)) return uploading.get(shortId);

  const job = (async () => {
    const generation = copiesGeneration;
    const file = db.prepare('SELECT * FROM files WHERE short_id = ? AND is_active = 1').get(shortId);
    if (!file || !file.stored_filename || file.expires_at <= new Date().toISOString()) {
      return { status: 404, error: 'File not found' };
    }
    const encKey = getEncKey();
    const name = decryptString(file.original_filename, encKey) || 'file';
    const mime = decryptString(file.mime_type, encKey) || 'application/octet-stream';
    let bytes;
    try { bytes = readShare(file); } catch { return { status: 500, error: 'Couldn’t read the file.' }; }

    // the website's copy lasts exactly as long as the share here
    const hoursLeft = (new Date(file.expires_at).getTime() - Date.now()) / 3600000;
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime }), name);
    form.append('expires_hours', String(Math.min(Math.max(hoursLeft, 1 / 60), 240)));
    form.append('allow_download', file.allow_download ? '1' : '0');
    form.append('allow_annotations', file.allow_annotations ? '1' : '0');
    // it's only ever for the people it's sent to, who are signed in
    form.append('require_account', '1');
    form.append('display_name', name);

    const { status: code, body } = await cloudFetch('/api/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (code === 401) return { status: 401, error: 'link_expired' };
    if (code === 429) return { status: 429, error: 'Your ShareSecure account has reached today’s upload limit. Try again tomorrow.' };
    if (code !== 200 || !body.shortId) return { status: 502, error: body.error || 'ShareSecure didn’t take the file. Try again.' };

    const copy = { id: body.shortId, deleteToken: body.deleteToken || null, expiresAt: body.expiresAt || file.expires_at };
    // taken back while it was uploading: delete the new copy instead of keeping it
    const stillHere = db.prepare('SELECT 1 FROM files WHERE short_id = ? AND is_active = 1').get(shortId);
    if (!stillHere || forgotten.has(shortId) || generation !== copiesGeneration) {
      await deleteCopy(copy, token);
      return stillHere && !forgotten.has(shortId)
        ? { status: 502, error: 'Couldn’t send it. Try again.' }
        : { status: 404, error: 'File not found' };
    }
    const copies = loadCopies();
    copies[shortId] = copy;
    saveCopies(copies);
    return copy;
  })().finally(() => { uploading.delete(shortId); forgotten.delete(shortId); });

  uploading.set(shortId, job);
  return job;
}

// Sends one share to one username. Resolves with { status, body } where body is
// { sent: true } or { error } ('link_account', 'link_expired', 'User not found', …).
async function sendOne(shortId, username, note) {
  const token = cloudToken();
  if (!token) return { status: 409, body: { error: 'link_account' } };

  for (let attempt = 0; attempt < 2; attempt++) {
    const copy = await cloudCopy(shortId, token);
    if (copy.error) {
      if (copy.status === 401) forgetToken();
      return { status: copy.status, body: { error: copy.error } };
    }
    const { status: code, body } = await cloudFetch(`/api/send/${encodeURIComponent(copy.id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ targetUsername: username, note, deleteToken: copy.deleteToken }),
    });
    if (code === 401) {
      forgetToken();
      return { status: 401, body: { error: 'link_expired' } };
    }
    // the website's copy is gone (deleted there, or expired): upload a new one once
    if ((code === 404 || code === 410) && body.error !== 'User not found' && attempt === 0) {
      const copies = loadCopies();
      delete copies[shortId];
      saveCopies(copies);
      continue;
    }
    if (body.sent) return { status: 200, body: { sent: true } };
    return { status: code >= 400 ? code : 502, body: { error: body.error || 'Couldn’t send it. Try again.' } };
  }
  return { status: 502, body: { error: 'Couldn’t send it. Try again.' } };
}

/**
 * Sends a share on this computer to ShareSecure usernames (for the assistant tools).
 *   sendToCloud(shortId: string, usernames: string[], note?: string)
 *     → Promise<{ sent_to: string[], not_sent: { username, reason }[], error?: 'link_account' | 'link_expired' }>
 * Never throws. error is set when no account is linked or the link has expired;
 * then every username is in not_sent.
 */
async function sendToCloud(shortId, usernames, note = '') {
  const names = [...new Set((usernames || []).map(u => String(u).trim().replace(/^@/, '')).filter(Boolean))].slice(0, 20);
  const result = { sent_to: [], not_sent: [] };
  const cleanNote = String(note || '').trim().slice(0, NOTE_MAX);
  for (const username of names) {
    let out;
    try { out = await sendOne(shortId, username, cleanNote); }
    catch { out = { status: 502, body: { error: 'Couldn’t reach ShareSecure.' } }; }
    if (out.body.sent) { result.sent_to.push(username); continue; }
    const err = out.body.error;
    if (err === 'link_account' || err === 'link_expired') {
      result.error = err;
      const reason = err === 'link_account'
        ? 'No ShareSecure account is linked. Link one from the account menu (ShareSecure account).'
        : 'The linked ShareSecure account needs signing in again (account menu → ShareSecure account).';
      for (const u of names.slice(names.indexOf(username))) result.not_sent.push({ username: u, reason });
      break;
    }
    result.not_sent.push({ username, reason: err === 'User not found' ? 'No user with that name' : err });
  }
  return result;
}

/**
 * Deletes the website's copy of a share, if there is one, so people it was sent
 * to lose it too. Best effort; call it when a share here is deleted.
 *   forgetCloudCopy(shortId: string) → Promise<void>
 */
async function forgetCloudCopy(shortId) {
  if (uploading.has(shortId)) forgotten.add(shortId);
  const copies = loadCopies();
  const copy = copies[shortId];
  if (!copy) return;
  delete copies[shortId];
  saveCopies(copies);
  await deleteCopy(copy, cloudToken());
}

// The delete key alone is enough for the website, so this works even after the
// account's sign-in has expired.
async function deleteCopy(copy, token) {
  try {
    await cloudFetch(`/api/delete/${encodeURIComponent(copy.id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ deleteToken: copy.deleteToken }),
    });
  } catch { /* it still expires with the share */ }
}

/**
 * Deletes every copy on the website, for when the account is unlinked or
 * swapped, or the owner account here is deleted: afterwards nothing here would
 * remember them, so they could never be taken back. Best effort.
 *   forgetAllCloudCopies() → Promise<void>
 */
async function forgetAllCloudCopies() {
  copiesGeneration++;
  const copies = Object.values(loadCopies());
  const token = cloudToken();
  settings.set('cloudCopies', null);
  await Promise.all(copies.map(copy => deleteCopy(copy, token)));
}

// ── owner: is an account linked? ─────────────────────────────────────────────
router.get('/cloud', requireOwner, (_req, res) => res.json(status()));

// ── owner: link an account with its username and password ────────────────────
// Only the website's sign-in token is kept (encrypted), never the password.
router.post('/cloud/link', requireOwner, async (req, res) => {
  const username = String(req.body?.username || '').trim().replace(/^@/, '');
  const accessCode = String(req.body?.access_code || '');
  if (!username || !accessCode) return res.status(400).json({ error: 'Enter your username and password.' });

  let out;
  try {
    out = await cloudFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, access_code: accessCode }),
    });
  } catch {
    return res.status(502).json({ error: 'Couldn’t reach ShareSecure. Check your connection and try again.' });
  }
  if (out.status === 429) return res.status(429).json({ error: out.body.error || 'Too many tries. Wait a few minutes and try again.' });
  if (out.status !== 200 || !out.body.token) return res.status(403).json({ error: 'Wrong username or password.' });

  // copies made with a different account are taken back; the same account's stay
  const newName = out.body.username || username;
  const oldName = settings.get('cloudUsername');
  if (oldName && oldName.toLowerCase() !== newName.toLowerCase()) forgetAllCloudCopies().catch(() => {});
  settings.set('cloudToken', encryptString(out.body.token, getEncKey()));
  settings.set('cloudUsername', newName);
  res.json(status());
});

// ── owner: unlink ─────────────────────────────────────────────────────────────
// Files already sent from here are taken back from the people who got them,
// since nothing here could reach them afterwards.
router.delete('/cloud', requireOwner, (_req, res) => {
  forgetAllCloudCopies().catch(() => {});
  settings.set('cloudToken', null);
  settings.set('cloudUsername', null);
  res.json(status());
});

// ── owner: send a share to a username ─────────────────────────────────────────
// Same answers as the website's /api/send, plus 409 link_account and 401 link_expired.
router.post('/send/:shortId', requireOwner, async (req, res) => {
  const username = String(req.body?.targetUsername || '').trim().replace(/^@/, '');
  if (!username) return res.status(400).json({ error: 'targetUsername required' });
  const note = String(req.body?.note || '').trim().slice(0, NOTE_MAX);
  try {
    const out = await sendOne(req.params.shortId, username, note);
    res.status(out.status).json(out.body);
  } catch {
    res.status(502).json({ error: 'Couldn’t reach ShareSecure. Check your connection and try again.' });
  }
});

module.exports = router;
module.exports.sendToCloud = sendToCloud;
module.exports.forgetCloudCopy = forgetCloudCopy;
module.exports.forgetAllCloudCopies = forgetAllCloudCopies;
module.exports.cloudStatus = status;
