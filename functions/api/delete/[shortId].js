// POST /api/delete/:shortId  { deleteToken? }
// Deletes a link. Allowed for the account that shared it, or anyone holding
// the link's delete key. Deleting the original removes every link to the file;
// deleting any other link removes it and the links shared on from it.
import { getDb, verifyToken, getUserTag, deleteBranch, tokensMatch } from '../../_turso.js';

export async function onRequestPost(context) {
  const { params, env, request } = context;
  const db = getDb(env);

  const file = (await db.execute({
    sql: 'SELECT short_id, user_id, user_tag, delete_token FROM files WHERE short_id = ?', args: [params.shortId]
  })).rows[0];
  if (!file) return Response.json({ error: 'File not found' }, { status: 404 });

  // the account that shared it (older rows store the account id itself)
  const auth = await verifyToken(request.headers.get('Authorization'), env);
  const userTag = auth && await getUserTag(auth.userId, env);
  const isOwner = Boolean(auth) && (file.user_tag
    ? file.user_tag === userTag
    : Boolean(file.user_id) && String(file.user_id) === String(auth.userId));

  // or whoever holds the delete key
  if (!isOwner) {
    const { deleteToken } = await request.json().catch(() => ({}));
    if (!(await tokensMatch(deleteToken, file.delete_token))) {
      return Response.json({ error: 'Unauthorized' }, { status: 403 });
    }
  }

  return Response.json({ deleted: true, scope: await deleteBranch(db, file.short_id, env) });
}
