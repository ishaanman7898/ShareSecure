// POST /api/auth/zk-challenge
// Auth required (Bearer token). Issues a fresh ZK nonce tied to the user_id.
//
// Rate limited: 5 challenges per 24h per user. Since ZK uploads write no
// user_tag, this challenge limit is the only place upload abuse is bounded
// for the ZK path.

import { verifyToken, getAuthClient } from '../../_turso.js';
import { issueChallenge, purgeExpiredChallenges } from '../../_zk.js';

const MAX_CHALLENGES_PER_DAY = 5;

export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = await verifyToken(request.headers.get('Authorization'), env);
  if (!auth) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  context.waitUntil(purgeExpiredChallenges(env));

  // Rate limit: count challenges issued in the last 24h for this user.
  // Includes both expired and consumed nonces — we keep a `zk_challenge_log`
  // row per issuance independent of the active challenge table.
  try {
    const client = getAuthClient(env);
    await client.execute({
      sql: `CREATE TABLE IF NOT EXISTS zk_challenge_log (
              user_id INTEGER NOT NULL,
              issued_at TEXT NOT NULL
            )`,
      args: []
    });
    const recent = await client.execute({
      sql: "SELECT COUNT(*) as count FROM zk_challenge_log WHERE user_id = ? AND issued_at > datetime('now', '-1 day')",
      args: [auth.userId]
    });
    if (recent.rows[0].count >= MAX_CHALLENGES_PER_DAY) {
      return Response.json({ error: 'Challenge limit reached (5 per 24h)' }, { status: 429 });
    }
    await client.execute({
      sql: 'INSERT INTO zk_challenge_log (user_id, issued_at) VALUES (?, ?)',
      args: [auth.userId, new Date().toISOString()]
    });
  } catch {
    // Don't fail open — if the rate-limit check itself crashes, reject the request
    return Response.json({ error: 'Rate limit check failed' }, { status: 500 });
  }

  try {
    const { nonce, expiresAt } = await issueChallenge(auth.userId, env);
    return Response.json({ nonce, expiresAt });
  } catch {
    return Response.json({ error: 'Challenge issuance failed' }, { status: 500 });
  }
}
