// The public key log ("key transparency"): an append-only list of which
// public key each username has, so the server can't quietly hand out a key of
// its own for someone (which is how a compromised server would try to read
// files sent to them).
//
// Each time an account sets its key, or is deleted, an entry is added. The
// entries form a Merkle tree (RFC 6962 / RFC 9162, the same scheme Certificate
// Transparency uses), so:
//   - with a short proof, anyone can check a key they were given is in the log;
//   - with another short proof, anyone can check the log only ever grew since
//     they last looked, never rewrote what was there;
//   - anyone can download the whole log and check no username has two keys.
// Entries name accounts by a hash of the username, not the name itself.
//
// This one file runs in the browser, on Cloudflare and in Node 20+.

const subtle = globalThis.crypto.subtle;
const utf8 = new TextEncoder();

const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const unhex = text => new Uint8Array(String(text).match(/../g).map(h => parseInt(h, 16)));
const sha256 = async bytes => new Uint8Array(await subtle.digest('SHA-256', bytes));

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ── entries ──────────────────────────────────────────────────────────────────

export const normalizeUsername = name => String(name || '').trim().replace(/^@/, '').normalize('NFKC').toLowerCase();

// What the log calls an account: a hash of its username.
export const labelFor = async username => hex(await sha256(utf8.encode(`sharesecure username v1\n${normalizeUsername(username)}`)));

// kind: 'key' (the account's public key is publicKey) or 'gone' (deleted)
export const leafData = (label, kind, publicKey) => utf8.encode(`sharesecure key log v1\n${label}\n${kind}\n${publicKey || ''}`);

// RFC 6962: a leaf is hashed with a 0 byte in front, a pair of nodes with a 1.
export const leafHash = async (label, kind, publicKey) => hex(await sha256(concat(new Uint8Array([0]), leafData(label, kind, publicKey))));
export const nodeHash = async (left, right) => hex(await sha256(concat(new Uint8Array([1]), unhex(left), unhex(right))));
export const EMPTY_ROOT = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// the largest power of two smaller than n (n > 1)
export function splitPoint(n) {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

// ── proofs, made from any way of hashing a range of leaves ───────────────────
// hashRange(lo, hi) → the Merkle tree hash of leaves lo … hi-1

export async function inclusionProof(index, size, hashRange) {
  const path = [];
  async function walk(m, lo, hi) {
    if (hi - lo <= 1) return;
    const k = splitPoint(hi - lo);
    if (m < k) { await walk(m, lo, lo + k); path.push(await hashRange(lo + k, hi)); }
    else { await walk(m - k, lo + k, hi); path.push(await hashRange(lo, lo + k)); }
  }
  await walk(index, 0, size);
  return path;
}

export async function consistencyProof(first, second, hashRange) {
  const path = [];
  async function walk(m, lo, hi, whole) {
    const n = hi - lo;
    if (m === n) { if (!whole) path.push(await hashRange(lo, hi)); return; }
    const k = splitPoint(n);
    if (m <= k) { await walk(m, lo, lo + k, whole); path.push(await hashRange(lo + k, hi)); }
    else { await walk(m - k, lo + k, hi, false); path.push(await hashRange(lo, lo + k)); }
  }
  if (first > 0 && first < second) await walk(first, 0, second, true);
  return path;
}

// ── checking proofs (RFC 9162, sections 2.1.3.2 and 2.1.4.2) ──────────────────

export async function verifyInclusion(leaf, index, size, path, root) {
  if (!Number.isInteger(index) || !Number.isInteger(size) || index < 0 || index >= size) return false;
  let fn = index, sn = size - 1, r = leaf;
  for (const p of path) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      r = await nodeHash(p, r);
      if (fn % 2 === 0) while (fn !== 0 && fn % 2 === 0) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
    } else {
      r = await nodeHash(r, p);
    }
    fn = Math.floor(fn / 2); sn = Math.floor(sn / 2);
  }
  return sn === 0 && r === root;
}

export async function verifyConsistency(first, firstRoot, second, secondRoot, path) {
  if (!Number.isInteger(first) || !Number.isInteger(second) || first < 0 || first > second) return false;
  if (first === 0) return path.length === 0;             // an empty log is a prefix of anything
  if (first === second) return path.length === 0 && firstRoot === secondRoot;
  if (!path.length) return false;
  const proof = (first & (first - 1)) === 0 ? [firstRoot, ...path] : [...path];
  let fn = first - 1, sn = second - 1;
  while (fn % 2 === 1) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
  let fr = proof[0], sr = proof[0];
  for (const c of proof.slice(1)) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      fr = await nodeHash(c, fr);
      sr = await nodeHash(c, sr);
      if (fn % 2 === 0) while (fn !== 0 && fn % 2 === 0) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
    } else {
      sr = await nodeHash(sr, c);
    }
    fn = Math.floor(fn / 2); sn = Math.floor(sn / 2);
  }
  return sn === 0 && fr === firstRoot && sr === secondRoot;
}

// The root of a whole list of leaf hashes, the slow way (for monitors and tests).
export async function rootOf(leaves) {
  async function mth(lo, hi) {
    if (hi === lo) return EMPTY_ROOT;
    if (hi - lo === 1) return leaves[lo];
    const k = splitPoint(hi - lo);
    return nodeHash(await mth(lo, lo + k), await mth(lo + k, hi));
  }
  return mth(0, leaves.length);
}

// ── what a client remembers ──────────────────────────────────────────────────

// Checks a key the server gave for username, with its proof, and that the log
// it's in only grew since the last log this client saw (`known`, or null).
// fetchConsistency(from, to) → proof. → { ok, head, reason }
export async function checkKey(username, publicKey, proof, known, fetchConsistency) {
  if (!proof || !Number.isInteger(proof.index) || !Number.isInteger(proof.size) || !Array.isArray(proof.path) || typeof proof.root !== 'string') {
    return { ok: false, reason: 'The server didn’t include proof that this key is in the public key log.' };
  }
  const leaf = await leafHash(await labelFor(username), 'key', publicKey);
  if (!(await verifyInclusion(leaf, proof.index, proof.size, proof.path, proof.root))) {
    return { ok: false, reason: 'This key isn’t in the public key log.' };
  }
  const head = { size: proof.size, root: proof.root };
  if (known && known.size && known.root) {
    const [a, b] = known.size <= head.size ? [known, head] : [head, known];
    const path = a.size === b.size ? [] : await fetchConsistency(a.size, b.size);
    if (!(await verifyConsistency(a.size, a.root, b.size, b.root, path))) {
      return { ok: false, reason: 'The public key log doesn’t match what this device saw before. It may have been rewritten.' };
    }
    return { ok: true, head: b };
  }
  return { ok: true, head };
}
