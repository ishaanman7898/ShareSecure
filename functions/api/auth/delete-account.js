// POST /api/auth/delete-account  { access_code }
// Deletes the signed-in account and everything the server can tie to it: files
// tagged to the account, files waiting in its inbox, its upload records, its
// ZK commitment and its assistant (MCP) tokens. Private (ZK) uploads carry no
// account link by design, so the browser deletes those itself with the delete
// keys it holds before calling this.

import { verifyToken, getAuthClient, getFilesClient, getUserTag, checkAccessCode } from '../../_turso.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = await verifyToken(request.headers.get('Authorization'), env);
  if (!auth) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  let password;
  try {
    ({ access_code: password } = await request.json());
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const authDb = getAuthClient(env);
  const user = (await authDb.execute({ sql: 'SELECT id, access_code FROM users WHERE id = ?', args: [auth.userId] })).rows[0];
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!password || !(await checkAccessCode(String(password), user.access_code, env)).ok) {
    return Response.json({ error: 'Wrong password' }, { status: 403 });
  }

  const userTag = await getUserTag(auth.userId, env);
  const files = getFilesClient(env);
  // every link to the account's uploads, including ones other people reshared
  await files.execute({
    sql: `DELETE FROM files WHERE cluster_id IN (
             SELECT cluster_id FROM files WHERE cluster_id IS NOT NULL AND (user_tag = ? OR (user_tag IS NULL AND user_id = ?))
           ) OR user_tag = ? OR (user_tag IS NULL AND user_id = ?)`,
    args: [userTag, auth.userId, userTag, auth.userId]
  });
  // the inbox column only exists once someone has sent a file
  try {
    await files.execute({ sql: 'DELETE FROM files WHERE recipient_user_tag = ?', args: [userTag] });
  } catch {}

  for (const sql of [
    'DELETE FROM zk_challenge_log WHERE user_id = ?',
    'DELETE FROM zk_challenges WHERE user_id = ?',
    'DELETE FROM api_tokens WHERE user_id = ?',
  ]) {
    try { await authDb.execute({ sql, args: [auth.userId] }); } catch { /* table not created yet */ }
  }
  await authDb.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [auth.userId] });

  return Response.json({ deleted: true });
}
