import { getClientById, getEncKey, decryptField, decryptStr } from '../../_turso.js';

async function decompress(buffer) {
  const stream = new DecompressionStream('deflate');
  const writer = stream.writable.getWriter();
  writer.write(new Uint8Array(buffer));
  writer.close();
  const chunks = [];
  const reader = stream.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out.buffer;
}

async function verifyIntegrity(buffer, expectedHash) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const computedHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
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
  if (file.expires_at && new Date(file.expires_at) < new Date()) return new Response('Expired', { status: 410 });
  if (!file.file_data) return new Response('File data missing', { status: 404 });

  const encKey = await getEncKey(env);

  const wasEncrypted = file.file_data.startsWith('enc:') || file.file_data.startsWith('enc2:');
  let buffer;
  try {
    buffer = await decryptField(file.file_data, encKey, env, params.shortId);
  } catch {
    return new Response('Decryption failed', { status: 500 });
  }

  if (file.compressed) {
    try { buffer = await decompress(buffer); } catch {
      return new Response('Decompression failed', { status: 500 });
    }
  }

  // AES-GCM auth tag already verified integrity for encrypted files during decryption.
  // Only run SHA-256 check for legacy unencrypted files.
  if (file.integrity_hash && !wasEncrypted) {
    const valid = await verifyIntegrity(buffer, file.integrity_hash);
    if (!valid) return new Response('Integrity check failed — file may have been tampered with', { status: 422 });
  }

  const mimeType = await decryptStr(file.mime_type, encKey, env, params.shortId);
  const filename = await decryptStr(file.original_filename, encKey, env, params.shortId);

  return new Response(buffer, {
    headers: {
      'Content-Type': mimeType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(file.size_bytes)
    }
  });
}
