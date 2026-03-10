import { getFilesClient, decodeToken } from '../../_turso.js';

export async function onRequestPost(context) {
  const { params, env, request } = context;

  const client = getFilesClient(env);

  const res = await client.execute({
    sql: 'SELECT * FROM files WHERE short_id = ?',
    args: [params.shortId]
  });

  const file = res.rows[0];
  if (!file) return Response.json({ error: 'File not found' }, { status: 404 });

  // support both auth token (new) and deletetoken (old links)
  const auth = decodeToken(request.headers.get('Authorization'));

  if (auth) {
    // auth-based delete — must be the file owner
    if (file.user_id && String(file.user_id) !== String(auth.userId)) {
      return Response.json({ error: 'Unauthorized' }, { status: 403 });
    }
  } else {
    // fall back to deletetoken
    let body = {};
    try { body = await request.json(); } catch {}
    if (!body.deleteToken || file.delete_token !== body.deleteToken) {
      return Response.json({ error: 'Unauthorized' }, { status: 403 });
    }
  }

  await client.execute({
    sql: 'UPDATE files SET is_active = 0 WHERE short_id = ?',
    args: [params.shortId]
  });

  return Response.json({ deleted: true });
}
