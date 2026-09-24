// POST /api/reshare/:shortId — a new link to the same file, owned by whoever made it.
// The new link points at the original upload's data instead of copying it, so it
// costs almost nothing to make. It's a branch of the link it came from: deleting
// that link (or the original) deletes this one too, and deleting this one takes
// only its own branch with it.
import {
  getFilesClient,
  getEncKey,
  decryptStr,
  encryptStr,
  ensureFileColumns,
  signInRequired
} from '../../_turso.js';

function generateId(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

export async function onRequestPost(context) {
  const { params, env, request } = context;
  const client = getFilesClient(env);
  await ensureFileColumns(client);

  const file = (await client.execute({
    sql: 'SELECT * FROM files WHERE short_id = ? AND is_active = 1',
    args: [params.shortId]
  })).rows[0];

  if (!file) return Response.json({ error: 'File not found' }, { status: 404 });
  if (file.expires_at && new Date(file.expires_at) < new Date()) {
    return Response.json({ error: 'Link expired' }, { status: 410 });
  }
  const denied = await signInRequired(file, request, env);
  if (denied) return denied;

  const newShortId = generateId(8);
  const newDeleteToken = generateId(24);
  const encKey = await getEncKey(env);

  // the name and type are tiny, so they're re-encrypted under the new link's key
  const name = await decryptStr(file.original_filename, encKey, env, params.shortId);
  const mime = await decryptStr(file.mime_type, encKey, env, params.shortId);

  await client.execute({
    sql: `INSERT INTO files (short_id, original_filename, mime_type, size_bytes, file_data, data_short_id,
            expires_at, delete_token, integrity_hash, cluster_id, parent_short_id, uploaded_at,
            compressed, allow_annotations, allow_download, require_account)
          VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    args: [
      newShortId,
      await encryptStr(name, encKey, env, newShortId),
      await encryptStr(mime, encKey, env, newShortId),
      file.size_bytes,
      file.data_short_id || file.short_id,
      file.expires_at,
      newDeleteToken,
      file.integrity_hash || '',
      file.cluster_id || file.short_id,
      params.shortId,
      new Date().toISOString(),
      file.allow_annotations ?? 1,
      file.allow_download ?? 0,
      file.require_account ?? 0
    ]
  });

  const baseUrl = env.BASE_URL || new URL(request.url).origin;
  return Response.json({
    shortId: newShortId,
    shortUrl: `${baseUrl}/r/${newShortId}`,
    deleteToken: newDeleteToken
  });
}
