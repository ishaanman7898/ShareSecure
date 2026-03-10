import { getFilesClient, globalPurgeExpired, decodeToken } from '../_turso.js';

const MAX_BYTES = 10 * 1024 * 1024; // 10MB

function generateId(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    str += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(str);
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

  // Check daily upload limit for authenticated users
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

  const shortId = generateId(8);
  const deleteToken = generateId(24);
  const mimeType = file.type || 'application/octet-stream';

  const buffer = await file.arrayBuffer();
  const file_data = bufferToBase64(buffer);

  context.waitUntil(globalPurgeExpired(env, context, shortId));

  await client.execute({
    sql: `INSERT INTO files (short_id, original_filename, mime_type, size_bytes, file_data, expires_at, delete_token, user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [shortId, file.name, mimeType, file.size, file_data, expires_at, deleteToken, auth ? auth.userId : null]
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
