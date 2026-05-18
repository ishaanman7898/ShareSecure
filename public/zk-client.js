// ShareSecure ZK client helpers
// Manages the user's UniGroth secret, computes commitments, and prepares
// per-upload proofs. The secret NEVER leaves the browser.

import { commit, prove, Field } from './lib/unigroth/index.js';

const SECRET_KEY = 'zk_secret';
const COMMITMENT_KEY = 'zk_commitment';

// Hex helpers (Uint8Array <-> string), since we serialize the secret as hex.
function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  if (hex.length % 2) throw new Error('hex string must have even length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Generate a fresh 32-byte secret and the matching commitment. Returns both.
// The secret is stored in localStorage; the commitment is what the server stores.
export async function generateCredentials() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secretHex = bytesToHex(bytes);
  const secretField = Field.toBigInt(bytes);
  const commitment = await commit(secretField);

  localStorage.setItem(SECRET_KEY, secretHex);
  localStorage.setItem(COMMITMENT_KEY, commitment);

  return { secret: secretHex, commitment };
}

// Returns the locally stored secret (hex string) or null if not enrolled.
export function getStoredSecret() {
  return localStorage.getItem(SECRET_KEY);
}

export function getStoredCommitment() {
  return localStorage.getItem(COMMITMENT_KEY);
}

// True if the current device has ZK credentials enrolled.
export function hasZKCredentials() {
  return Boolean(getStoredSecret() && getStoredCommitment());
}

// Fetch a fresh nonce from the server. Requires Bearer auth.
export async function fetchChallenge(userToken) {
  const res = await fetch('/api/auth/zk-challenge', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${userToken}` }
  });
  if (!res.ok) {
    if (res.status === 429) throw new Error('Challenge limit reached (5/24h)');
    throw new Error(`Challenge fetch failed: ${res.status}`);
  }
  const data = await res.json();
  return data.nonce; // decimal string of a bn254 field element
}

// Produce {zk_proof, zk_nullifier, zk_nonce} form-data fields for upload.
// The proof is a UniGroth JSON object (~25 KB), too large for HTTP headers,
// so it's transported in multipart form data alongside the file.
// Requires hasZKCredentials() === true and a valid userToken for the challenge.
export async function prepareUploadFields(userToken) {
  const secretHex = getStoredSecret();
  const commitment = getStoredCommitment();
  if (!secretHex || !commitment) {
    throw new Error('No ZK credentials enrolled on this device');
  }
  const nonce = await fetchChallenge(userToken);
  const secretField = Field.toBigInt(hexToBytes(secretHex));
  const { proof, nullifier } = await prove({ secret: secretField, commitment, nonce });
  return {
    zk_proof:     JSON.stringify(proof),
    zk_nullifier: nullifier,
    zk_nonce:     nonce,
  };
}

// Clear local credentials (e.g., on logout).
export function clearCredentials() {
  localStorage.removeItem(SECRET_KEY);
  localStorage.removeItem(COMMITMENT_KEY);
}
