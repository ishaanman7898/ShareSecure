import { getTursoClient, getShardNode } from '../../_turso.js';

function generateId(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

export async function onRequestPost(context) {
  const { params, env, request } = context;

  // find the original file in its shard node
  const sourceNode = getShardNode(params.shortId, parseInt(env.TURSO_NODES || '3'));
  const sourceClient = await getTursoClient(sourceNode, env);

  const res = await sourceClient.execute({
    sql: 'SELECT * FROM files WHERE short_id = ? AND is_active = 1',
    args: [params.shortId]
  });

  const file = res.rows[0];

  if (!file) return Response.json({ error: 'File not found' }, { status: 404 });

  if (file.expires_at && new Date(file.expires_at) < new Date()) {
    return Response.json({ error: 'Link expired' }, { status: 410 });
  }

  // generate a fresh id for the reshare
  const newShortId = generateId(8);
  const newDeleteToken = generateId(24);
  const targetNode = getShardNode(newShortId, parseInt(env.TURSO_NODES || '3'));
  const targetClient = await getTursoClient(targetNode, env);

  // every reshare row gets its own full copy of data, even across nodes.
  // this makes nodes independent and rows identical.
  await targetClient.execute({
    sql: `INSERT INTO files (short_id, original_filename, mime_type, size_bytes, file_data, expires_at, source_short_id, delete_token, integrity_hash, cluster_id, parent_short_id, uploaded_at, compressed, allow_annotations, allow_download)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newShortId,
      file.original_filename,
      file.mime_type,
      file.size_bytes,
      file.file_data,
      file.expires_at,
      null,
      newDeleteToken,
      file.integrity_hash,
      file.cluster_id,
      params.shortId,
      new Date().toISOString(),
      file.compressed || 0,
      file.allow_annotations ?? 1,
      file.allow_download ?? 0
    ]
  });

  const baseUrl = env.BASE_URL || new URL(request.url).origin;

  return Response.json({
    shortId: newShortId,
    shortUrl: `${baseUrl}/r/${newShortId}`,
    deleteToken: newDeleteToken,
    node: targetNode
  });
}
