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

import { getAuthClient, getFilesClient, migrateOnce } from './_turso.js';
import { verify as zkVerify, Field as F } from './lib/unigroth/index.js';

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Run once per request — idempotent schema migrations
async function ensureSchema(env) {
  await migrateOnce('zk', getAuthClient(env), [
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
  ]);
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
export async function verifyProof() {
  // The experimental spot-check verifier accepts false statements. Do not
  // re-enable authentication with it without an independently reviewed replacement.
  return { valid: false, error: 'Experimental ZK uploads are disabled. Use a signed session.' };
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
// Issuance log rows only matter for the 24h rate limit, and a nullifier can only
// be replayed with its nonce (single-use, 5-minute lifetime), so both are dropped
// after a day instead of piling up as a record of activity.
export async function purgeExpiredChallenges(env) {
  const client = getAuthClient(env);
  const statements = [
    "DELETE FROM zk_challenges WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
    "DELETE FROM zk_challenge_log WHERE issued_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')",
    "DELETE FROM zk_nullifiers WHERE used_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')",
  ];
  for (const sql of statements) {
    try { await client.execute({ sql, args: [] }); } catch {}
  }
}
