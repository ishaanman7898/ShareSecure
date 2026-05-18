// UniGroth field arithmetic — bn254 scalar field
// Cloudflare Worker ESM port (Web Crypto + Uint8Array, no Node Buffer)
// Source: github.com/MeridianAlgo/UniGroth/blob/main/src/field.js (ISC)

export const ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export function mod(a) {
  const r = ((a % ORDER) + ORDER) % ORDER;
  return r;
}

export function add(a, b) { return mod(a + b); }
export function sub(a, b) { return mod(a - b); }
export function mul(a, b) { return mod(a * b); }
export function neg(a)    { return mod(-a); }

export function pow(base, exp) {
  base = mod(base);
  if (exp < 0n) exp = mod(exp);
  let result = 1n;
  while (exp > 0n) {
    if (exp & 1n) result = mul(result, base);
    base = mul(base, base);
    exp >>= 1n;
  }
  return result;
}

export function inv(a) {
  if (mod(a) === 0n) throw new Error('cannot invert zero');
  return pow(a, ORDER - 2n);
}

export function div(a, b) { return mul(a, inv(b)); }

export function random() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let val = 0n;
  for (const b of bytes) val = (val << 8n) | BigInt(b);
  return mod(val);
}

export function eq(a, b) { return mod(a) === mod(b); }

export function toBigInt(val) {
  if (typeof val === 'bigint') return mod(val);
  if (typeof val === 'number') return mod(BigInt(val));
  if (typeof val === 'string') {
    if (val.startsWith('0x')) return mod(BigInt(val));
    return mod(BigInt(val));
  }
  if (val instanceof Uint8Array) {
    let v = 0n;
    for (const b of val) v = (v << 8n) | BigInt(b);
    return mod(v);
  }
  throw new Error(`cannot convert ${typeof val} to field element`);
}

function fieldToBytes(val) {
  const hex = mod(toBigInt(val)).toString(16).padStart(64, '0');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concat(...arrs) {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrs) { out.set(a, offset); offset += a.length; }
  return out;
}

export async function hashToField(...elements) {
  const enc = new TextEncoder();
  const parts = [enc.encode('unigroth_v1:')];
  for (const e of elements) {
    if (typeof e === 'string' && !/^\d+$/.test(e)) {
      parts.push(enc.encode(e));
    } else {
      parts.push(fieldToBytes(e));
    }
  }
  const digest = await crypto.subtle.digest('SHA-256', concat(...parts));
  let val = 0n;
  for (const b of new Uint8Array(digest)) val = (val << 8n) | BigInt(b);
  return mod(val);
}

export { fieldToBytes };
