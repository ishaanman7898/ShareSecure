// Password sign-in where the server never sees the password (OPAQUE).
//
// This follows the design of RFC 9807 (OPAQUE-3DH) on P-256. In plain words:
//
//   - The browser "blinds" the password (hashes it onto the curve and
//     multiplies it by a random number) and sends that. The server multiplies
//     it by a secret of its own and sends it back. The browser removes its
//     random number, and is left with a value only someone who knows both the
//     password and the server's secret could make. The server learns nothing
//     about the password, and someone with a copy of the database can't test
//     guesses without the server's help.
//   - That value unlocks a small "envelope" the browser made when the account
//     was created. It holds the account's sign-in key pair, and an "export key"
//     that locks the account's end-to-end private key.
//   - Both sides then do a three-way Diffie-Hellman handshake and prove to each
//     other they got the same keys. The server learns the password was right
//     without ever having it; the browser learns it's talking to the real server.
//
// The server side (functions/_opaque.js) only uses WebCrypto's ECDH, HKDF and
// HMAC. This file's curve maths (p256.js) only ever runs in the browser.
//
// Differences from the RFC, kept on purpose: points are sent uncompressed
// (65 bytes, as WebCrypto uses them) and Diffie-Hellman outputs are the shared
// x-coordinate (what WebCrypto's ECDH gives). The key stretching step is
// PBKDF2-SHA256 with 600,000 rounds, since browsers have no Argon2.

import { hashToCurve, multiply, invMod, n, liftX, bytesToBig, bigToBytes, encodePoint, multiplyBase, randomScalar } from './p256.js';
import { toB64url, fromB64url, join, randomBytes } from './sealed.js';

const subtle = globalThis.crypto.subtle;
const utf8 = new TextEncoder();
const CONTEXT = 'ShareSecure OPAQUE v1';
const DST = 'ShareSecure-OPRF-P256_XMD:SHA-256_SSWU_RO_';
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

// ── small building blocks (shared with the server) ───────────────────────────

const lenPrefixed = bytes => join(new Uint8Array([bytes.length >> 8, bytes.length & 255]), bytes);
export const sha256 = async bytes => new Uint8Array(await subtle.digest('SHA-256', bytes));

export async function hmac(key, data) {
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, data));
}

export async function hkdfExtract(salt, ikm) {
  return hmac(salt.length ? salt : new Uint8Array(32), ikm);
}

// HKDF-Expand (RFC 5869) with SHA-256
export async function hkdfExpand(prk, info, length) {
  const out = [];
  let prev = new Uint8Array(0);
  for (let i = 1; out.length * 32 < length; i++) {
    prev = await hmac(prk, join(prev, typeof info === 'string' ? utf8.encode(info) : info, new Uint8Array([i])));
    out.push(prev);
  }
  return join(...out).subarray(0, length);
}

export function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export const xor = (a, b) => a.map((v, i) => v ^ b[i]);

// A username in the form both sides use for it.
export const credentialId = username => utf8.encode(String(username).trim().normalize('NFKC').toLowerCase());

// What's sealed in the envelope's tag: whose keys these are.
const cleartext = (serverPublic, clientPublic, username) =>
  join(serverPublic, clientPublic, lenPrefixed(credentialId(username)), lenPrefixed(utf8.encode('sharesecure')));

// The transcript both sides hash into the handshake.
export function preamble({ username, ke1, credentialResponse, serverNonce, serverEphemeral }) {
  return join(
    utf8.encode('OPAQUEv1-'), lenPrefixed(utf8.encode(CONTEXT)),
    lenPrefixed(credentialId(username)), ke1,
    lenPrefixed(utf8.encode('sharesecure')), credentialResponse, serverNonce, serverEphemeral
  );
}

// The keys both sides get from the three Diffie-Hellman results.
export async function keySchedule(dh, pre) {
  const prk = await hkdfExtract(new Uint8Array(0), join(...dh));
  const th = await sha256(pre);
  const handshake = await hkdfExpand(prk, join(utf8.encode('HandshakeSecret'), th), 32);
  const sessionKey = await hkdfExpand(prk, join(utf8.encode('SessionKey'), th), 32);
  const serverMac = await hmac(await hkdfExpand(handshake, 'ServerMAC', 32), th);
  const clientMac = await hmac(await hkdfExpand(handshake, 'ClientMAC', 32), await sha256(join(pre, serverMac)));
  return { serverMac, clientMac, sessionKey };
}

export const ecdh = async (privateKey, publicRaw) =>
  new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: await subtle.importKey('raw', publicRaw, ECDH, false, []) }, privateKey, 256));

// A P-256 private key from a number, as WebCrypto wants it (PKCS#8; WebCrypto
// works out the public half itself).
export function scalarToPkcs8(k) {
  const prefix = [0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20];
  return join(new Uint8Array(prefix), bigToBytes(k));
}

// 48 bytes of key material → a number from 1 to n-1 (RFC 9497's way)
export const toScalar = bytes => bytesToBig(bytes) % (n - 1n) + 1n;

// ── the browser's side ───────────────────────────────────────────────────────

async function blind(password) {
  const r = randomScalar();
  const P = await hashToCurve(utf8.encode(String(password)), DST);
  return { r, blinded: encodePoint(multiply(P, r)) };
}

// The server's answer → the password's value, stretched.
async function finalize(password, r, evaluated) {
  const unblinded = multiply(liftX(bytesToBig(evaluated)), invMod(r, n));
  const pw = utf8.encode(String(password));
  const output = await sha256(join(lenPrefixed(pw), lenPrefixed(bigToBytes(unblinded.x)), utf8.encode('Finalize')));
  const base = await subtle.importKey('raw', output, 'PBKDF2', false, ['deriveBits']);
  const stretched = new Uint8Array(await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: utf8.encode(CONTEXT + ' stretch'), iterations: 600000 }, base, 256));
  return hkdfExtract(new Uint8Array(0), join(output, stretched));
}

// The keys inside an envelope, from the stretched password and its nonce.
async function openEnvelopeKeys(rpw, nonce) {
  const authKey = await hkdfExpand(rpw, join(nonce, utf8.encode('AuthKey')), 32);
  const exportKey = await hkdfExpand(rpw, join(nonce, utf8.encode('ExportKey')), 32);
  const sk = toScalar(await hkdfExpand(rpw, join(nonce, utf8.encode('PrivateKey')), 48));
  const clientPublic = encodePoint(multiplyBase(sk));
  const clientPrivate = await subtle.importKey('pkcs8', scalarToPkcs8(sk), ECDH, false, ['deriveBits']);
  return { authKey, exportKey, clientPublic, clientPrivate };
}

// Calls a ShareSecure endpoint with JSON; `post` is supplied by the caller so
// this works from the browser and from the desktop app alike.
async function step(post, path, body, headers) {
  const { status, data } = await post(path, body, headers);
  if (status >= 400) {
    const err = new Error(data?.error || 'Something went wrong. Try again.');
    err.status = status;
    err.code = data?.code;
    throw err;
  }
  return data;
}

// Makes the account's record: what the server keeps instead of a password.
// path is /api/auth/register (new account) or /api/auth/upgrade (an older
// account moving to this sign-in). → { record, exportKey }
async function makeRecord(post, path, username, password, headers) {
  const { r, blinded } = await blind(password);
  const start = await step(post, `${path}/start`, { username, blinded: toB64url(blinded) }, headers);
  const rpw = await finalize(password, r, fromB64url(start.evaluated));
  const serverPublic = fromB64url(start.serverPublicKey);
  const nonce = randomBytes(32);
  const { authKey, exportKey, clientPublic } = await openEnvelopeKeys(rpw, nonce);
  const envelope = join(nonce, await hmac(authKey, join(nonce, cleartext(serverPublic, clientPublic, username))));
  return {
    exportKey,
    record: {
      client_public_key: toB64url(clientPublic),
      masking_key: toB64url(await hkdfExpand(rpw, 'MaskingKey', 32)),
      envelope: toB64url(envelope),
    },
  };
}

// New account. `afterKeys(exportKey)` returns extra fields to save with it
// (the end-to-end key pair).
export async function register(post, username, password, afterKeys) {
  const { record, exportKey } = await makeRecord(post, '/api/auth/register', username, password);
  await step(post, '/api/auth/register/finish', { username, record, ...(afterKeys ? await afterKeys(exportKey) : {}) });
}

// Proves the password to the server without sending it. Returns the proof
// (state + client_mac) to hand to /api/auth/login/finish, or to an endpoint
// that wants a fresh sign-in (deleting the account), plus the export key.
// Accounts made before this sign-in existed answer { legacy: true }.
export async function prove(post, username, password) {
  const { r, blinded } = await blind(password);
  const clientNonce = randomBytes(32);
  const eph = await subtle.generateKey(ECDH, true, ['deriveBits']);
  const ephPublic = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const ke1 = join(blinded, clientNonce, ephPublic);

  const ke2 = await step(post, '/api/auth/login/start', {
    username, blinded: toB64url(blinded), client_nonce: toB64url(clientNonce), client_ephemeral: toB64url(ephPublic),
  });
  if (ke2.legacy) return { legacy: true };

  const credentialResponse = fromB64url(ke2.credential_response);
  const evaluated = credentialResponse.subarray(0, 32);
  const maskingNonce = credentialResponse.subarray(32, 64);
  const masked = credentialResponse.subarray(64);
  const rpw = await finalize(password, r, evaluated);

  // unmask the server's public key and the envelope
  const maskingKey = await hkdfExpand(rpw, 'MaskingKey', 32);
  const pad = await hkdfExpand(maskingKey, join(maskingNonce, utf8.encode('CredentialResponsePad')), masked.length);
  const plain = xor(masked, pad);
  const serverPublic = plain.subarray(0, 65);
  const nonce = plain.subarray(65, 97);
  const tag = plain.subarray(97, 129);

  const keys = await openEnvelopeKeys(rpw, nonce);
  const expected = await hmac(keys.authKey, join(nonce, cleartext(serverPublic, keys.clientPublic, username)));
  if (!sameBytes(tag, expected)) throw Object.assign(new Error('Wrong username or password.'), { status: 401 });

  const serverNonce = fromB64url(ke2.server_nonce);
  const serverEphemeral = fromB64url(ke2.server_ephemeral);
  const pre = preamble({ username, ke1, credentialResponse, serverNonce, serverEphemeral });
  const { serverMac, clientMac } = await keySchedule([
    await ecdh(eph.privateKey, serverEphemeral),
    await ecdh(eph.privateKey, serverPublic),
    await ecdh(keys.clientPrivate, serverEphemeral),
  ], pre);
  // the server proves it's the server the account was made with
  if (!sameBytes(serverMac, fromB64url(ke2.server_mac))) throw new Error('The server couldn’t prove who it is. Don’t sign in.');

  return { proof: { state: ke2.state, client_mac: toB64url(clientMac) }, exportKey: keys.exportKey };
}

// Signs in. Older accounts still send their password once, then switch to this
// sign-in for good. `afterKeys(exportKey, signedIn)` returns the account's
// end-to-end key fields to save when it has none yet.
// → { token, username, userId, exportKey, publicKey, privateKeyBox }
export async function signIn(post, username, password, afterKeys) {
  let proven = await prove(post, username, password);
  if (proven.legacy) {
    const old = await step(post, '/api/auth/login', { username, access_code: password });
    const auth = { Authorization: `Bearer ${old.token}` };
    const made = await makeRecord(post, '/api/auth/upgrade', username, password, auth);
    const extra = afterKeys && !old.publicKey ? await afterKeys(made.exportKey) : {};
    await step(post, '/api/auth/upgrade/finish', { access_code: password, record: made.record, ...extra }, auth);
    proven = await prove(post, username, password);
    if (proven.legacy) throw new Error('Couldn’t update your sign-in. Try again.');
  }
  const done = await step(post, '/api/auth/login/finish', proven.proof);
  return { ...done, exportKey: proven.exportKey };
}

// fetch → the `post` the functions above want
export const postWith = (fetchImpl, base = '') => async (path, body, headers = {}) => {
  const res = await fetchImpl(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
};
