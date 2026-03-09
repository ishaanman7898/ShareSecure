function base64ToBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export async function onRequestGet(context) {
  const { params, env } = context;

  const file = await env.DB.prepare(
    'SELECT * FROM files WHERE short_id = ? AND is_active = 1'
  ).bind(params.shortId).first();

  if (!file) return new Response('Not found', { status: 404 });

  if (file.expires_at && new Date(file.expires_at) < new Date()) {
    return new Response('Expired', { status: 410 });
  }

  context.waitUntil(
    env.DB.prepare('UPDATE files SET download_count = download_count + 1 WHERE short_id = ?')
      .bind(params.shortId).run()
  );

  const buffer = base64ToBuffer(file.file_data);

  return new Response(buffer, {
    headers: {
      'Content-Type': file.mime_type,
      'Content-Disposition': `inline; filename="${file.original_filename}"`,
      'Content-Length': String(file.size_bytes),
      'Cache-Control': 'no-store'
    }
  });
}
