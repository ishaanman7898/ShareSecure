import {
  getFilesClient, getAuthClient, verifyToken,
  getEncKey, decryptStr, encryptStr,
  getUserTag, ensureFileColumns
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
  const note = String(body.note || '').trim().slice(0, 140);

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

  await ensureFileColumns(filesClient);

  // Files arrive as requests the recipient has to accept. Cap how many can wait
  // so nobody can flood someone's inbox.
  const waiting = await filesClient.execute({
    sql: `SELECT COUNT(*) AS n FROM files
          WHERE recipient_user_tag = ? AND inbox_status = 'pending'
            AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    args: [recipientTag]
  });
  if (Number(waiting.rows[0].n) >= 20) {
    return Response.json({ error: 'Their inbox is full right now. Try again later.' }, { status: 429 });
  }

  // The copy is stored inactive (is_active = 0) until the recipient accepts it,
  // so every viewing endpoint treats it as not found until then.
  const newShortId = generateId(8);
  const newDeleteToken = generateId(24);
  const encKey = await getEncKey(env);

  // The recipient's copy points at the original upload's data rather than
  // copying it, and hangs off the sender's link: deleting that link withdraws it.
  const name = await decryptStr(file.original_filename, encKey, env, params.shortId);
  const mime = await decryptStr(file.mime_type, encKey, env, params.shortId);

  await filesClient.execute({
    sql: `INSERT INTO files
            (short_id, original_filename, mime_type, size_bytes, file_data, data_short_id, expires_at,
             delete_token, integrity_hash, cluster_id, parent_short_id, uploaded_at,
             compressed, allow_annotations, allow_download, require_account, recipient_user_tag,
             is_active, inbox_status, inbox_note)
          VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, 'pending', ?)`,
    args: [
      newShortId,
      await encryptStr(name, encKey, env, newShortId),
      await encryptStr(mime, encKey, env, newShortId),
      file.size_bytes,
      file.data_short_id || file.short_id,
      file.expires_at, newDeleteToken, file.integrity_hash || '',
      file.cluster_id || file.short_id, params.shortId, new Date().toISOString(),
      file.allow_annotations ?? 1, file.allow_download ?? 0, file.require_account ?? 0,
      recipientTag,
      note ? await encryptStr(note, encKey, env, newShortId) : null
    ]
  });

  return Response.json({ sent: true });
}
