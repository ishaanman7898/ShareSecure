import { getFilesClient, verifyToken, getUserTag, deleteBranch, tokensMatch } from '../../_turso.js';

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
    if (await tokensMatch(body?.deleteToken, file.delete_token)) authorizedViaToken = true;
  }

  if (!isOwner && !authorizedViaToken) {
    return Response.json({ error: 'Unauthorized' }, { status: 403 });
  }

  // The original upload → every link to the file goes. Any other link → that
  // link and the ones shared onward from it; the original and other branches stay.
  const scope = await deleteBranch(client, file);
  return Response.json({ deleted: true, scope });
}
