// GET /api/auth/user/files — the signed-in account's live shares, for "Your
// shares". End-to-end encrypted ones come with their name still sealed and
// `owner_key` (the file key sealed to you), which your browser opens.
import { getDb, verifyToken, getUserTag, decryptStr, countUploadsToday, ensureFileColumns } from '../../../_turso.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const auth = await verifyToken(request.headers.get('Authorization'), env);
  if (!auth) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const db = getDb(env);
    await ensureFileColumns(db);
    const userTag = await getUserTag(auth.userId, env);
    // user_id only matches rows from before accounts were tagged
    const rows = (await db.execute({
      sql: `SELECT short_id, original_filename, mime_type, size_bytes, uploaded_at, expires_at, download_count,
                   delete_token, e2e, owner_key
            FROM files
            WHERE is_active = 1
              AND (user_tag = ? OR (user_tag IS NULL AND user_id = ?))
              AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            ORDER BY uploaded_at DESC`,
      args: [userTag, auth.userId]
    })).rows;

    const open = (value, id) => decryptStr(value, null, env, id).catch(() => value);
    const files = await Promise.all(rows.map(async row => ({
      short_id: row.short_id,
      original_filename: await open(row.original_filename, row.short_id),
      mime_type: row.e2e ? null : await open(row.mime_type, row.short_id),
      size_bytes: row.size_bytes,
      uploaded_at: row.uploaded_at,
      expires_at: row.expires_at,
      download_count: row.download_count,
      delete_token: row.delete_token,
      e2e: Boolean(row.e2e),
      owner_key: row.owner_key || null,
    })));

    return Response.json({ files, dailyUploadCount: await countUploadsToday(auth.userId, userTag, env) });
  } catch {
    return Response.json({ error: 'Failed to load files' }, { status: 500 });
  }
}
