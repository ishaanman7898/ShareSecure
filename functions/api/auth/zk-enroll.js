// POST /api/auth/zk-enroll  { commitment }
// Saves this browser's ZK commitment for an account that doesn't have one yet.
// Accounts created before the registration fix never had theirs saved, so their
// private uploads were rejected; the app calls this after sign-in to repair them.
// An existing commitment is never replaced.

import { verifyToken, getAuthClient } from '../../_turso.js';
import { storeCommitment } from '../../_zk.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = await verifyToken(request.headers.get('Authorization'), env);
  if (!auth) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  let commitment;
  try {
    ({ commitment } = await request.json());
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }
  if (!commitment || typeof commitment !== 'string') {
    return Response.json({ error: 'Commitment required' }, { status: 400 });
  }

  try {
    let existing = null;
    try {
      const res = await getAuthClient(env).execute({
        sql: 'SELECT zk_commitment FROM users WHERE id = ?',
        args: [auth.userId]
      });
      existing = res.rows[0]?.zk_commitment || null;
    } catch { /* column not created yet; storeCommitment adds it */ }
    if (existing) return Response.json({ enrolled: true, changed: false });
    await storeCommitment(auth.userId, commitment, env);
    return Response.json({ enrolled: true, changed: true });
  } catch {
    return Response.json({ error: 'Couldn’t save the commitment' }, { status: 400 });
  }
}
