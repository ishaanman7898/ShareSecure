// GET /api/inbox — files other people sent you: requests waiting for you to
// accept or decline, and ones you accepted. For end-to-end encrypted files the
// name and note are still sealed, and `inbox_key` is the file key sealed to
// your public key; your browser opens them.
import { getDb, verifyToken, getUserTag, decryptStr, ensureFileColumns } from '../../_turso.js';

export async function onRequestGet(context) {
  const { env, request } = context;
  const auth = await verifyToken(request.headers.get('Authorization'), env);
  if (!auth) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const userTag = await getUserTag(auth.userId, env);
  if (!userTag) return Response.json({ files: [] });

  const db = getDb(env);
  await ensureFileColumns(db);
  const rows = (await db.execute({
    sql: `SELECT short_id, original_filename, mime_type, size_bytes, expires_at, delete_token,
                 inbox_status, inbox_note, e2e, inbox_key
          FROM files
          WHERE recipient_user_tag = ?
            AND (is_active = 1 OR inbox_status = 'pending')
            AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          ORDER BY uploaded_at DESC
          LIMIT 50`,
    args: [userTag]
  })).rows;

  // a row that can't be decrypted still shows, just without its name
  const open = (value, id) => decryptStr(value, null, env, id).catch(() => null);
  const files = await Promise.all(rows.map(async row => {
    const pending = row.inbox_status === 'pending';
    return {
      short_id: row.short_id,
      original_filename: await open(row.original_filename, row.short_id),
      mime_type: row.e2e ? null : await open(row.mime_type, row.short_id),
      size_bytes: row.size_bytes,
      expires_at: row.expires_at,
      status: pending ? 'pending' : 'accepted',
      note: row.inbox_note ? await open(row.inbox_note, row.short_id) : null,
      e2e: Boolean(row.e2e),
      inbox_key: row.inbox_key || null,
      // a waiting request can't be opened or deleted by link until it's accepted
      delete_token: pending ? null : row.delete_token,
    };
  }));

  return Response.json({ files });
}
