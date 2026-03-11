import { getFilesClient, decodeToken } from '../../_turso.js';

export async function onRequestPost(context) {
  const { params, env, request } = context;

  const client = getFilesClient(env);

  const res = await client.execute({
    sql: 'SELECT short_id, user_id, delete_token, cluster_id FROM files WHERE short_id = ?',
    args: [params.shortId]
  });

  const file = res.rows[0];
  if (!file) return Response.json({ error: 'File not found' }, { status: 404 });

  const auth = decodeToken(request.headers.get('Authorization'));

  if (auth) {
    if (file.user_id && String(file.user_id) !== String(auth.userId)) {
      return Response.json({ error: 'Unauthorized' }, { status: 403 });
    }
  } else {
    let body = {};
    try { body = await request.json(); } catch {}
    if (!body.deleteToken || file.delete_token !== body.deleteToken) {
      return Response.json({ error: 'Unauthorized' }, { status: 403 });
    }
  }

  // cascade delete — wipe this file and every reshare in the same cluster
  if (file.cluster_id) {
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

  return Response.json({ deleted: true });
}
