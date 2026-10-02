// Sends a link's file. Used by /api/raw (shown in the viewer) and
// /api/download (saved as a file).
import { getDb, purgeExpired, decryptStr, ensureFileColumns, loadFileBytes, signInRequired, findLiveFile } from './_turso.js';

// RFC 6266: a plain ASCII name, plus the real one for browsers that read it
function contentDisposition(type, filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// Only the types uploads accept are sent as themselves. Text is plain UTF-8
// text in the viewer (never HTML), and anything else is just bytes.
const SERVED_TYPES = new Set([
  'application/pdf', 'image/png', 'image/jpeg', 'image/jpg',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv']);

function contentType(type, disposition) {
  if (TEXT_TYPES.has(type)) return `${disposition === 'inline' ? 'text/plain' : type}; charset=utf-8`;
  return SERVED_TYPES.has(type) ? type : 'application/octet-stream';
}

export async function serveFile(context, { disposition }) {
  const { params, env, request } = context;
  const db = getDb(env);
  await ensureFileColumns(db);
  purgeExpired(env, context);

  const file = await findLiveFile(db, params.shortId);
  if (!file) return new Response('Not found', { status: 404 });
  if (file.expired) return new Response('Expired', { status: 410 });

  const denied = await signInRequired(file, request, env);
  if (denied) return denied;
  if (disposition === 'attachment' && !file.allow_download) {
    return new Response('Downloads are turned off for this file', { status: 403 });
  }

  let loaded;
  try { loaded = await loadFileBytes(db, file, env); } catch {
    return new Response('Decryption failed', { status: 500 });
  }
  if (!loaded) return new Response('File data missing', { status: 404 });

  // count views, not downloads
  if (disposition === 'inline') {
    context.waitUntil(db.execute({
      sql: 'UPDATE files SET download_count = download_count + 1 WHERE short_id = ?', args: [params.shortId]
    }).catch(() => {}));
  }

  // An end-to-end encrypted file is a sealed box to the server: the browser
  // opens it and picks the name and type.
  const type = loaded.sealed ? 'application/octet-stream' : await decryptStr(file.mime_type, null, env, params.shortId);
  const name = loaded.sealed ? 'sealed.bin' : await decryptStr(file.original_filename, null, env, params.shortId);

  return new Response(loaded.buffer, {
    headers: {
      'Content-Type': contentType(type, disposition),
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': contentDisposition(disposition, name),
      'Content-Length': String(loaded.buffer.byteLength),
      'Cache-Control': 'no-store',
    },
  });
}
