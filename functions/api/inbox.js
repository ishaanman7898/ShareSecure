import { getFilesClient, verifyToken, getUserTag, getEncKey, decryptStr } from '../_turso.js';

export async function onRequestGet(context) {
  const { env, request } = context;

  const auth = await verifyToken(request.headers.get('Authorization'), env);
  if (!auth) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const userTag = await getUserTag(auth.userId, env);
  if (!userTag) return Response.json({ files: [] });

  const client = getFilesClient(env);

  // idempotent schema migration
  try {
    await client.execute({ sql: 'ALTER TABLE files ADD COLUMN recipient_user_tag TEXT', args: [] });
  } catch {}

  const res = await client.execute({
    sql: `SELECT short_id, original_filename, mime_type, size_bytes, expires_at, delete_token, uploaded_at
          FROM files
          WHERE recipient_user_tag = ?
            AND is_active = 1
            AND (expires_at IS NULL OR expires_at > datetime('now'))
          ORDER BY uploaded_at DESC
          LIMIT 50`,
    args: [userTag]
  });

  const encKey = await getEncKey(env);
  const files = await Promise.all(res.rows.map(async row => {
    let filename = row.original_filename;
    let mimeType = row.mime_type;
    try { filename = await decryptStr(row.original_filename, encKey, env, row.short_id); } catch {}
    try { mimeType = await decryptStr(row.mime_type, encKey, env, row.short_id); } catch {}
    return {
      short_id: row.short_id,
      original_filename: filename,
      mime_type: mimeType,
      size_bytes: row.size_bytes,
      expires_at: row.expires_at,
      delete_token: row.delete_token,
    };
  }));

  return Response.json({ files });
}
