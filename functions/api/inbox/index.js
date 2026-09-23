import { getFilesClient, verifyToken, getUserTag, getEncKey, decryptStr } from '../../_turso.js';

export async function onRequestGet(context) {
  const { env, request } = context;

  const auth = await verifyToken(request.headers.get('Authorization'), env);
  if (!auth) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const userTag = await getUserTag(auth.userId, env);
  if (!userTag) return Response.json({ files: [] });

  const client = getFilesClient(env);

  // idempotent schema migrations
  for (const sql of [
    'ALTER TABLE files ADD COLUMN recipient_user_tag TEXT',
    'ALTER TABLE files ADD COLUMN inbox_status TEXT',
    'ALTER TABLE files ADD COLUMN inbox_note TEXT',
  ]) {
    try { await client.execute({ sql, args: [] }); } catch {}
  }

  const res = await client.execute({
    sql: `SELECT short_id, original_filename, mime_type, size_bytes, expires_at, delete_token, uploaded_at,
                 inbox_status, inbox_note
          FROM files
          WHERE recipient_user_tag = ?
            AND (is_active = 1 OR inbox_status = 'pending')
            AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          ORDER BY uploaded_at DESC
          LIMIT 50`,
    args: [userTag]
  });

  const encKey = await getEncKey(env);
  const files = await Promise.all(res.rows.map(async row => {
    let filename = row.original_filename;
    let mimeType = row.mime_type;
    let note = null;
    try { filename = await decryptStr(row.original_filename, encKey, env, row.short_id); } catch {}
    try { mimeType = await decryptStr(row.mime_type, encKey, env, row.short_id); } catch {}
    if (row.inbox_note) { try { note = await decryptStr(row.inbox_note, encKey, env, row.short_id); } catch {} }
    const pending = row.inbox_status === 'pending';
    return {
      short_id: row.short_id,
      original_filename: filename,
      mime_type: mimeType,
      size_bytes: row.size_bytes,
      expires_at: row.expires_at,
      status: pending ? 'pending' : 'accepted',
      note,
      // a pending file can't be opened or deleted by link until it's accepted
      delete_token: pending ? null : row.delete_token,
    };
  }));

  return Response.json({ files });
}
