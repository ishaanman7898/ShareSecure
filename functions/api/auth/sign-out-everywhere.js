// POST /api/auth/sign-out-everywhere — signs the account out on every browser,
// desktop app and device, and gives this one a new session so it stays in.
// Assistant connections have their own token: turn those off under Connect an AI assistant.
import { getDb, verifyToken, signToken } from '../../_turso.js';
import { fail } from '../../_auth.js';

export async function onRequestPost(context) {
  const { env, request } = context;
  const auth = await verifyToken(request.headers.get('Authorization'), env);
  if (!auth) return fail('Sign in first.', 401);
  const row = (await getDb(env).execute({
    sql: 'UPDATE users SET session_epoch = COALESCE(session_epoch, 0) + 1 WHERE id = ? RETURNING session_epoch',
    args: [auth.userId]
  })).rows[0];
  if (!row) return fail('Sign in first.', 401);
  return Response.json({ token: await signToken({ username: auth.username, userId: auth.userId, ep: Number(row.session_epoch) }, env) });
}
