import {
  getFilesClient,
  globalPurgeExpired,
  verifyToken,
  getEncKey,
  encryptField,
  encryptStr,
  getUserTag
} from '../_turso.js';
import { verifyProof as zkVerifyProof } from '../_zk.js';

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

  // ZK-auth path: if X-ZK-* headers are present, verify the proof and accept
  // the upload WITHOUT any user identifier (no user_tag, no user_id) — the
  // server confirms the uploader is a registered user but cannot tell which one.
  const zkProof     = request.headers.get('X-ZK-Proof');
  const zkNullifier = request.headers.get('X-ZK-Nullifier');
  const zkNonce     = request.headers.get('X-ZK-Nonce');
  const usingZK     = Boolean(zkProof && zkNullifier && zkNonce);

  let zkValidated = false;
  if (usingZK) {
    const result = await zkVerifyProof({ proof: zkProof, nullifier: zkNullifier, nonce: zkNonce }, env);
    if (!result.valid) {
      return Response.json({ error: `ZK proof rejected: ${result.error}` }, { status: 401 });
    }
    zkValidated = true;
  }

  const auth = await verifyToken(request.headers.get('Authorization'), env);
  const client = getFilesClient(env);

  // one-time schema migrations — safe to run every request (idempotent)
  for (const col of [
    'ALTER TABLE files ADD COLUMN allow_annotations INTEGER DEFAULT 1',
    'ALTER TABLE files ADD COLUMN allow_download INTEGER DEFAULT 0',
    'ALTER TABLE files ADD COLUMN user_tag TEXT'
  ]) { try { await client.execute({ sql: col, args: [] }); } catch {} }

  // When ZK-authenticated, we DON'T store user_tag — the nullifier already
  // proved the uploader is a registered user, and we want zero identity link.
  const userTag = (zkValidated || !auth) ? null : await getUserTag(auth.userId, env);

  if (auth && !zkValidated) {
    // count by both user_tag (new) and user_id (legacy rows) so the limit holds across the migration
    const recentUploads = await client.execute({
      sql: `SELECT COUNT(*) as count FROM files
            WHERE (user_tag = ? OR (user_tag IS NULL AND user_id = ?))
              AND uploaded_at > datetime('now', '-1 day')`,
      args: [userTag, auth.userId]
    });
    if (recentUploads.rows[0].count >= 5) {
      return Response.json({ error: 'Upload limit reached (5 files per 24h)' }, { status: 429 });
    }
  }

  const rawHours = parseFloat(formData.get('expires_hours')) || 1;
  const expiresHours = Math.min(Math.max(rawHours, 1 / 60), 720);
  const expires_at = new Date(Date.now() + expiresHours * 3600 * 1000).toISOString();

  const allow_annotations = formData.get('allow_annotations') === '1' ? 1 : 0;
  const allow_download = formData.get('allow_download') === '1' ? 1 : 0;

  const shortId = generateId(8);
  const deleteToken = generateId(24);
  const mimeType = file.type || 'application/octet-stream';

  // Use custom display_name if provided, otherwise fall back to original filename
  const rawDisplayName = formData.get('display_name');
  const displayName = (rawDisplayName && rawDisplayName.toString().trim())
    ? rawDisplayName.toString().trim()
    : file.name;

  const buffer = await file.arrayBuffer();

  // hash the raw bytes BEFORE compress/encrypt so we can verify after decrypt
  const integrity_hash = await sha256hex(buffer);

  // compress then encrypt with per-file derived key (HKDF salt = shortId)
  const compressed = await compress(buffer);
  const encKey = await getEncKey(env);
  const file_data = await encryptField(compressed, encKey, env, shortId);

  // encrypt metadata strings with same per-file key for consistency
  const enc_filename = await encryptStr(displayName, encKey, env, shortId);
  const enc_mime = await encryptStr(mimeType, encKey, env, shortId);

  context.waitUntil(globalPurgeExpired(env, context));

  // Privacy: store user_tag (HMAC pseudonym), not raw user_id, for new rows.
  // Legacy user_id column kept null on new uploads — eliminates the direct DB→account link.
  await client.execute({
    sql: `INSERT INTO files (short_id, original_filename, mime_type, size_bytes, file_data, expires_at, delete_token, user_id, user_tag, integrity_hash, compressed, cluster_id, allow_annotations, allow_download)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    args: [shortId, enc_filename, enc_mime, file.size, file_data, expires_at, deleteToken, null, userTag, integrity_hash, shortId, allow_annotations, allow_download]
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
