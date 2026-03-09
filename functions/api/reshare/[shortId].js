function generateId(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

export async function onRequestPost(context) {
  const { params, env, request } = context;

  const file = await env.DB.prepare(
    'SELECT * FROM files WHERE short_id = ? AND is_active = 1'
  ).bind(params.shortId).first();

  if (!file) return Response.json({ error: 'File not found' }, { status: 404 });

  if (file.expires_at && new Date(file.expires_at) < new Date()) {
    return Response.json({ error: 'Link expired' }, { status: 410 });
  }

  // Always point to the root source — never create chains deeper than 1 level
  const rootSourceId = file.source_short_id || file.short_id;

  const newShortId = generateId(8);

  // New row: no file_data, just a pointer to the root file
  await env.DB.prepare(`
    INSERT INTO files (short_id, original_filename, mime_type, size_bytes, file_data, expires_at, source_short_id)
    VALUES (?, ?, ?, ?, '', ?, ?)
  `).bind(newShortId, file.original_filename, file.mime_type, file.size_bytes, file.expires_at, rootSourceId).run();

  const baseUrl = env.BASE_URL || new URL(request.url).origin;

  return Response.json({
    shortId: newShortId,
    shortUrl: `${baseUrl}/r/${newShortId}`
  });
}
