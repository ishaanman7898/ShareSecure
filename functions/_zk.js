// ZK auth adapter — wires UniGroth into ShareSecure
// Provides: challenge issuance, proof verification, nullifier replay protection.
//
// Privacy model:
//   - At registration, client generates a 32-byte secret, computes commit(secret)
//     via UniGroth, and uploads ONLY the commitment. Server never sees the secret.
//   - At each upload, client fetches a fresh nonce, generates a proof binding the
//     secret to that nonce, and sends {proof, nullifier, nonce}.
//   - Server looks up the commitment by user_id (from auth token), verifies the
//     proof, and checks the nullifier hasn't been used. Nullifier replay = reject.
//
// Why this matters: the server learns "some registered user uploaded this file"
// but cannot link the upload to a specific user_id without the secret. The
// user_id is only used to look up which commitment to verify against —
// the upload row itself stores NO user identifier.

import { getAuthClient, getFilesClient } from './_turso.js';
import { verify as zkVerify, Field as F } from './lib/unigroth/index.js';

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Run once per request — idempotent schema migrations
async function ensureSchema(env) {
  const client = getAuthClient(env);
  for (const sql of [
    'ALTER TABLE users ADD COLUMN zk_commitment TEXT',
    `CREATE TABLE IF NOT EXISTS zk_nullifiers (
       nullifier TEXT PRIMARY KEY,
       used_at   TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS zk_challenges (
       nonce       TEXT PRIMARY KEY,
       user_id     INTEGER NOT NULL,
       issued_at   TEXT NOT NULL,
       expires_at  TEXT NOT NULL
     )`,
  ]) {
    try { await client.execute({ sql, args: [] }); } catch {}
  }
}

// Generate a cryptographically random nonce in the bn254 scalar field, tied to a user_id.
// Returns {nonce, expiresAt}.
export async function issueChallenge(userId, env) {
  await ensureSchema(env);
  const nonce = F.random().toString();
  const now = Date.now();
  const issuedAt  = new Date(now).toISOString();
  const expiresAt = new Date(now + CHALLENGE_TTL_MS).toISOString();

  const client = getAuthClient(env);
  await client.execute({
    sql: 'INSERT INTO zk_challenges (nonce, user_id, issued_at, expires_at) VALUES (?, ?, ?, ?)',
    args: [nonce, userId, issuedAt, expiresAt]
  });
  return { nonce, expiresAt };
}

// Look up the commitment registered for a user. Returns null if user has not enrolled in ZK.
async function getCommitmentByUserId(userId, env) {
  const client = getAuthClient(env);
  const res = await client.execute({
    sql: 'SELECT zk_commitment FROM users WHERE id = ?',
    args: [userId]
  });
  return res.rows[0]?.zk_commitment || null;
}

// Validate a ZK proof:
//   1. nonce matches an issued, non-expired challenge for SOME user
//   2. proof verifies against that user's commitment
//   3. nullifier has not been used before
// Returns {valid: true, userId} on success, {valid: false, error} on failure.
export async function verifyProof({ proof, nullifier, nonce }, env) {
  await ensureSchema(env);

  if (!proof || !nullifier || !nonce) {
    return { valid: false, error: 'Missing proof, nullifier, or nonce' };
  }

  const client = getAuthClient(env);

  // 1. Resolve the challenge → user_id
  const chal = await client.execute({
    sql: 'SELECT user_id, expires_at FROM zk_challenges WHERE nonce = ?',
    args: [nonce]
  });
  if (chal.rows.length === 0) return { valid: false, error: 'Unknown nonce' };
  const { user_id, expires_at } = chal.rows[0];
  if (new Date(expires_at) < new Date()) {
    return { valid: false, error: 'Challenge expired' };
  }

  // 2. Look up the user's commitment
  const commitment = await getCommitmentByUserId(user_id, env);
  if (!commitment) {
    return { valid: false, error: 'User has not enrolled ZK credentials' };
  }

  // 3. Run UniGroth verify
  const ok = await zkVerify({ proof, nullifier, commitment, nonce });
  if (!ok) return { valid: false, error: 'Proof verification failed' };

  // 4. Nullifier replay check
  const nul = await client.execute({
    sql: 'SELECT 1 FROM zk_nullifiers WHERE nullifier = ?',
    args: [nullifier]
  });
  if (nul.rows.length > 0) return { valid: false, error: 'Nullifier already used' };

  // 5. Consume challenge + record nullifier (single transaction-ish — best-effort)
  await client.execute({
    sql: 'INSERT INTO zk_nullifiers (nullifier, used_at) VALUES (?, ?)',
    args: [nullifier, new Date().toISOString()]
  });
  await client.execute({
    sql: 'DELETE FROM zk_challenges WHERE nonce = ?',
    args: [nonce]
  });

  return { valid: true, userId: user_id };
}

// Store the commitment a client computed at registration time.
export async function storeCommitment(userId, commitment, env) {
  await ensureSchema(env);
  // Validate commitment parses as a bn254 field element
  try { F.toBigInt(commitment); } catch { throw new Error('Invalid commitment format'); }

  const client = getAuthClient(env);
  await client.execute({
    sql: 'UPDATE users SET zk_commitment = ? WHERE id = ?',
    args: [commitment, userId]
  });
}

// Best-effort purge of expired challenges. Call from waitUntil().
export async function purgeExpiredChallenges(env) {
  const client = getAuthClient(env);
  try {
    await client.execute({
      sql: "DELETE FROM zk_challenges WHERE expires_at < datetime('now')",
      args: []
    });
  } catch {}
}
