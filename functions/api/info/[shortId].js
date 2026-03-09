export async function onRequestGet(context) {
  const { params, env } = context;

  const file = await env.DB.prepare(
    'SELECT * FROM files WHERE short_id = ? AND is_active = 1'
  ).bind(params.shortId).first();

  if (!file) return Response.json({ error: 'File not found' }, { status: 404 });

  if (file.expires_at && new Date(file.expires_at) < new Date()) {
    return Response.json({ error: 'Link expired' }, { status: 410 });
  }

  return Response.json({
    filename: file.original_filename,
    size: file.size_bytes,
    mimeType: file.mime_type,
    uploadedAt: file.uploaded_at,
    expiresAt: file.expires_at,
    views: file.download_count
  });
}
