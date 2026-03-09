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

  let file = await env.DB.prepare(
    'SELECT * FROM files WHERE short_id = ? AND is_active = 1'
  ).bind(params.shortId).first();

  if (!file) return new Response('Not found', { status: 404 });

  if (file.expires_at && new Date(file.expires_at) < new Date()) {
    return new Response('Expired', { status: 410 });
  }

  // If this is a reshared link, load file_data from the root source
  if (!file.file_data && file.source_short_id) {
    const source = await env.DB.prepare(
      'SELECT file_data FROM files WHERE short_id = ? AND is_active = 1'
    ).bind(file.source_short_id).first();
    if (!source?.file_data) return new Response('Not found', { status: 404 });
    file = { ...file, file_data: source.file_data };
  }

  return new Response(base64ToBuffer(file.file_data), {
    headers: {
      'Content-Type': file.mime_type,
      'Content-Disposition': `attachment; filename="${file.original_filename}"`,
      'Content-Length': String(file.size_bytes)
    }
  });
}
