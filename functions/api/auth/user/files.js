import { getFilesClient, verifyToken, getUserTag, getEncKey, decryptStr } from '../../../_turso.js';

export async function onRequestGet(context) {
  const { request, env } = context;

  const auth = await verifyToken(request.headers.get('Authorization'), env);
  if (!auth) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const db = getFilesClient(env);
    const userTag = await getUserTag(auth.userId, env);

    // Match new (user_tag) and legacy (user_id) rows so users keep seeing pre-migration uploads.
    const result = await db.execute({
      sql: `SELECT short_id, original_filename, mime_type, size_bytes, uploaded_at, expires_at, download_count, delete_token
            FROM files
            WHERE is_active = 1
              AND (user_tag = ? OR (user_tag IS NULL AND user_id = ?))
              AND (expires_at IS NULL OR expires_at > datetime('now'))
            ORDER BY uploaded_at DESC`,
      args: [userTag, auth.userId]
    });

    const dailyResult = await db.execute({
      sql: `SELECT COUNT(*) as count FROM files
            WHERE (user_tag = ? OR (user_tag IS NULL AND user_id = ?))
              AND uploaded_at > datetime('now', '-1 day')`,
      args: [userTag, auth.userId]
    });

    const encKey = await getEncKey(env);

    // Decrypt filenames and mime types so the dashboard renders real names.
    const files = await Promise.all(result.rows.map(async row => {
      let filename = row.original_filename;
      let mimeType = row.mime_type;
      try { filename = await decryptStr(row.original_filename, encKey, env, row.short_id); } catch {}
      try { mimeType = await decryptStr(row.mime_type, encKey, env, row.short_id); } catch {}
      return {
        short_id: row.short_id,
        original_filename: filename,
        mime_type: mimeType,
        size_bytes: row.size_bytes,
        uploaded_at: row.uploaded_at,
        expires_at: row.expires_at,
        download_count: row.download_count,
        delete_token: row.delete_token
      };
    }));

    return Response.json({ files, dailyUploadCount: Number(dailyResult.rows[0].count) });
  } catch (err) {
    return Response.json({ error: 'Failed to load files' }, { status: 500 });
  }
}
