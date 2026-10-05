// P-256 curve arithmetic in plain JavaScript, for the few things the browser's
// built-in crypto can't do: hashing a password onto the curve (RFC 9380) and
// multiplying arbitrary points by a number (the "blind" and "unblind" steps of
// password sign-in). Everything else uses WebCrypto.
//
// Only browsers run this, on values that come from the person's own password,
// so it doesn't need to resist timing attacks from someone else. The server
// never does curve math here; it uses WebCrypto's ECDH.

export const p = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
export const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const a = p - 3n;
const b = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const G = {
  x: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
  y: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
};

// ── numbers ──────────────────────────────────────────────────────────────────

const mod = (x, m) => { const r = x % m; return r < 0n ? r + m : r; };

export function powMod(base, exp, m) {
  let r = 1n;
  base = mod(base, m);
  while (exp > 0n) {
    if (exp & 1n) r = r * base % m;
    base = base * base % m;
    exp >>= 1n;
  }
  return r;
}

// 1/x mod m (m is prime here)
export const invMod = (x, m) => powMod(x, m - 2n, m);

// square root mod p; P-256's p is 3 mod 4, so it's one power. null if none.
function sqrt(x) {
  const r = powMod(x, (p + 1n) / 4n, p);
  return r * r % p === mod(x, p) ? r : null;
}

export function bytesToBig(bytes) {
  let x = 0n;
  for (const byte of bytes) x = (x << 8n) | BigInt(byte);
  return x;
}

export function bigToBytes(x, length = 32) {
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}

// ── points ───────────────────────────────────────────────────────────────────
// Points are { x, y } in plain coordinates, or null for the point at infinity.
// The maths inside uses Jacobian coordinates (X, Y, Z) to skip most divisions.

const toJ = P => P ? { X: P.x, Y: P.y, Z: 1n } : { X: 0n, Y: 1n, Z: 0n };

function fromJ({ X, Y, Z }) {
  if (Z === 0n) return null;
  const zi = invMod(Z, p), zi2 = zi * zi % p;
  return { x: X * zi2 % p, y: Y * zi2 % p * zi % p };
}

function double({ X, Y, Z }) {
  if (Z === 0n || Y === 0n) return { X: 0n, Y: 1n, Z: 0n };
  const ZZ = Z * Z % p;
  const M = 3n * mod((X - ZZ) * (X + ZZ), p) % p;      // a = -3
  const YY = Y * Y % p;
  const S = 4n * X * YY % p;
  const X3 = mod(M * M - 2n * S, p);
  const Y3 = mod(M * (S - X3) - 8n * YY * YY, p);
  return { X: X3, Y: Y3, Z: 2n * Y * Z % p };
}

function add(P, Q) {
  if (P.Z === 0n) return Q;
  if (Q.Z === 0n) return P;
  const Z1Z1 = P.Z * P.Z % p, Z2Z2 = Q.Z * Q.Z % p;
  const U1 = P.X * Z2Z2 % p, U2 = Q.X * Z1Z1 % p;
  const S1 = P.Y * Q.Z % p * Z2Z2 % p, S2 = Q.Y * P.Z % p * Z1Z1 % p;
  if (U1 === U2) return S1 === S2 ? double(P) : { X: 0n, Y: 1n, Z: 0n };
  const H = mod(U2 - U1, p), R = mod(S2 - S1, p);
  const HH = H * H % p, HHH = H * HH % p, V = U1 * HH % p;
  const X3 = mod(R * R - HHH - 2n * V, p);
  const Y3 = mod(R * (V - X3) - S1 * HHH, p);
  return { X: X3, Y: Y3, Z: H * P.Z % p * Q.Z % p };
}

export function isOnCurve(P) {
  return P && P.x < p && P.y < p && mod(P.y * P.y - (P.x * P.x * P.x + a * P.x + b), p) === 0n;
}

// k × P, four bits at a time
export function multiply(P, k) {
  k = mod(k, n);
  const table = [toJ(null), toJ(P)];
  for (let i = 2; i < 16; i++) table.push(add(table[i - 1], table[1]));
  let R = toJ(null);
  for (let shift = 252n; shift >= 0n; shift -= 4n) {
    R = double(double(double(double(R))));
    R = add(R, table[Number((k >> shift) & 15n)]);
  }
  return fromJ(R);
}

export const multiplyBase = k => multiply(G, k);
export const addPoints = (P, Q) => fromJ(add(toJ(P), toJ(Q)));

// Uncompressed encoding: 0x04 ‖ x ‖ y (what WebCrypto's "raw" format uses).
export function encodePoint(P) {
  const out = new Uint8Array(65);
  out[0] = 4;
  out.set(bigToBytes(P.x), 1);
  out.set(bigToBytes(P.y), 33);
  return out;
}

// A point with this x (either of the two; the caller only needs its x later).
export function liftX(x) {
  const y = sqrt(x * x * x + a * x + b);
  if (y === null) throw new Error('No point with that x');
  return { x: mod(x, p), y };
}

// ── hashing onto the curve: RFC 9380, P256_XMD:SHA-256_SSWU_RO_ ──────────────

const utf8 = new TextEncoder();

async function sha256(...parts) {
  const len = parts.reduce((s, x) => s + x.length, 0);
  const buf = new Uint8Array(len);
  let o = 0;
  for (const x of parts) { buf.set(x, o); o += x.length; }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
}

// expand_message_xmd with SHA-256 (RFC 9380 section 5.3.1)
export async function expandMessage(msg, dst, length) {
  const dstBytes = typeof dst === 'string' ? utf8.encode(dst) : dst;
  const dstPrime = new Uint8Array([...dstBytes, dstBytes.length]);
  const ell = Math.ceil(length / 32);
  const b0 = await sha256(new Uint8Array(64), msg, new Uint8Array([length >> 8, length & 255, 0]), dstPrime);
  const blocks = [await sha256(b0, new Uint8Array([1]), dstPrime)];
  for (let i = 2; i <= ell; i++) {
    const prev = blocks[i - 2].map((v, j) => v ^ b0[j]);
    blocks.push(await sha256(prev, new Uint8Array([i]), dstPrime));
  }
  const out = new Uint8Array(ell * 32);
  blocks.forEach((blk, i) => out.set(blk, i * 32));
  return out.subarray(0, length);
}

// Simplified SWU map for P-256 with Z = -10 (RFC 9380 section 6.6.2)
const Z = p - 10n;
function mapToCurve(u) {
  const tv1 = invMod(mod(Z * Z % p * powMod(u, 4n, p) + Z * u % p * u, p), p);
  let x1 = tv1 === 0n
    ? b * invMod(Z * a % p, p) % p
    : mod(-b * invMod(a, p), p) * (1n + tv1) % p;
  const gx1 = mod(x1 * x1 % p * x1 + a * x1 + b, p);
  let x, y = sqrt(gx1);
  if (y !== null) x = x1;
  else {
    x = Z * u % p * u % p * x1 % p;
    y = sqrt(mod(x * x % p * x + a * x + b, p));
  }
  // the sign of y follows the sign of u
  if ((u & 1n) !== (y & 1n)) y = p - y;
  return { x, y };
}

export async function hashToCurve(msg, dst) {
  const bytes = typeof msg === 'string' ? utf8.encode(msg) : msg;
  const uniform = await expandMessage(bytes, dst, 96);
  const u0 = mod(bytesToBig(uniform.subarray(0, 48)), p);
  const u1 = mod(bytesToBig(uniform.subarray(48, 96)), p);
  return addPoints(mapToCurve(u0), mapToCurve(u1));
}

// A random number from 1 to n-1.
export function randomScalar() {
  for (;;) {
    const k = bytesToBig(crypto.getRandomValues(new Uint8Array(32)));
    if (k > 0n && k < n) return k;
  }
}
