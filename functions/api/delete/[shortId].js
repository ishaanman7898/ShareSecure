import { getFilesClient, verifyToken, getUserTag } from '../../_turso.js';

export async function onRequestPost(context) {
  const { params, env, request } = context;
  const client = getFilesClient(env);

  const res = await client.execute({
    sql: 'SELECT short_id, user_id, user_tag, delete_token, cluster_id FROM files WHERE short_id = ?',
    args: [params.shortId]
  });

  const file = res.rows[0];
  if (!file) return Response.json({ error: 'File not found' }, { status: 404 });

  const auth = await verifyToken(request.headers.get('Authorization'), env);

  let isOwner = false;
  let authorizedViaToken = false;

  if (auth) {
    const userTag = await getUserTag(auth.userId, env);
    if (file.user_tag && userTag && file.user_tag === userTag) isOwner = true;
    else if (!file.user_tag && file.user_id && String(file.user_id) === String(auth.userId)) isOwner = true;
  }

  if (!isOwner) {
    let body = {};
    try { body = await request.json(); } catch {}
    if (body.deleteToken && file.delete_token === body.deleteToken) authorizedViaToken = true;
  }

  if (!isOwner && !authorizedViaToken) {
    return Response.json({ error: 'Unauthorized' }, { status: 403 });
  }

  // Owner → cascade-delete entire cluster (removes file for everyone)
  // Non-owner with deleteToken → delete only this copy (removes for self only)
  if (isOwner && file.cluster_id) {
    await client.execute({
      sql: 'DELETE FROM files WHERE cluster_id = ?',
      args: [file.cluster_id]
    });
  } else {
    await client.execute({
      sql: 'DELETE FROM files WHERE short_id = ?',
      args: [params.shortId]
    });
  }

  return Response.json({ deleted: true, scope: isOwner ? 'everyone' : 'self' });
}
