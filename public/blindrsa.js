// Blind RSA signatures (RFC 9474, RSABSSA-SHA384-PSS-Deterministic), the
// scheme behind Privacy Pass (RFC 9578).
//
// Once a day the signed-in browser gets a few tokens, signed by the server
// without it seeing them, and later spends them on uploads and sends without
// signing in. The server can check its own signature but not which account it
// gave the token to, so limits apply per account without tying anything to one.
// The final signature is checked with WebCrypto's RSA-PSS, so a mistake here
// fails loudly.

const subtle = globalThis.crypto.subtle;

// ── numbers ──────────────────────────────────────────────────────────────────

export function bytesToInt(bytes) {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex ? BigInt('0x' + hex) : 0n;
}

export function intToBytes(x, length) {
  const hex = x.toString(16).padStart(length * 2, '0');
  if (hex.length > length * 2) throw new Error('Number too large');
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// base^exp mod m, five bits at a time
export function powMod(base, exp, m) {
  base %= m;
  const table = [1n, base];
  for (let i = 2; i < 32; i++) table.push(table[i - 1] * base % m);
  const bits = exp.toString(2);
  let r = 1n;
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5);
    for (let k = 0; k < chunk.length; k++) r = r * r % m;
    r = r * table[parseInt(chunk, 2)] % m;
  }
  return r;
}

// 1/a mod m, or null when there isn't one
export function invMod(a, m) {
  let [oldR, r] = [((a % m) + m) % m, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return oldR === 1n ? ((oldS % m) + m) % m : null;
}

export function randomBelow(m) {
  const len = Math.ceil(m.toString(16).length / 2);
  for (;;) {
    const x = bytesToInt(crypto.getRandomValues(new Uint8Array(len + 8))) % m;
    if (x > 0n) return x;
  }
}

// ── EMSA-PSS encoding with SHA-384 and a 48-byte salt (RFC 8017 9.1.1) ───────

const sha384 = async bytes => new Uint8Array(await subtle.digest('SHA-384', bytes));

async function mgf1(seed, length) {
  const out = new Uint8Array(length);
  for (let counter = 0, o = 0; o < length; counter++) {
    const c = new Uint8Array([counter >>> 24, (counter >>> 16) & 255, (counter >>> 8) & 255, counter & 255]);
    const block = await sha384(new Uint8Array([...seed, ...c]));
    out.set(block.subarray(0, Math.min(48, length - o)), o);
    o += 48;
  }
  return out;
}

export async function emsaPssEncode(msg, modBits, salt = crypto.getRandomValues(new Uint8Array(48))) {
  const emBits = modBits - 1;
  const emLen = Math.ceil(emBits / 8);
  const mHash = await sha384(msg);
  const H = await sha384(new Uint8Array([...new Uint8Array(8), ...mHash, ...salt]));
  const db = new Uint8Array(emLen - 48 - 1);
  db[db.length - salt.length - 1] = 1;
  db.set(salt, db.length - salt.length);
  const mask = await mgf1(H, db.length);
  const masked = db.map((v, i) => v ^ mask[i]);
  masked[0] &= 0xff >> (8 * emLen - emBits);
  return new Uint8Array([...masked, ...H, 0xbc]);
}

// ── the issuer's public key ──────────────────────────────────────────────────

// { n, e } as a JWK → what the functions below need
export async function issuerKey(jwk) {
  const n = bytesToInt(b64urlToBytes(jwk.n));
  return {
    n,
    e: bytesToInt(b64urlToBytes(jwk.e)),
    bits: n.toString(2).length,
    size: Math.ceil(n.toString(16).length / 2),
    verifyKey: await subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'PS384', ext: true },
      { name: 'RSA-PSS', hash: 'SHA-384' }, false, ['verify']),
  };
}

function b64urlToBytes(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

// ── the browser's side ───────────────────────────────────────────────────────

// → { blinded, inv }: send `blinded` to be signed, keep `inv` to unblind.
// salt and r can be fixed for the RFC's test vectors.
export async function blind(key, msg, { salt, r } = {}) {
  const m = bytesToInt(await emsaPssEncode(msg, key.bits, salt));
  if (invMod(m, key.n) === null) throw new Error('Unlucky message, try again');
  r ??= randomBelow(key.n);
  const inv = invMod(r, key.n);
  if (inv === null) throw new Error('Unlucky blind, try again');
  return { blinded: intToBytes(m * powMod(r, key.e, key.n) % key.n, key.size), inv };
}

// The server's blind signature → a normal RSA-PSS signature on msg, checked.
export async function finalize(key, msg, blindSig, inv) {
  if (blindSig.length !== key.size) throw new Error('Wrong signature size');
  const sig = intToBytes(bytesToInt(blindSig) * inv % key.n, key.size);
  if (!(await verify(key, msg, sig))) throw new Error('The token’s signature didn’t check out');
  return sig;
}

export const verify = (key, msg, sig) =>
  subtle.verify({ name: 'RSA-PSS', saltLength: 48 }, key.verifyKey, sig, msg);

// ── ShareSecure's tokens ─────────────────────────────────────────────────────
// What a token signs: what it's for, the day, which key, and its own random
// nonce. Nothing about the account.
const KINDS = { upload: 1, send: 2 };
export function tokenMessage(kind, day, keyId, nonce) {
  const id = b64urlToBytes(keyId);
  const head = new Uint8Array([KINDS[kind], day >>> 24, (day >>> 16) & 255, (day >>> 8) & 255, day & 255]);
  return new Uint8Array([...new TextEncoder().encode('ShareSecure token v1'), ...head, ...id, ...nonce]);
}
