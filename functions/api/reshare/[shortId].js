import {
  getFilesClient,
  getEncKey,
  decryptField,
  decryptStr,
  encryptField,
  encryptStr
} from '../../_turso.js';

function generateId(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

export async function onRequestPost(context) {
  const { params, env, request } = context;

  const client = getFilesClient(env);

  const res = await client.execute({
    sql: 'SELECT * FROM files WHERE short_id = ? AND is_active = 1',
    args: [params.shortId]
  });

  const file = res.rows[0];
  if (!file) return Response.json({ error: 'File not found' }, { status: 404 });
  if (file.expires_at && new Date(file.expires_at) < new Date()) {
    return Response.json({ error: 'Link expired' }, { status: 410 });
  }

  const newShortId = generateId(8);
  const newDeleteToken = generateId(24);

  const encKey = await getEncKey(env);

  // Re-encrypt under the new shortId so per-file key derivation stays consistent.
  // Legacy 'enc:' rows decrypt with master key; we always re-encrypt as 'enc2:' going forward.
  let newFileData = file.file_data;
  let newFilename = file.original_filename;
  let newMime = file.mime_type;

  if (file.file_data && (file.file_data.startsWith('enc:') || file.file_data.startsWith('enc2:'))) {
    try {
      const plain = await decryptField(file.file_data, encKey, env, params.shortId);
      newFileData = await encryptField(plain, encKey, env, newShortId);
    } catch {
      return Response.json({ error: 'Reshare failed: source decrypt error' }, { status: 500 });
    }
    if (file.original_filename && (file.original_filename.startsWith('enc:') || file.original_filename.startsWith('enc2:'))) {
      const fn = await decryptStr(file.original_filename, encKey, env, params.shortId);
      newFilename = await encryptStr(fn, encKey, env, newShortId);
    }
    if (file.mime_type && (file.mime_type.startsWith('enc:') || file.mime_type.startsWith('enc2:'))) {
      const mt = await decryptStr(file.mime_type, encKey, env, params.shortId);
      newMime = await encryptStr(mt, encKey, env, newShortId);
    }
  }

  await client.execute({
    sql: `INSERT INTO files (short_id, original_filename, mime_type, size_bytes, file_data, expires_at, delete_token, integrity_hash, cluster_id, parent_short_id, uploaded_at, compressed, allow_annotations, allow_download)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newShortId,
      newFilename,
      newMime,
      file.size_bytes,
      newFileData,
      file.expires_at,
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
    deleteToken: newDeleteToken
  });
}
