export async function onRequestPost(context) {
  const { params, env, request } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { deleteToken } = body;
  if (!deleteToken) {
    return Response.json({ error: 'Missing delete token' }, { status: 400 });
  }

  // Find the file — could be the root or a reshare
  const file = await env.DB.prepare(
    'SELECT short_id, source_short_id, delete_token FROM files WHERE short_id = ?'
  ).bind(params.shortId).first();

  if (!file) return Response.json({ error: 'File not found' }, { status: 404 });

  // The root is the one that holds the delete_token
  const rootId = file.source_short_id || file.short_id;

  // Verify token against the root row
  const root = await env.DB.prepare(
    'SELECT delete_token FROM files WHERE short_id = ?'
  ).bind(rootId).first();

  if (!root || root.delete_token !== deleteToken) {
    return Response.json({ error: 'Invalid delete token' }, { status: 403 });
  }

  // Delete the root AND every reshare that points to it
  await env.DB.prepare(
    'DELETE FROM files WHERE short_id = ? OR source_short_id = ?'
  ).bind(rootId, rootId).run();

  return Response.json({ deleted: true });
}
