import { getFilesClient, globalPurgeExpired, decodeToken, getEncKey, encryptField, encryptStr } from '../_turso.js';

const MAX_BYTES = 10 * 1024 * 1024; // 10MB

function generateId(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

async function sha256hex(buffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function compress(buffer) {
  const stream = new CompressionStream('deflate');
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

export async function onRequestPost(context) {
  const { request, env } = context;

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: 'Invalid form data' }, { status: 400 });
  }

  const file = formData.get('file');
  if (!file || typeof file === 'string') {
    return Response.json({ error: 'No file provided' }, { status: 400 });
  }

  if (file.size > MAX_BYTES) {
    return Response.json({ error: 'File too large. Max 10MB.' }, { status: 413 });
  }

  const auth = decodeToken(request.headers.get('Authorization'));
  const client = getFilesClient(env);

  // one-time schema migrations — safe to run every request (idempotent)
  for (const col of [
    'ALTER TABLE files ADD COLUMN allow_annotations INTEGER DEFAULT 1',
    'ALTER TABLE files ADD COLUMN allow_download INTEGER DEFAULT 0',
  ]) { try { await client.execute({ sql: col, args: [] }); } catch {} }

  if (auth) {
    const recentUploads = await client.execute({
      sql: `SELECT COUNT(*) as count FROM files WHERE user_id = ? AND uploaded_at > datetime('now', '-1 day')`,
      args: [auth.userId]
    });
    if (recentUploads.rows[0].count >= 5) {
      return Response.json({ error: 'Upload limit reached (5 files per 24h)' }, { status: 429 });
    }
  }

  const rawHours = parseFloat(formData.get('expires_hours')) || 1;
  const expiresHours = Math.max(rawHours, 1 / 60);
  const expires_at = new Date(Date.now() + expiresHours * 3600 * 1000).toISOString();

  const allow_annotations = formData.get('allow_annotations') === '1' ? 1 : 0;
  const allow_download = formData.get('allow_download') === '1' ? 1 : 0;

  const shortId = generateId(8);
  const deleteToken = generateId(24);
  const mimeType = file.type || 'application/octet-stream';

  const buffer = await file.arrayBuffer();

  // hash the raw bytes BEFORE compress/encrypt so we can verify after decrypt
  const integrity_hash = await sha256hex(buffer);

  // compress then encrypt
  const compressed = await compress(buffer);
  const encKey = await getEncKey(env);
  const file_data = await encryptField(compressed, encKey);

  // encrypt metadata strings
  const enc_filename = await encryptStr(file.name, encKey);
  const enc_mime = await encryptStr(mimeType, encKey);

  context.waitUntil(globalPurgeExpired(env, context));

  await client.execute({
    sql: `INSERT INTO files (short_id, original_filename, mime_type, size_bytes, file_data, expires_at, delete_token, user_id, integrity_hash, compressed, cluster_id, allow_annotations, allow_download)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    args: [shortId, enc_filename, enc_mime, file.size, file_data, expires_at, deleteToken, auth ? auth.userId : null, integrity_hash, shortId, allow_annotations, allow_download]
  });

  const baseUrl = env.BASE_URL || new URL(request.url).origin;

  return Response.json({
    shortId,
    shortUrl: `${baseUrl}/r/${shortId}`,
    filename: file.name,
    size: file.size,
    expiresAt: expires_at,
    deleteToken
  });
}
