// UniGroth commitment scheme — merkle tree + fiat-shamir transcript
// Browser ESM port: Web Crypto + Uint8Array (no Node Buffer/crypto)
// Source: github.com/MeridianAlgo/UniGroth/blob/main/src/commitment.js (ISC)

import * as F from './field.js';

const enc = new TextEncoder();

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function concat(...arrs) {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrs) { out.set(a, offset); offset += a.length; }
  return out;
}

export function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex) {
  if (hex.length % 2) throw new Error('hex string must have even length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256(...buffers) {
  const combined = concat(...buffers);
  const digest = await crypto.subtle.digest('SHA-256', combined);
  return new Uint8Array(digest);
}

export function fieldToBuffer(val) {
  const hex = F.mod(F.toBigInt(val)).toString(16).padStart(64, '0');
  return hexToBytes(hex);
}

const LEAF_TAG = enc.encode('leaf:');
const NODE_TAG = enc.encode('node:');

// Merkle tree over field elements. Construct asynchronously via .create().
export class MerkleTree {
  constructor() {
    this.leaves = [];
    this.layers = [];
  }

  static async create(leaves) {
    const tree = new MerkleTree();
    tree.leaves = leaves.map(l => fieldToBuffer(l));
    const leafHashes = [];
    for (const l of tree.leaves) leafHashes.push(await sha256(LEAF_TAG, l));
    tree.layers = [leafHashes];
    await tree._build();
    return tree;
  }

  async _build() {
    while (this.layers[this.layers.length - 1].length > 1) {
      const prev = this.layers[this.layers.length - 1];
      const next = [];
      for (let i = 0; i < prev.length; i += 2) {
        const left = prev[i];
        const right = i + 1 < prev.length ? prev[i + 1] : left;
        next.push(await sha256(NODE_TAG, left, right));
      }
      this.layers.push(next);
    }
  }

  root() {
    return this.layers[this.layers.length - 1][0];
  }

  proof(index) {
    const path = [];
    let idx = index;
    for (let i = 0; i < this.layers.length - 1; i++) {
      const layer = this.layers[i];
      const sibling = idx % 2 === 0
        ? (idx + 1 < layer.length ? layer[idx + 1] : layer[idx])
        : layer[idx - 1];
      path.push({ hash: sibling, position: idx % 2 === 0 ? 'right' : 'left' });
      idx = Math.floor(idx / 2);
    }
    return path;
  }

  static async verify(leaf, proof, root) {
    let current = await sha256(LEAF_TAG, fieldToBuffer(leaf));
    for (const step of proof) {
      if (step.position === 'right') {
        current = await sha256(NODE_TAG, current, step.hash);
      } else {
        current = await sha256(NODE_TAG, step.hash, current);
      }
    }
    return bytesEqual(current, root);
  }
}

// Fiat-Shamir transcript — turns interactive protocol into non-interactive.
export class Transcript {
  constructor() {
    this.state = null;
  }

  static async create(label) {
    const t = new Transcript();
    t.state = await sha256(enc.encode(`unigroth_transcript:${label}`));
    return t;
  }

  async absorb(val) {
    this.state = await sha256(this.state, fieldToBuffer(F.toBigInt(val)));
  }

  async absorbBytes(buf) {
    this.state = await sha256(this.state, buf);
  }

  async squeeze() {
    this.state = await sha256(this.state, enc.encode('challenge'));
    let val = 0n;
    for (const b of this.state) val = (val << 8n) | BigInt(b);
    return F.mod(val);
  }

  async squeezeN(n) {
    const challenges = [];
    for (let i = 0; i < n; i++) challenges.push(await this.squeeze());
    return challenges;
  }
}
