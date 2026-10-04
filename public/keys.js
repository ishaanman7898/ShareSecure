// Your end-to-end encryption keys in this browser, and the keys of people you
// send to.
//
// When you sign in, your private key is unlocked with the export key that
// signing in produces (see opaque.js) and kept in IndexedDB as a key the
// browser can use but never read out, not even for this site's own code. It's
// deleted when you sign out. The server only ever holds it locked.
//
// The first time you send to someone, their public key is remembered here. If
// the server ever hands out a different key for them, sending stops and you're
// told to compare security codes with them, because a swapped key is how a
// compromised server would try to read files meant for someone else.
//
// Every key is also checked against the public key log (see kt.js): it has to
// be in the log, and the log has to have only grown since this browser last
// looked. A key the server made up for someone would have to be published
// there for everyone to see.
import {
  makeKeyPair, lockPrivateKey, unlockPrivateKey, openKey, sealKey, unlockMeta, linkWithKey, fingerprint, join
} from './sealed.js';
import { checkKey } from './kt.js';

const DB_NAME = 'sharesecure';
const STORE = 'keys';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(mode, run) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = run(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(req?.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// { username, publicKey, privateKey } for whoever is signed in here, or null.
export async function myKeys() {
  try { return (await store('readonly', s => s.get('me'))) || null; } catch { return null; }
}

export async function forgetKeys() {
  try { await store('readwrite', s => s.delete('me')); } catch {}
}

// A new key pair for an account, its private half locked with the export key.
// → the fields the server saves with the account
export async function newKeyFields(exportKey) {
  const pair = await makeKeyPair();
  return { public_key: pair.publicKey, private_key_box: await lockPrivateKey(pair.privateKey, exportKey) };
}

// Right after signing in: unlock the account's private key, or make the
// account's key pair if it has none yet. Returns true when keys are ready.
export async function setUpKeys({ token, username, exportKey, publicKey, privateKeyBox }) {
  try {
    let pub = publicKey, box = privateKeyBox;
    if (!box) {
      const fields = await newKeyFields(exportKey);
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(fields),
      });
      if (!res.ok) return false;
      pub = fields.public_key;
      box = fields.private_key_box;
    }
    const privateKey = await unlockPrivateKey(box, exportKey);
    await store('readwrite', s => s.put({ username, publicKey: pub, privateKey }, 'me'));
    return true;
  } catch {
    return false;
  }
}

// ── people you send to ───────────────────────────────────────────────────────

const contactsKey = me => `ss_contacts:${String(me || '').toLowerCase()}`;
function contacts(me) {
  try { return JSON.parse(localStorage.getItem(contactsKey(me)) || '{}'); } catch { return {}; }
}
function rememberContact(me, username, publicKey) {
  const all = contacts(me);
  all[username.toLowerCase()] = publicKey;
  try { localStorage.setItem(contactsKey(me), JSON.stringify(all)); } catch {}
}

// Accept a contact's new key, after checking their security code with them.
export async function trustNewKey(username) {
  const me = await myKeys();
  const res = await fetch(`/api/keys?username=${encodeURIComponent(username)}`);
  const pub = res.ok ? (await res.json()).publicKey : null;
  if (pub) rememberContact(me?.username, username, pub);
}

// ── the public key log ───────────────────────────────────────────────────────
// The biggest log this browser has seen, so the next one can be checked to be
// the same log, grown.
const HEAD_KEY = 'ss_kt_head';
function knownHead() {
  try { return JSON.parse(localStorage.getItem(HEAD_KEY) || 'null'); } catch { return null; }
}
async function fetchConsistency(from, to) {
  const res = await fetch(`/api/transparency?from=${from}&to=${to}`);
  if (!res.ok) throw new Error('Couldn’t check the public key log.');
  return (await res.json()).path || [];
}
// → { ok, reason }. On success, remembers the log it was checked against.
export async function checkLogged(username, publicKey, proof) {
  let checked;
  try { checked = await checkKey(username, publicKey, proof, knownHead(), fetchConsistency); } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (checked.ok) { try { localStorage.setItem(HEAD_KEY, JSON.stringify(checked.head)); } catch {} }
  return checked;
}

// Someone's public key, checked against the one remembered for them.
// → { publicKey, code } | null if they have no key yet | undefined if no such
// user. Throws when the key changed.
export async function publicKeyFor(username) {
  const res = await fetch(`/api/keys?username=${encodeURIComponent(username)}`);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error('Couldn’t look up their key.');
  const data = await res.json();
  const pub = data.publicKey;
  if (!pub) return null;
  const logged = await checkLogged(username, pub, data.transparency);
  if (!logged.ok) {
    throw Object.assign(new Error(`Couldn’t confirm @${username}’s key in the public key log, so nothing was sent. ${logged.reason}`), { code: 'key_log', username });
  }
  const me = await myKeys();
  const known = contacts(me?.username)[username.toLowerCase()];
  const code = await fingerprint(pub);
  if (known && known !== pub) {
    throw Object.assign(new Error(`@${username}’s security code has changed, so nothing was sent. Check their code with them (account menu → Security code), then send again.`), { code: 'key_changed', username });
  }
  if (!known) rememberContact(me?.username, username, pub);
  return { publicKey: pub, code };
}

// The file key sealed to them → string, null (no key yet), undefined (no user)
export async function sealFor(username, fileKey) {
  const found = await publicKeyFor(username);
  return found ? sealKey(found.publicKey, fileKey) : found;
}

// My own security code, to read out to people.
export async function myCode() {
  const me = await myKeys();
  return me?.publicKey ? fingerprint(me.publicKey) : null;
}

// ── opening rows from the server ─────────────────────────────────────────────

// For your own shares: the link's key and the file's full key (they differ
// when the link needs a passcode), sealed to you together.
export const ownerKeys = (linkKey, fileKey) => linkKey && fileKey && linkKey !== fileKey ? join(linkKey, fileKey) : fileKey;

// An end-to-end encrypted row from the server (Your shares or the inbox) →
// its keys, name, type and link. null when this browser can't open it.
export async function openRow(row, sealedKey) {
  const me = await myKeys();
  if (!me || !sealedKey) return null;
  try {
    const opened = await openKey(me.privateKey, sealedKey);
    const linkKey = opened.length === 64 ? opened.subarray(0, 32) : opened;
    const key = opened.length === 64 ? opened.subarray(32) : opened;
    const meta = await unlockMeta(key, row.original_filename);
    // your own share's link is its normal one; a copy sent to you opens with the full key
    const base = `${location.origin}/r/${row.short_id}`;
    const url = row.inbox_key ? linkWithKey(base, key, 'f') : linkWithKey(base, linkKey, 'k');
    return { key, linkKey, ...meta, url };
  } catch {
    return null;
  }
}
