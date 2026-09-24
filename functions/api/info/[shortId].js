import { getFilesClient, globalPurgeExpired, getEncKey, decryptStr, ensureFileColumns, signInRequired } from '../../_turso.js';

export async function onRequestGet(context) {
  const { params, env, request } = context;
  const client = getFilesClient(env);
  await ensureFileColumns(client);

  context.waitUntil(globalPurgeExpired(env, context));

  const res = await client.execute({
    sql: 'SELECT short_id, original_filename, mime_type, size_bytes, uploaded_at, expires_at, download_count, integrity_hash, parent_short_id, cluster_id, allow_annotations, allow_download, require_account FROM files WHERE short_id = ? AND is_active = 1',
    args: [params.shortId]
  });

  const file = res.rows[0];
  if (!file) return Response.json({ error: 'File not found' }, { status: 404 });
  if (file.expires_at && new Date(file.expires_at) < new Date()) {
    return Response.json({ error: 'Link expired' }, { status: 410 });
  }
  const denied = await signInRequired(file, request, env);
  if (denied) return denied;

  const encKey = await getEncKey(env);
  const filename = await decryptStr(file.original_filename, encKey, env, params.shortId);
  const mimeType = await decryptStr(file.mime_type, encKey, env, params.shortId);

  return Response.json({
    filename,
    size: file.size_bytes,
    mimeType,
    uploadedAt: file.uploaded_at,
    expiresAt: file.expires_at,
    views: file.download_count,
    integrityHash: file.integrity_hash,
    // the original upload: deleting it removes every link to the file
    isRoot: !file.parent_short_id && (!file.cluster_id || file.cluster_id === file.short_id),
    requireAccount: Boolean(file.require_account),
    allowAnnotations: file.allow_annotations ?? 1,
    allowDownload: file.allow_download ?? 0
  });
}
