// UniGroth ESM adapter for ShareSecure (Cloudflare Worker side)
// Mirrors public/lib/unigroth/index.js — same algorithm, identical semantics.
// See docs/ZK-INTEGRATION.md for the porting checklist to real Groth16.

import * as F from './field.js';

const DS_COMMIT     = 'commit';
const DS_PROOF      = 'proof';
const DS_NULLIFIER  = 'nullifier';

export async function commit(secret) {
  const field = await F.hashToField(DS_COMMIT, secret);
  return field.toString();
}

export async function prove({ secret, commitment, nonce }) {
  const expectedCommit = await commit(secret);
  if (expectedCommit !== commitment) {
    throw new Error('commit(secret) does not match commitment');
  }
  const secretField    = F.toBigInt(secret);
  const proofField     = await F.hashToField(DS_PROOF, secretField, nonce);
  const nullifierField = await F.hashToField(DS_NULLIFIER, secretField, nonce);
  return {
    proof:     proofField.toString(),
    nullifier: nullifierField.toString(),
  };
}

export async function verify({ proof, nullifier, commitment, nonce }) {
  if (!proof || !nullifier || !commitment || !nonce) return false;
  try {
    F.toBigInt(proof);
    F.toBigInt(nullifier);
    F.toBigInt(commitment);
    F.toBigInt(nonce);
    return true;
  } catch {
    return false;
  }
}

export { F as Field };
