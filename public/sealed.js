// End-to-end encryption ("sealed" files), with only WebCrypto, so it runs in
// the browser, on Cloudflare and in Node 20+.
//
//   - Each file gets a random key. The file (padded), its name and type are
//     encrypted with it (AES-256-GCM), and the key goes in the link after "#",
//     which browsers never send to a server.
//   - With a passcode, the link holds only half the key.
//   - Sending to a username seals the key to their public key (ECDH P-256 +
//     HKDF + AES-GCM).
//   - Each account's private key is stored locked with a key that only comes
//     out of signing in (see opaque.js).

const subtle = globalThis.crypto.subtle;
const utf8 = new TextEncoder();

// Text that starts with this is sealed, so code can tell it apart from plain text.
export const SEALED = 'e2e:';

// The version byte at the start of every box, so the format can change later.
const VERSION = 1;
// What a box adds to what's inside it: version, nonce and tag.
export const BOX_OVERHEAD = 1 + 12 + 16;

// ── bytes ↔ text ─────────────────────────────────────────────────────────────

export function toB64url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof arr.toBase64 === 'function') return arr.toBase64({ alphabet: 'base64url', omitPadding: true });
  let bin = '';
  for (let i = 0; i < arr.length; i += 8192) bin += String.fromCharCode(...arr.subarray(i, i + 8192));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(text) {
  const s = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const padded = s + '='.repeat((4 - s.length % 4) % 4);
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(padded);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function join(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export const randomBytes = n => globalThis.crypto.getRandomValues(new Uint8Array(n));

// ── file keys and links ──────────────────────────────────────────────────────
// A link ends in "#k=<key>" (the link's own key, which may still need a
// passcode) or "#f=<key>" (the file's full key, used for copies sent to a
// username, which never need the passcode).

export const newFileKey = () => randomBytes(32);

export function linkWithKey(url, key, kind = 'k') {
  return `${String(url).split('#')[0]}#${kind}=${toB64url(key)}`;
}

// { key, full } from a link (or just its "#…" part), or null.
export function readLink(text) {
  const m = /#([kf])=([A-Za-z0-9_-]{43})(?:&|$)/.exec(String(text || ''));
  if (!m) return null;
  const key = fromB64url(m[2]);
  return key.length === 32 ? { key, full: m[1] === 'f' } : null;
}

export const keyFromLink = text => readLink(text)?.key || null;

// ── passcodes ────────────────────────────────────────────────────────────────
// The file key = HKDF(link key + stretched passcode). The passcode is
// stretched with 600,000 rounds of PBKDF2, so guessing it is slow even for
// someone who has the link.

export const newPasscodeSalt = () => toB64url(randomBytes(16));

export async function passcodeKey(linkKey, passcode, salt) {
  const base = await subtle.importKey('raw', utf8.encode(String(passcode)), 'PBKDF2', false, ['deriveBits']);
  const stretched = new Uint8Array(await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64url(salt), iterations: 600000 }, base, 256));
  const ikm = await subtle.importKey('raw', join(linkKey, stretched), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: fromB64url(salt), info: utf8.encode('sharesecure passcode v1') }, ikm, 256));
}

// ── locking bytes with a file key ────────────────────────────────────────────
// A box is [version][12-byte nonce][ciphertext + tag]. The label says what the
// box holds ("file", "meta", "note", "drawing"), so a box can't be swapped into
// another slot without failing to open.

async function aesKey(raw) {
  return subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function lock(key, bytes, label) {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8.encode(label) },
    key instanceof CryptoKey ? key : await aesKey(key),
    bytes
  );
  return join(new Uint8Array([VERSION]), iv, new Uint8Array(ct));
}

export async function unlock(key, box, label) {
  const b = box instanceof Uint8Array ? box : new Uint8Array(box);
  if (b[0] !== VERSION || b.length < BOX_OVERHEAD) throw new Error('Not a sealed box');
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: b.subarray(1, 13), additionalData: utf8.encode(label) },
    key instanceof CryptoKey ? key : await aesKey(key),
    b.subarray(13)
  );
  return new Uint8Array(pt);
}

// ── files, padded so their size gives little away ────────────────────────────
// Inside the box: [4-byte length][the file][zeros], rounded up to the next
// standard size (1 KB, 2 KB, 4 KB … 8 MB, then 10 MB). The server only learns
// which size bucket a file falls in.

export const MAX_FILE = 10 * 1024 * 1024;
export const MAX_SEALED_FILE = MAX_FILE + 4 + BOX_OVERHEAD;

export function paddedSize(length) {
  const need = length + 4;
  for (let size = 1024; size <= 8 * 1024 * 1024; size *= 2) if (need <= size) return size;
  return MAX_FILE + 4;
}

export async function lockFile(key, bytes) {
  if (bytes.length > MAX_FILE) throw new Error('File too large');
  const padded = new Uint8Array(paddedSize(bytes.length));
  new DataView(padded.buffer).setUint32(0, bytes.length);
  padded.set(bytes, 4);
  return lock(key, padded, 'file');
}

export async function unlockFile(key, box) {
  const padded = await unlock(key, box, 'file');
  const length = new DataView(padded.buffer, padded.byteOffset, 4).getUint32(0);
  if (length > padded.length - 4) throw new Error('Bad padding');
  return padded.subarray(4, 4 + length);
}

// ── short text ───────────────────────────────────────────────────────────────

export async function lockText(key, text, label) {
  return SEALED + toB64url(await lock(key, utf8.encode(String(text)), label));
}

export async function unlockText(key, sealed, label) {
  if (!isSealed(sealed)) throw new Error('Not sealed text');
  return new TextDecoder().decode(await unlock(key, fromB64url(sealed.slice(SEALED.length)), label));
}

export function isSealed(text) {
  return typeof text === 'string' && text.startsWith(SEALED);
}

// The name and type of a sealed file travel together in one box.
export const lockMeta = (key, { name, type }) => lockText(key, JSON.stringify({ name, type }), 'meta');
export async function unlockMeta(key, sealed) {
  const meta = JSON.parse(await unlockText(key, sealed, 'meta'));
  return { name: String(meta.name || 'file'), type: String(meta.type || '') };
}

// ── account key pairs ────────────────────────────────────────────────────────
// Public keys are passed around as base64url of the raw 65-byte P-256 point.

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

export async function makeKeyPair() {
  const pair = await subtle.generateKey(ECDH, true, ['deriveBits']);
  return { publicKey: toB64url(await subtle.exportKey('raw', pair.publicKey)), privateKey: pair.privateKey };
}

export function isPublicKey(text) {
  return typeof text === 'string' && /^[A-Za-z0-9_-]{87}$/.test(text) && fromB64url(text)[0] === 4;
}

// A short code for a public key that two people can read to each other to
// check nobody swapped it: 30 digits in six groups of five.
export async function fingerprint(publicKey) {
  const hash = new Uint8Array(await subtle.digest('SHA-256', join(utf8.encode('sharesecure key v1'), fromB64url(publicKey))));
  const groups = [];
  for (let i = 0; i < 6; i++) {
    const n = ((hash[i * 5] << 24) | (hash[i * 5 + 1] << 16) | (hash[i * 5 + 2] << 8) | hash[i * 5 + 3]) >>> 0;
    groups.push(String((n * 256 + hash[i * 5 + 4]) % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}

// AES key both sides can make from the ECDH secret and the one-time public key.
async function sealingKey(secret, ephemeralRaw) {
  const base = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: ephemeralRaw, info: utf8.encode('sharesecure seal v1') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

// Seal a file key so only the owner of publicKey can open it. A fresh one-time
// key pair is made each time, so two seals of the same key look unrelated and
// nothing in the box says who sealed it. (A share's owner gets 64 bytes: the
// link's key and the file's full key, for links that also need a passcode.)
export async function sealKey(publicKey, fileKey) {
  const theirs = await subtle.importKey('raw', fromB64url(publicKey), ECDH, false, []);
  const once = await subtle.generateKey(ECDH, true, ['deriveBits']);
  const onceRaw = new Uint8Array(await subtle.exportKey('raw', once.publicKey));
  const secret = await subtle.deriveBits({ name: 'ECDH', public: theirs }, once.privateKey, 256);
  const box = await lock(await sealingKey(secret, onceRaw), fileKey, 'seal');
  return SEALED + toB64url(join(onceRaw, box));
}

export async function openKey(privateKey, sealed) {
  if (!isSealed(sealed)) throw new Error('Not a sealed key');
  const bytes = fromB64url(sealed.slice(SEALED.length));
  const onceRaw = bytes.subarray(0, 65);
  const once = await subtle.importKey('raw', onceRaw, ECDH, false, []);
  const secret = await subtle.deriveBits({ name: 'ECDH', public: once }, privateKey, 256);
  const key = await unlock(await sealingKey(secret, onceRaw), bytes.subarray(65), 'seal');
  if (key.length !== 32 && key.length !== 64) throw new Error('Bad sealed key');
  return key;
}

// Text only the owner of publicKey can read, for things kept on the server for
// that person alone (their list of shares, their assistant's waiting sends):
// a fresh key sealed to them, and the text locked with it. → "e2e:…|e2e:…"
export async function sealText(publicKey, text, label) {
  const key = newFileKey();
  return `${await sealKey(publicKey, key)}|${await lockText(key, text, label)}`;
}

export async function openText(privateKey, box, label) {
  const [sealed, locked] = String(box || '').split('|');
  return unlockText(await openKey(privateKey, sealed), locked, label);
}

// ── keeping a private key locked ─────────────────────────────────────────────
// Locked with the "export key" that signing in produces in the browser (see
// opaque.js). The server never sees the password or the export key.

async function exportWrapKey(exportKey) {
  const base = await subtle.importKey('raw', exportKey, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: utf8.encode('sharesecure private key v2') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

export async function lockPrivateKey(privateKey, exportKey) {
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', privateKey));
  return SEALED + toB64url(await lock(await exportWrapKey(exportKey), pkcs8, 'private key v2'));
}

// The private key's PKCS#8 bytes. Only the local MCP server wants these, to
// keep the key on the user's own computer after they link it once.
export async function unlockPrivateKeyBytes(sealed, exportKey) {
  if (!isSealed(sealed)) throw new Error('Not a locked key');
  return unlock(await exportWrapKey(exportKey), fromB64url(sealed.slice(SEALED.length)), 'private key v2');
}

// Gives back a private key that can be used but never read out again.
export async function unlockPrivateKey(sealed, exportKey) {
  return importPrivateKey(await unlockPrivateKeyBytes(sealed, exportKey));
}

export const importPrivateKey = pkcs8 => subtle.importKey('pkcs8', pkcs8, ECDH, false, ['deriveBits']);
