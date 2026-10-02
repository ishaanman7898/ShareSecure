// POST /api/auth/delete-account  { state, client_mac }   (or { access_code } for
// an account that hasn't switched to the new sign-in yet)
// Deletes the signed-in account and everything the server can tie to it: its
// shares (and every link reshared from them), files waiting in its inbox, its
// assistant tokens, its key pair and its saved list of shares. Anonymous shares
// carry no account link, so the browser deletes those first, with their keys.
// It needs a fresh proof of the password, made the same way as signing in.
import { verifyToken, getDb, getUserTag, checkAccessCode, deleteBranch } from '../../_turso.js';
import { checkProof, readJson, fail } from '../../_auth.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = await verifyToken(request.headers.get('Authorization'), env);
  if (!auth) return fail('Unauthorized', 401);

  const body = (await readJson(request)) || {};
  const db = getDb(env);
  const user = (await db.execute({ sql: 'SELECT id, access_code FROM users WHERE id = ?', args: [auth.userId] })).rows[0];
  if (!user) return fail('Unauthorized', 401);

  if (body.state) {
    const proven = await checkProof(context, body);
    if (proven instanceof Response || proven.id !== auth.userId) return fail('Wrong password', 403);
  } else if (!body.access_code || !(await checkAccessCode(String(body.access_code), user.access_code, env)).ok) {
    return fail('Wrong password', 403);
  }

  const userTag = await getUserTag(auth.userId, env);
  const own = (await db.execute({
    sql: 'SELECT short_id FROM files WHERE user_tag = ? OR (user_tag IS NULL AND user_id = ?)',
    args: [userTag, auth.userId]
  })).rows;
  for (const { short_id } of own) await deleteBranch(db, short_id, env);

  // tables that may not exist yet on a new install
  for (const [sql, arg] of [
    ['DELETE FROM files WHERE recipient_user_tag = ?', userTag],
    ['DELETE FROM api_tokens WHERE user_id = ?', auth.userId],
    ['DELETE FROM token_issued WHERE account = ?', await getUserTag(`issue:${auth.userId}`, env)],
    // left over from the retired zero-knowledge uploads
    ['DELETE FROM zk_challenge_log WHERE user_id = ?', auth.userId],
    ['DELETE FROM zk_challenges WHERE user_id = ?', auth.userId],
  ]) {
    try { await db.execute({ sql, args: [arg] }); } catch {}
  }
  await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [auth.userId] });

  return Response.json({ deleted: true });
}
