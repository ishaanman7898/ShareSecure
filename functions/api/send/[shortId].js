import {
  getFilesClient, getAuthClient, verifyToken,
  getEncKey, decryptField, decryptStr, encryptField, encryptStr,
  getUserTag
} from '../../_turso.js';

function generateId(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

export async function onRequestPost(context) {
  const { params, env, request } = context;

  // sender must be authenticated (rate-limit / anti-spam), but sender identity is NOT stored
  const senderAuth = await verifyToken(request.headers.get('Authorization'), env);
  if (!senderAuth) {
    return Response.json({ error: 'Sign in to send files to other users.' }, { status: 401 });
  }

  let body;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'Invalid body' }, { status: 400 });
  }

  const targetUsername = (body.targetUsername || '').trim();
  if (!targetUsername) {
    return Response.json({ error: 'targetUsername required' }, { status: 400 });
  }

  const authClient = getAuthClient(env);
  const filesClient = getFilesClient(env);

  // resolve target username → userId → recipient user_tag
  const userRes = await authClient.execute({
    sql: 'SELECT id FROM users WHERE username = ?',
    args: [targetUsername]
  });
  if (!userRes.rows[0]) {
    return Response.json({ error: 'User not found' }, { status: 404 });
  }
  const recipientTag = await getUserTag(userRes.rows[0].id, env);
  if (!recipientTag) {
    return Response.json({ error: 'Server misconfigured (TAG_SECRET missing)' }, { status: 503 });
  }

  // fetch source file
  const fileRes = await filesClient.execute({
    sql: 'SELECT * FROM files WHERE short_id = ? AND is_active = 1',
    args: [params.shortId]
  });
  const file = fileRes.rows[0];
  if (!file) return Response.json({ error: 'File not found' }, { status: 404 });
  if (file.expires_at && new Date(file.expires_at) < new Date()) {
    return Response.json({ error: 'File expired' }, { status: 410 });
  }

  // idempotent schema migration
  try {
    await filesClient.execute({ sql: 'ALTER TABLE files ADD COLUMN recipient_user_tag TEXT', args: [] });
  } catch {}

  const newShortId = generateId(8);
  const newDeleteToken = generateId(24);
  const encKey = await getEncKey(env);

  // re-encrypt under new shortId (same pattern as reshare)
  let newFileData = file.file_data;
  let newFilename = file.original_filename;
  let newMime = file.mime_type;

  if (file.file_data && (file.file_data.startsWith('enc:') || file.file_data.startsWith('enc2:'))) {
    try {
      const plain = await decryptField(file.file_data, encKey, env, params.shortId);
      newFileData = await encryptField(plain, encKey, env, newShortId);
    } catch {
      return Response.json({ error: 'Re-encryption failed' }, { status: 500 });
    }
    if (file.original_filename?.startsWith('enc')) {
      const fn = await decryptStr(file.original_filename, encKey, env, params.shortId);
      newFilename = await encryptStr(fn, encKey, env, newShortId);
    }
    if (file.mime_type?.startsWith('enc')) {
      const mt = await decryptStr(file.mime_type, encKey, env, params.shortId);
      newMime = await encryptStr(mt, encKey, env, newShortId);
    }
  }

  await filesClient.execute({
    sql: `INSERT INTO files
            (short_id, original_filename, mime_type, size_bytes, file_data, expires_at,
             delete_token, integrity_hash, cluster_id, parent_short_id, uploaded_at,
             compressed, allow_annotations, allow_download, recipient_user_tag)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newShortId, newFilename, newMime, file.size_bytes, newFileData,
      file.expires_at, newDeleteToken, file.integrity_hash,
      file.cluster_id, null, new Date().toISOString(),
      file.compressed || 0, file.allow_annotations ?? 1, file.allow_download ?? 0,
      recipientTag
    ]
  });

  return Response.json({ sent: true });
}
