import { getClientById } from '../../_turso.js';

function base64ToBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function verifyIntegrity(buffer, expectedHash) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = new Uint8Array(hashBuffer);
  const computedHash = Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
  return computedHash === expectedHash;
}

export async function onRequestGet(context) {
  const { params, env } = context;
  const client = await getClientById(params.shortId, env);

  const res = await client.execute({
    sql: 'SELECT * FROM files WHERE short_id = ? AND is_active = 1',
    args: [params.shortId]
  });

  const file = res.rows[0];

  if (!file) return new Response('Not found', { status: 404 });

  if (file.expires_at && new Date(file.expires_at) < new Date()) {
    return new Response('Expired', { status: 410 });
  }

  if (!file.file_data) {
    return new Response('File data missing', { status: 404 });
  }

  const buffer = base64ToBuffer(file.file_data);

  // Verify integrity hash — tamper detection
  if (file.integrity_hash) {
    const valid = await verifyIntegrity(buffer, file.integrity_hash);
    if (!valid) {
      return new Response('Integrity check failed — file may have been tampered with', { status: 422 });
    }
  }

  return new Response(buffer, {
    headers: {
      'Content-Type': file.mime_type,
      'Content-Disposition': `attachment; filename="${file.original_filename}"`,
      'Content-Length': String(file.size_bytes)
    }
  });
}
