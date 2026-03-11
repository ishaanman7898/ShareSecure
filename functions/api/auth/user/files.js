import { getFilesClient, decodeToken } from '../../../_turso.js';

export async function onRequestGet(context) {
  const { request, env } = context;

  const auth = decodeToken(request.headers.get('Authorization'));
  if (!auth) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const db = getFilesClient(env);
    const result = await db.execute({
      sql: `SELECT short_id, original_filename, mime_type, size_bytes, uploaded_at, expires_at, download_count
            FROM files WHERE user_id = ? AND is_active = 1 ORDER BY uploaded_at DESC`,
      args: [auth.userId]
    });
    const dailyResult = await db.execute({
      sql: `SELECT COUNT(*) as count FROM files WHERE user_id = ? AND uploaded_at > datetime('now', '-1 day')`,
      args: [auth.userId]
    });
    return Response.json({ files: result.rows, dailyUploadCount: Number(dailyResult.rows[0].count) });
  } catch (err) {
    console.error('Dashboard DB error:', err.message);
    return Response.json({ error: 'Failed to load files' }, { status: 500 });
  }
}
