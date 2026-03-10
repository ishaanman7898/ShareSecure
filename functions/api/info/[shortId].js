import { getClientById, globalPurgeExpired } from '../../_turso.js';

export async function onRequestGet(context) {
  const { params, env } = context;
  const client = await getClientById(params.shortId, env);

  // background: purge all expired clusters on every info request
  context.waitUntil(globalPurgeExpired(env, context, params.shortId));

  const res = await client.execute({
    sql: 'SELECT short_id, original_filename, mime_type, size_bytes, uploaded_at, expires_at, download_count, integrity_hash, parent_short_id FROM files WHERE short_id = ? AND is_active = 1',
    args: [params.shortId]
  });

  const file = res.rows[0];

  if (!file) return Response.json({ error: 'File not found' }, { status: 404 });

  if (file.expires_at && new Date(file.expires_at) < new Date()) {
    return Response.json({ error: 'Link expired' }, { status: 410 });
  }

  return Response.json({
    filename: file.original_filename,
    size: file.size_bytes,
    mimeType: file.mime_type,
    uploadedAt: file.uploaded_at,
    expiresAt: file.expires_at,
    views: file.download_count,
    integrityHash: file.integrity_hash,
    isRoot: !file.parent_short_id
  });
}
