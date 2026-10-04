'use strict';
// Sending to ShareSecure usernames from a private ShareSecure.
//
// Usernames only exist on the ShareSecure website, so the owner links their
// ShareSecure account here. Sending a share to someone uploads a copy to the
// website (once per share, however many people get it) and asks the website to
// deliver it. That way the recipient can open it even when this computer is off.
// The copy expires when the share here does.
//
// The copy is end-to-end encrypted exactly like the website's own uploads
// (public/sealed.js): sealed here, padded, with its key sealed to each person
// it's sent to, so ShareSecure can't read it. Uploads and sends spend anonymous
// tokens (public/blindrsa.js) that this computer picks up in the background, so
// ShareSecure can't tell they came from this account either.
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

// The browser modules (ES modules) that do the cryptography.
const lib = () => Promise.all([
  import('../../public/sealed.js'), import('../../public/filetypes.js'), import('../../public/blindrsa.js'),
]).then(([sealed, filetypes, blindrsa]) => ({ ...sealed, ...filetypes, ...blindrsa }));

// ── anonymous tokens ─────────────────────────────────────────────────────────
// A few tokens are kept here (encrypted, like everything in settings), topped
// up a while after linking or starting, never right before they're spent.
const KEEP = { upload: 2, send: 10 };
const DAY_MS = 24 * 60 * 60 * 1000;

function loadTokens() {
  try {
    const stored = settings.get('cloudTokens');
    const list = stored ? JSON.parse(decryptString(stored, getEncKey())) : [];
    return list.filter(t => t.day >= Math.floor(Date.now() / DAY_MS) - 1);
  } catch { return []; }
}

function saveTokens(list) {
  settings.set('cloudTokens', list.length ? encryptString(JSON.stringify(list), getEncKey()) : null);
}

// Takes one token → the header value to send it with, or null.
function takeToken(kind) {
  const list = loadTokens();
  const i = list.findIndex(t => t.kind === kind);
  if (i < 0) return null;
  const [t] = list.splice(i, 1);
  saveTokens(list);
  return `${t.kind}.${t.day}.${t.nonce}.${t.sig}`;
}

let refilling = false;
async function refillTokens() {
  const token = cloudToken();
  if (refilling || !token) return;
  refilling = true;
  try {
    const { issuerKey, blind, finalize, tokenMessage, newFileKey, toB64url, fromB64url } = await lib();
    const auth = { Authorization: `Bearer ${token}` };
    const info = await cloudFetch('/api/tokens', { headers: auth });
    if (info.status !== 200 || !info.body.available || !info.body.left) return;
    // only the key pinned for this site (see public/tokens.js)
    const { trustedIssuer } = await import('../../public/tokens.js');
    if (!(await trustedIssuer(cloud(), info.body.publicKey))) return;
    const key = await issuerKey(info.body.publicKey);
    for (const kind of ['upload', 'send']) {
      let want = Math.min(KEEP[kind] - loadTokens().filter(t => t.kind === kind).length, info.body.left[kind]);
      while (want-- > 0) {
        await new Promise(r => setTimeout(r, 500 + Math.random() * 2000));
        const nonce = newFileKey();
        const msg = tokenMessage(kind, info.body.day, info.body.keyId, nonce);
        const { blinded, inv } = await blind(key, msg);
        const signed = await cloudFetch('/api/tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...auth },
          body: JSON.stringify({ kind, blinded: toB64url(blinded) }),
        });
        if (signed.status !== 200) break;
        const sig = await finalize(key, msg, fromB64url(signed.body.signature), inv);
        saveTokens([...loadTokens(), { kind, day: info.body.day, nonce: toB64url(nonce), sig: toB64url(sig) }]);
      }
    }
  } catch { /* without tokens, uploads and sends use the account's sign-in */ }
  finally { refilling = false; }
}

// some minutes from now, so getting tokens and spending them don't line up
function refillLater() {
  setTimeout(() => refillTokens(), (1 + Math.random() * 4) * 60 * 1000).unref?.();
}
refillLater();

// A username's public key → string, null (none yet) or undefined (no such user).
async function publicKeyOf(username) {
  const out = await cloudFetch(`/api/keys?username=${encodeURIComponent(username)}`);
  if (out.status === 404) return undefined;
  return out.body.publicKey || null;
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

    // sealed here: a fresh key, the file padded and locked with it, and the
    // name and type locked too
    const { newFileKey, lockFile, lockMeta, sealKey, nameFor, isAllowedType, toB64url } = await lib();
    if (!isAllowedType(mime)) return { status: 415, error: 'That kind of file can’t be sent.' };
    const key = newFileKey();
    const form = new FormData();
    form.append('file', new Blob([await lockFile(key, new Uint8Array(bytes))]), 'sealed.bin');
    form.append('e2e', '1');
    form.append('meta', await lockMeta(key, { name: nameFor(name, '', mime), type: mime }));
    // sealed to the linked account too, so it shows in Your shares on the website
    const ownKey = await publicKeyOf(settings.get('cloudUsername') || '').catch(() => null);
    if (ownKey) form.append('owner_key', await sealKey(ownKey, key));
    // the website's copy lasts exactly as long as the share here
    const hoursLeft = (new Date(file.expires_at).getTime() - Date.now()) / 3600000;
    form.append('expires_hours', String(Math.min(Math.max(hoursLeft, 1 / 60), 240)));
    form.append('allow_download', file.allow_download ? '1' : '0');
    form.append('allow_annotations', file.allow_annotations ? '1' : '0');
    // it's only ever for the people it's sent to, who are signed in
    form.append('require_account', '1');

    // an anonymous token when there is one, so the upload isn't tied to the account
    const anon = takeToken('upload');
    let { status: code, body } = await cloudFetch('/api/upload', {
      method: 'POST',
      headers: anon ? { 'X-ShareSecure-Token': anon } : { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (anon && code === 401) {
      ({ status: code, body } = await cloudFetch('/api/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form }));
    }
    if (anon) refillLater();
    if (code === 401) return { status: 401, error: 'link_expired' };
    if (code === 429) return { status: 429, error: 'Your ShareSecure account has reached today’s upload limit. Try again tomorrow.' };
    if (code !== 200 || !body.shortId) return { status: 502, error: body.error || 'ShareSecure didn’t take the file. Try again.' };

    const copy = { id: body.shortId, deleteToken: body.deleteToken || null, expiresAt: body.expiresAt || file.expires_at, key: toB64url(key) };
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
    // copies made before end-to-end encryption are sent as they are
    const request = { targetUsername: username, deleteToken: copy.deleteToken, note };
    let anon = null;
    if (copy.key) {
      const { sealKey, lockText, fromB64url } = await lib();
      const theirKey = await publicKeyOf(username);
      if (theirKey === undefined) return { status: 404, body: { error: 'User not found' } };
      if (!theirKey) return { status: 409, body: { error: 'They need to sign in to ShareSecure once before they can get end-to-end encrypted files.' } };
      const fileKey = fromB64url(copy.key);
      request.sealed_key = await sealKey(theirKey, fileKey);
      if (note) request.note = await lockText(fileKey, note, 'note');
      anon = takeToken('send');
    }
    const send = headers => cloudFetch(`/api/send/${encodeURIComponent(copy.id)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(request),
    });
    let { status: code, body } = await send(anon ? { 'X-ShareSecure-Token': anon } : { Authorization: `Bearer ${token}` });
    if (anon && code === 401) ({ status: code, body } = await send({ Authorization: `Bearer ${token}` }));
    if (anon) refillLater();
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

// The account's rule for assistants → 'approve' | 'anyone' | 'nobody', or { error }
async function agentMode(token) {
  const out = await cloudFetch('/api/auth/assistant', { headers: { Authorization: `Bearer ${token}` } });
  if (out.status === 401) { forgetToken(); return { error: 'link_expired' }; }
  return out.body.mode || 'approve';
}

// Keeps a send for the owner's OK on the website: which copy, to whom, and its
// key, sealed to the account's own key, so the server can't read any of it.
// The owner's browser opens it and sends it anonymously if they approve.
async function holdForApproval(shortId, username, note, token) {
  const copy = await cloudCopy(shortId, token);
  if (copy.error) return { status: copy.status, body: { error: copy.error } };
  const me = settings.get('cloudUsername');
  const ownKey = me ? await publicKeyOf(me) : null;
  if (!ownKey) return { status: 409, body: { error: 'The linked account has no key yet. Sign in on the website once.' } };
  const { sealText } = await lib();
  const box = await sealText(ownKey, JSON.stringify({
    short_id: copy.id, username, file_key: copy.key, delete_token: copy.deleteToken, note: note || null, name: null,
  }), 'agent-send');
  const out = await cloudFetch('/api/auth/assistant', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: 'hold', box }),
  });
  return out.body.waiting ? { status: 202, body: { waiting: true } } : { status: out.status, body: { error: out.body.error || 'Couldn’t keep it for approval.' } };
}

/**
 * Sends a share on this computer to ShareSecure usernames (for the assistant tools).
 *   sendToCloud(shortId: string, usernames: string[], note?: string)
 *     → Promise<{ sent_to: string[], waiting_for_approval: string[], not_sent: { username, reason }[], error?: 'link_account' | 'link_expired' }>
 * Never throws. error is set when no account is linked or the link has expired;
 * then every username is in not_sent.
 */
async function sendToCloud(shortId, usernames, note = '') {
  const names = [...new Set((usernames || []).map(u => String(u).trim().replace(/^@/, '')).filter(Boolean))].slice(0, 20);
  const result = { sent_to: [], waiting_for_approval: [], not_sent: [] };
  const cleanNote = String(note || '').trim().slice(0, NOTE_MAX);
  const token = cloudToken();
  // This app can't open the owner's list of people (it's sealed to their key),
  // so under "approve" every send waits for their OK on the website.
  let mode = 'approve';
  if (token) {
    try { mode = await agentMode(token); } catch { mode = 'approve'; }
  }
  for (const username of names) {
    let out;
    try {
      if (!token) out = { status: 409, body: { error: 'link_account' } };
      else if (mode?.error) out = { status: 401, body: { error: mode.error } };
      else if (mode === 'nobody') out = { status: 403, body: { error: 'The account doesn’t let assistants send files to people. The owner can change that on the website: account menu → Connect an AI assistant.' } };
      else if (mode === 'anyone') out = await sendOne(shortId, username, cleanNote);
      else out = await holdForApproval(shortId, username, cleanNote, token);
    } catch { out = { status: 502, body: { error: 'Couldn’t reach ShareSecure.' } }; }
    if (out.body.sent) { result.sent_to.push(username); continue; }
    if (out.body.waiting) { result.waiting_for_approval.push(username); continue; }
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

  // The website never sees the password: this computer proves it the same way
  // a browser does (OPAQUE, public/opaque.js). Older accounts send it once to
  // switch over, and make their end-to-end keys while they're at it.
  let out;
  try {
    const { signIn, postWith } = await import('../../public/opaque.js');
    const { makeKeyPair, lockPrivateKey } = await import('../../public/sealed.js');
    const newKeys = async exportKey => {
      const pair = await makeKeyPair();
      return { public_key: pair.publicKey, private_key_box: await lockPrivateKey(pair.privateKey, exportKey) };
    };
    const post = postWith((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(120000) }), cloud());
    out = { status: 200, body: await signIn(post, username, accessCode, newKeys) };
  } catch (err) {
    if (err.status === 429) return res.status(429).json({ error: err.message || 'Too many tries. Wait a few minutes and try again.' });
    if (err.status === 401 || err.status === 400) return res.status(403).json({ error: 'Wrong username or password.' });
    return res.status(502).json({ error: 'Couldn’t reach ShareSecure. Check your connection and try again.' });
  }
  if (!out.body.token) return res.status(403).json({ error: 'Wrong username or password.' });

  // copies made with a different account are taken back; the same account's stay
  const newName = out.body.username || username;
  const oldName = settings.get('cloudUsername');
  if (oldName && oldName.toLowerCase() !== newName.toLowerCase()) forgetAllCloudCopies().catch(() => {});
  settings.set('cloudToken', encryptString(out.body.token, getEncKey()));
  settings.set('cloudUsername', newName);
  saveTokens([]);   // tokens belong to the account that got them
  refillLater();
  res.json(status());
});

// ── owner: unlink ─────────────────────────────────────────────────────────────
// Files already sent from here are taken back from the people who got them,
// since nothing here could reach them afterwards.
router.delete('/cloud', requireOwner, (_req, res) => {
  forgetAllCloudCopies().catch(() => {});
  settings.set('cloudToken', null);
  settings.set('cloudUsername', null);
  saveTokens([]);
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
module.exports.refillTokens = refillTokens;
