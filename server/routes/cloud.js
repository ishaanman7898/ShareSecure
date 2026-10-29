'use strict';
// Sending to ShareSecure usernames from a self-hosted ShareSecure, and
// receiving files sent to yours.
//
// Usernames only exist on the website, so the owner links their account here.
// The desktop app makes and links one with the owner's own username and
// password when they set up or sign in (POST /cloud/auto), unless they've
// linked another account or unlinked.
// Sending uploads one copy of the share to the website, sealed end to end like
// the website's own uploads (public/sealed.js), and asks it to deliver. People
// can then open it while this computer is off; the copy expires with the share.
// Uploads and sends spend anonymous tokens (public/blindrsa.js), so the website
// can't tell they came from this account.
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
const events = require('../events');

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

// The account's private key: files sent to your username are sealed to it.
// Linking unlocks it once, with the export key signing in makes here, and it's
// kept encrypted like everything else in settings.
async function keepAccountKey(out, token) {
  const { unlockPrivateKeyBytes, makeKeyPair, lockPrivateKey, toB64url } = await lib();
  let box = out.privateKeyBox;
  if (!box) {
    // an account with no keys yet gets them now, as a browser would (public/keys.js)
    const pair = await makeKeyPair();
    const fields = { public_key: pair.publicKey, private_key_box: await lockPrivateKey(pair.privateKey, out.exportKey) };
    const made = await cloudFetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(fields),
    });
    if (made.status !== 200) return;
    box = fields.private_key_box;
  }
  settings.set('cloudKey', encryptString(toB64url(await unlockPrivateKeyBytes(box, out.exportKey)), getEncKey()));
}

async function accountKey() {
  const stored = settings.get('cloudKey');
  if (!stored) return null;
  try {
    const { importPrivateKey, fromB64url } = await lib();
    return await importPrivateKey(fromB64url(decryptString(stored, getEncKey())));
  } catch { return null; }
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
  import('../../public/sealed.js'), import('../../public/filetypes.js'), import('../../public/blindrsa.js'), import('../../public/kt.js'),
  import('../../public/mcp-common.js'),
]).then(([sealed, filetypes, blindrsa, kt, common]) => ({ ...sealed, ...filetypes, ...blindrsa, ...kt, toRecipients: common.toRecipients }));

// ── anonymous tokens ─────────────────────────────────────────────────────────
// A day's worth of tokens is kept here (encrypted, like everything in
// settings), topped up a while after linking or starting. Uploads and sends of
// locked shares never fall back to the account's sign-in: with none left, one
// is fetched first (anonToken), since a signed-in upload names the account.
const KEEP = { upload: 5, send: 20 };
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

// a short random wait between tokens, so they don't arrive as one burst (tests skip it)
let pause = () => new Promise(r => setTimeout(r, 500 + Math.random() * 2000));

// One top-up at a time; calling again while one runs waits for it.
let refilling = null;
function refillTokens() {
  if (!cloudToken()) return Promise.resolve();
  if (!refilling) refilling = fill().finally(() => { refilling = null; });
  return refilling;
}

async function fill() {
  const token = cloudToken();
  try {
    const { issuerKey, blind, finalize, tokenMessage, newFileKey, toB64url, fromB64url } = await lib();
    const auth = { Authorization: `Bearer ${token}` };
    const info = await cloudFetch('/api/tokens', { headers: auth });
    if (info.status === 401) { forgetToken(); return; }
    if (info.status !== 200 || !info.body.available || !info.body.left) return;
    // only the key pinned for this site (see public/tokens.js)
    const { trustedIssuer } = await import('../../public/tokens.js');
    if (!(await trustedIssuer(cloud(), info.body.publicKey))) return;
    const key = await issuerKey(info.body.publicKey);
    for (const kind of ['upload', 'send']) {
      let want = Math.min(KEEP[kind] - loadTokens().filter(t => t.kind === kind).length, info.body.left[kind]);
      while (want-- > 0) {
        await pause();
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
  } catch { /* no tokens: anonToken says so, and nothing goes signed in instead */ }
}

// A token to spend, topping up first if there are none → header value, or null
// when the account has used today's.
async function anonToken(kind) {
  const token = takeToken(kind);
  if (token) return token;
  await refillTokens();
  return takeToken(kind);
}

// some minutes from now, so getting tokens and spending them don't line up
function refillLater() {
  setTimeout(() => refillTokens(), (1 + Math.random() * 4) * 60 * 1000).unref?.();
}
refillLater();

// A username's public key → string, null (none yet) or undefined (no such user).
// It has to be in the public key log, and the log has to have only grown since
// this app last looked (see public/kt.js); otherwise it throws.
async function publicKeyOf(username) {
  const out = await cloudFetch(`/api/keys?username=${encodeURIComponent(username)}`);
  if (out.status === 404) return undefined;
  const pub = out.body.publicKey || null;
  if (!pub) return null;
  const { checkKey } = await lib();
  const consistency = async (from, to) => (await cloudFetch(`/api/transparency?from=${from}&to=${to}`)).body.path || [];
  const logged = await checkKey(username, pub, out.body.transparency, settings.get('ktHead') || null, consistency);
  if (!logged.ok) throw new Error(`Couldn’t confirm @${username}’s key in the public key log, so nothing was sent. ${logged.reason}`);
  settings.set('ktHead', logged.head);
  return pub;
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
// A share locked end to end opens with its key: the one kept for it here, or
// the one the app's page has (keyB64).
function cloudCopy(shortId, token, keyB64 = null) {
  const cached = loadCopies()[shortId];
  if (cached) return Promise.resolve(cached);
  if (uploading.has(shortId)) return uploading.get(shortId);

  const job = (async () => {
    const generation = copiesGeneration;
    const file = db.prepare('SELECT * FROM files WHERE short_id = ? AND is_active = 1').get(shortId);
    if (!file || !file.stored_filename || (file.expires_at && file.expires_at <= new Date().toISOString())) {
      return { status: 404, error: 'File not found' };
    }
    const opened = await require('./files').openShare(file, keyB64);
    if (!opened) return { status: 409, error: 'Open this share in the app to send it.' };
    const name = opened.name || 'file';
    const mime = opened.type || 'application/octet-stream';
    let bytes;
    try {
      bytes = readShare(file);
      if (opened.key) bytes = Buffer.from(await (await lib()).unlockFile(opened.key, new Uint8Array(bytes)));
    } catch { return { status: 500, error: 'Couldn’t read the file.' }; }

    // sealed here: a fresh key, the file padded and locked with it, and the
    // name and type locked too
    const { newFileKey, lockFile, lockMeta, sealKey, nameFor, isAllowedType, toB64url, MAX_FILE } = await lib();
    if (!isAllowedType(mime)) return { status: 415, error: 'That kind of file can’t be sent.' };
    // sending goes through the website, which takes 10 MB; bigger files are link-only
    if (bytes.length > MAX_FILE) return { status: 413, error: 'Files over 10 MB can’t be sent to usernames. Share the link instead.' };
    const key = newFileKey();
    const form = new FormData();
    form.append('file', new Blob([await lockFile(key, new Uint8Array(bytes))]), 'sealed.bin');
    form.append('e2e', '1');
    form.append('meta', await lockMeta(key, { name: nameFor(name, '', mime), type: mime }));
    // sealed to the linked account too, so it shows in Your shares on the website
    const ownKey = await publicKeyOf(settings.get('cloudUsername') || '').catch(() => null);
    if (ownKey) form.append('owner_key', await sealKey(ownKey, key));
    // the website's copy lasts as long as the share here, up to the website's
    // 10 days (a share here that never expires gets the full 10)
    const hoursLeft = file.expires_at ? (new Date(file.expires_at).getTime() - Date.now()) / 3600000 : 240;
    form.append('expires_hours', String(Math.min(Math.max(hoursLeft, 1 / 60), 240)));
    form.append('allow_download', file.allow_download ? '1' : '0');
    form.append('allow_annotations', file.allow_annotations ? '1' : '0');
    // it's only ever for the people it's sent to, who are signed in
    form.append('require_account', '1');

    // an anonymous token, never the account's sign-in, so the upload can't be
    // tied to the account; one refused (it ran out at midnight) is swapped once
    const upload = anon => cloudFetch('/api/upload', { method: 'POST', headers: { 'X-ShareSecure-Token': anon }, body: form });
    let anon = await anonToken('upload');
    if (!anon && !cloudToken()) return { status: 401, error: 'link_expired' };
    if (!anon) return { status: 429, error: 'Your ShareSecure account has reached today’s upload limit. Try again tomorrow.' };
    let { status: code, body } = await upload(anon);
    if (code === 401 && (anon = await anonToken('upload'))) ({ status: code, body } = await upload(anon));
    refillLater();
    if (code === 401) return { status: 429, error: 'Your ShareSecure account has reached today’s upload limit. Try again tomorrow.' };
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
async function sendOne(shortId, username, note, keyB64 = null) {
  const token = cloudToken();
  if (!token) return { status: 409, body: { error: 'link_account' } };

  for (let attempt = 0; attempt < 2; attempt++) {
    const copy = await cloudCopy(shortId, token, keyB64);
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
      // anonymous, never the sign-in: the delete key proves the copy is ours
      anon = await anonToken('send');
      if (!anon && !cloudToken()) return { status: 401, body: { error: 'link_expired' } };
      if (!anon) return { status: 429, body: { error: 'Your ShareSecure account has sent as many files as it can today. Try again tomorrow.' } };
    }
    const send = headers => cloudFetch(`/api/send/${encodeURIComponent(copy.id)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(request),
    });
    let { status: code, body } = await send(anon ? { 'X-ShareSecure-Token': anon } : { Authorization: `Bearer ${token}` });
    if (anon && code === 401 && (anon = await anonToken('send'))) ({ status: code, body } = await send({ 'X-ShareSecure-Token': anon }));
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
// The copy was just uploaded anonymously, so the box (posted signed in) goes
// a few minutes later: straight away, the timing would tie the two together.
async function holdForApproval(shortId, username, note, token) {
  const copy = await cloudCopy(shortId, token);
  if (copy.error) return { status: copy.status, body: { error: copy.error } };
  const later = (1 + Math.random() * 4) * 60 * 1000;
  setTimeout(() => {
    postHold(copy, username, note, cloudToken() || token)
      .then(out => { if (out.status !== 202) console.error('  [cloud] A send waiting for approval couldn’t be kept:', out.body.error); })
      .catch(() => console.error('  [cloud] A send waiting for approval couldn’t be kept.'));
  }, later).unref?.();
  return { status: 202, body: { waiting: true } };
}

async function postHold(copy, username, note, token) {
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

// Sends a share on this computer to usernames, for the assistant tools. Never throws.
// → { sent_to, waiting_for_approval, not_sent: [{ username, reason }], error? }
// error ('link_account' or 'link_expired') means no one was sent it.
async function sendToCloud(shortId, usernames, note = '') {
  const names = (await lib()).toRecipients(usernames);
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
    } catch (err) { out = { status: 502, body: { error: /key log/.test(err?.message) ? err.message : 'Couldn’t reach ShareSecure.' } }; }
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

// Deletes the website's copy of a share, if any, so people it was sent to lose
// it too. Best effort; call it when a share here is deleted.
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
// account's sign-in has expired. The sign-in is never sent with it: that would
// tell the website whose anonymous copy this was. (token is only kept for
// copies from before the delete key was saved.)
async function deleteCopy(copy, token) {
  try {
    await cloudFetch(`/api/delete/${encodeURIComponent(copy.id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(!copy.deleteToken && token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ deleteToken: copy.deleteToken }),
    });
  } catch { /* it still expires with the share */ }
}

// Deletes every copy on the website when the account is unlinked or swapped, or
// the owner here is deleted, since nothing here would remember them afterwards.
// Best effort.
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
const opaquePost = async () => {
  const { postWith } = await import('../../public/opaque.js');
  return postWith((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(120000) }), cloud());
};
const newKeysFor = async exportKey => {
  const { makeKeyPair, lockPrivateKey } = await import('../../public/sealed.js');
  const pair = await makeKeyPair();
  return { public_key: pair.publicKey, private_key_box: await lockPrivateKey(pair.privateKey, exportKey) };
};

// → { status, body } with the same answers as POST /cloud/link
async function link(username, accessCode) {
  // The website never sees the password: this computer proves it the same way
  // a browser does (OPAQUE, public/opaque.js). Older accounts send it once to
  // switch over, and make their end-to-end keys while they're at it.
  let out;
  try {
    const { signIn } = await import('../../public/opaque.js');
    out = await signIn(await opaquePost(), username, accessCode, newKeysFor);
  } catch (err) {
    if (err.status === 429) return { status: 429, body: { error: err.message || 'Too many tries. Wait a few minutes and try again.' } };
    if (err.status === 401 || err.status === 400 || err.status === 404) return { status: 403, body: { error: 'Wrong username or password.' } };
    return { status: 502, body: { error: 'Couldn’t reach ShareSecure. Check your connection and try again.' } };
  }
  if (!out?.token) return { status: 403, body: { error: 'Wrong username or password.' } };

  // copies made with a different account are taken back; the same account's stay
  const newName = out.username || username;
  const oldName = settings.get('cloudUsername');
  if (oldName && oldName.toLowerCase() !== newName.toLowerCase()) {
    forgetAllCloudCopies().catch(() => {});
    settings.set('cloudImported', null);
  }
  settings.set('cloudToken', encryptString(out.token, getEncKey()));
  settings.set('cloudUsername', newName);
  settings.set('cloudKey', null);
  await keepAccountKey(out, out.token).catch(() => {});
  saveTokens([]);   // tokens belong to the account that got them
  refillLater();
  syncInbox().catch(() => {});
  return { status: 200, body: status() };
}

router.post('/cloud/link', requireOwner, async (req, res) => {
  const username = String(req.body?.username || '').trim().replace(/^@/, '');
  const accessCode = String(req.body?.access_code || '');
  if (!username || !accessCode) return res.status(400).json({ error: 'Enter your username and password.' });
  // choosing an account by hand settles it: signing in here won't change it
  settings.set('cloudAuto', 'off');
  const out = await link(username, accessCode);
  res.status(out.status).json(out.body);
});

// ── owner: an account to match, made or linked when you sign in here ─────────
// The desktop app sends the owner's username and password after setting up or
// signing in. If the website has no such account yet, it's made (OPAQUE, from
// here, with its own key pair); if it has one with that password, it's linked.
// Nothing happens once you've linked another account or unlinked, or when the
// username belongs to someone else.
router.post('/cloud/auto', requireOwner, async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const accessCode = String(req.body?.access_code || '');
  const linkedName = settings.get('cloudUsername');
  if (!username || !accessCode || settings.get('cloudToken') || settings.get('cloudAuto') === 'off'
    || (linkedName && linkedName.toLowerCase() !== username.toLowerCase())) {
    return res.json(status());
  }
  let out = await link(username, accessCode);
  if (out.status === 403) {
    try {
      const { register } = await import('../../public/opaque.js');
      await register(await opaquePost(), username, accessCode, newKeysFor);
    } catch (err) {
      if (err.status === 429 || !err.status || err.status >= 500) return res.status(502).json({ error: 'Couldn’t reach ShareSecure. Try again later.' });
      // taken by someone else, or a username the website doesn't allow
      settings.set('cloudAuto', 'off');
      return res.json({ ...status(), auto: 'unavailable' });
    }
    out = await link(username, accessCode);
  }
  res.status(out.status).json(out.status === 200 ? { ...out.body, auto: 'linked' } : out.body);
});

// ── owner: unlink ─────────────────────────────────────────────────────────────
// Files already sent from here are taken back from the people who got them,
// since nothing here could reach them afterwards.
router.delete('/cloud', requireOwner, (_req, res) => {
  forgetAllCloudCopies().catch(() => {});
  settings.set('cloudToken', null);
  settings.set('cloudUsername', null);
  settings.set('cloudKey', null);
  settings.set('cloudImported', null);
  // and it stays unlinked: signing in here doesn't link it again
  settings.set('cloudAuto', 'off');
  cloudPending = [];
  saveTokens([]);
  res.json(status());
});

// ── files sent to your username ───────────────────────────────────────────────
// They wait in the account's inbox on the website. Here they show in this
// computer's inbox (routes/inbox.js): waiting ones to accept or decline, and
// once accepted, each is fetched, opened with the account's key and kept on
// this computer like a file sent here, with the sender's choices (view only,
// watermark…), so it opens in this app's own viewer.
let cloudPending = [];   // [{ row, opened }] waiting on the website
let notifiedOnce = false; // the first sync only learns what's already waiting
let lastSync = 0;
let syncing = null;

// cloud short id → this computer's short id, for files already brought here
function loadImported() {
  try { return JSON.parse(decryptString(settings.get('cloudImported'), getEncKey())) || {}; } catch { return {}; }
}
function saveImported(map) {
  settings.set('cloudImported', Object.keys(map).length ? encryptString(JSON.stringify(map), getEncKey()) : null);
}

// A row from the website's inbox, opened: its file key, name, type and note.
async function openCloudRow(row, key) {
  const { openKey, unlockMeta, unlockText } = await lib();
  if (!row.e2e) return { fileKey: null, name: row.original_filename || 'file', type: row.mime_type || '', note: row.note || null };
  const sealed = await openKey(key, row.inbox_key);
  const fileKey = sealed.length === 64 ? sealed.subarray(32) : sealed;
  const meta = await unlockMeta(fileKey, row.original_filename);
  const note = row.note ? await unlockText(fileKey, row.note, 'note').catch(() => null) : null;
  return { fileKey, ...meta, note };
}

// Brings an accepted file to this computer → its short id here, or null
async function importRow(row, opened, token) {
  const auth = { Authorization: `Bearer ${token}` };
  const info = await cloudFetch(`/api/info/${encodeURIComponent(row.short_id)}`, { headers: auth });
  if (info.status !== 200) return null;
  // a link that works once would be erased by fetching it: it stays on the website
  if (info.body.burnAfterReading) return 'website';
  const res = await fetch(`${cloud()}/api/raw/${encodeURIComponent(row.short_id)}`, { headers: auth, signal: AbortSignal.timeout(120000) });
  if (!res.ok) return null;
  let bytes = new Uint8Array(await res.arrayBuffer());
  if (opened.fileKey) bytes = await (await lib()).unlockFile(opened.fileKey, bytes);

  const { storeFile } = require('./files');
  const hours = Math.max(1 / 60, (new Date(row.expires_at).getTime() - Date.now()) / 3600000);
  const stored = await storeFile(
    { buffer: Buffer.from(bytes), originalname: opened.name, mimetype: opened.type, size: bytes.length },
    { display_name: opened.name, expires_hours: String(hours), allow_download: info.body.allowDownload ? '1' : '0', allow_annotations: '0' },
    { incoming: true, note: opened.note }
  );
  if (stored.error) return null;
  const view = opened.fileKey ? { watermark: opened.watermark, discourage: opened.discourage } : (info.body.viewOpts || {});
  db.prepare("UPDATE files SET is_active = 1, inbox_status = 'accepted', expires_at = ?, view_opts = ? WHERE short_id = ?").run(
    row.expires_at, view.watermark || view.discourage
      ? encryptString(JSON.stringify({ watermark: Boolean(view.watermark), discourage: Boolean(view.discourage) }), getEncKey()) : null,
    stored.shortId
  );
  return stored.shortId;
}

async function syncInbox() {
  const token = cloudToken();
  const key = token && await accountKey();
  if (!key) { cloudPending = []; return; }
  const res = await cloudFetch('/api/inbox', { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) { forgetToken(); cloudPending = []; return; }
  if (res.status !== 200) return;
  const rows = res.body.files || [];
  const imported = loadImported();
  const pending = [];
  for (const row of rows) {
    if (imported[row.short_id]) continue;
    const opened = await openCloudRow(row, key).catch(() => null);
    if (!opened) continue;
    if (row.status === 'pending') { pending.push({ row, opened }); continue; }
    const here = await importRow(row, opened, token).catch(() => null);
    if (here) imported[row.short_id] = here;
  }
  // forget the ones that have gone from the website (expired or deleted)
  const live = new Set(rows.map(r => r.short_id));
  for (const id of Object.keys(imported)) if (!live.has(id)) delete imported[id];
  saveImported(imported);
  const known = new Set(cloudPending.map(p => p.row.short_id));
  if (pending.some(p => !known.has(p.row.short_id)) && notifiedOnce) events.emit('received', {});
  notifiedOnce = true;
  cloudPending = pending;
}

// at most every 20 seconds; the inbox list waits a little for it
function syncSoon() {
  if (!syncing && Date.now() - lastSync > 20 * 1000) {
    lastSync = Date.now();
    syncing = syncInbox().catch(() => {}).finally(() => { syncing = null; });
  }
  return syncing || Promise.resolve();
}

// for the inbox list: waiting files from the website, shaped like the ones here
const CLOUD_PREFIX = 'cloud-';
const pendingFromCloud = () => cloudPending.map(({ row, opened }) => ({
  short_id: CLOUD_PREFIX + row.short_id,
  original_filename: opened.name,
  mime_type: opened.type,
  size_bytes: row.size_bytes,
  expires_at: row.expires_at,
  status: 'pending',
  note: opened.note,
  delete_token: null,
}));

// accept or decline one → { status, body }
async function answerCloud(id, action) {
  const cloudId = id.slice(CLOUD_PREFIX.length);
  const token = cloudToken();
  const waiting = cloudPending.find(p => p.row.short_id === cloudId);
  if (!token || !waiting) return { status: 404, body: { error: 'Request not found' } };
  const out = await cloudFetch(`/api/inbox/${encodeURIComponent(cloudId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action }),
  });
  if (out.status !== 200) return out;
  cloudPending = cloudPending.filter(p => p !== waiting);
  if (action === 'accept') {
    const here = await importRow({ ...waiting.row, status: 'accepted' }, waiting.opened, token).catch(() => null);
    if (here) saveImported({ ...loadImported(), [cloudId]: here });
  }
  return out;
}

// ── owner: send a share to a username ─────────────────────────────────────────
// Same answers as the website's /api/send, plus 409 link_account and 401 link_expired.
router.post('/send/:shortId', requireOwner, async (req, res) => {
  const username = String(req.body?.targetUsername || '').trim().replace(/^@/, '');
  if (!username) return res.status(400).json({ error: 'targetUsername required' });
  const note = String(req.body?.note || '').trim().slice(0, NOTE_MAX);
  try {
    // a share locked in the app's page comes with its key (only ever to this computer)
    const keyB64 = /^[A-Za-z0-9_-]{43}$/.test(String(req.body?.file_key || '')) ? String(req.body.file_key) : null;
    const out = await sendOne(req.params.shortId, username, note, keyB64);
    res.status(out.status).json(out.body);
  } catch (err) {
    // a key the public log can't confirm is a reason worth showing as it is
    res.status(502).json({ error: /key log/.test(err?.message) ? err.message : 'Couldn’t reach ShareSecure. Check your connection and try again.' });
  }
});

module.exports = router;
module.exports.sendToCloud = sendToCloud;
module.exports.forgetCloudCopy = forgetCloudCopy;
module.exports.forgetAllCloudCopies = forgetAllCloudCopies;
module.exports.refillTokens = refillTokens;
module.exports.syncSoon = syncSoon;
module.exports.pendingFromCloud = pendingFromCloud;
module.exports.answerCloud = answerCloud;
module.exports.CLOUD_PREFIX = CLOUD_PREFIX;
// for tests
module.exports.sendOne = sendOne;
module.exports.noPauses = () => { pause = async () => {}; };
