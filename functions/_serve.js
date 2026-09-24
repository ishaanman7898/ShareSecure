// Shared by /api/raw (shown in the viewer) and /api/download (saved as a file).
import {
  getFilesClient, globalPurgeExpired, getEncKey, decryptStr,
  ensureFileColumns, loadFileBytes, signInRequired
} from './_turso.js';

async function sha256hex(buffer) {
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

// RFC 6266: a plain ASCII fallback plus the real name for browsers that read it
function contentDisposition(type, filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function serveFile(context, { disposition }) {
  const { params, env, request } = context;
  const client = getFilesClient(env);
  await ensureFileColumns(client);
  context.waitUntil(globalPurgeExpired(env, context));

  const file = (await client.execute({
    sql: 'SELECT * FROM files WHERE short_id = ? AND is_active = 1',
    args: [params.shortId]
  })).rows[0];
  if (!file) return new Response('Not found', { status: 404 });
  if (file.expires_at && new Date(file.expires_at) < new Date()) return new Response('Expired', { status: 410 });

  const denied = await signInRequired(file, request, env);
  if (denied) return denied;
  if (disposition === 'attachment' && !file.allow_download) {
    return new Response('Downloads are turned off for this file', { status: 403 });
  }

  let loaded;
  try {
    loaded = await loadFileBytes(client, file, env);
  } catch {
    return new Response('Decryption failed', { status: 500 });
  }
  if (!loaded) return new Response('File data missing', { status: 404 });

  // AES-GCM's tag already proved encrypted files intact; only unencrypted
  // installs need the separate hash check
  if (file.integrity_hash && !loaded.wasEncrypted) {
    if ((await sha256hex(loaded.buffer)) !== file.integrity_hash) {
      return new Response('Integrity check failed — file may have been tampered with', { status: 422 });
    }
  }

  const encKey = await getEncKey(env);
  const mimeType = await decryptStr(file.mime_type, encKey, env, params.shortId);
  const filename = await decryptStr(file.original_filename, encKey, env, params.shortId);

  if (disposition === 'inline') {
    context.waitUntil(client.execute({
      sql: 'UPDATE files SET download_count = download_count + 1 WHERE short_id = ?',
      args: [params.shortId]
    }).catch(() => {}));
  }

  return new Response(loaded.buffer, {
    headers: {
      'Content-Type': mimeType,
      'Content-Disposition': contentDisposition(disposition, filename),
      'Content-Length': String(loaded.buffer.byteLength),
      'Cache-Control': 'no-store',
    },
  });
}
