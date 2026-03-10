import { getShardNode, getTursoClient, globalPurgeExpired } from '../_turso';

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

async function computeHash(buffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
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

  // Clamp to 1 minute minimum, 24 hour maximum — no permanent storage
  const rawHours = parseFloat(formData.get('expires_hours')) || 1;
  const expiresHours = Math.min(Math.max(rawHours, 1 / 60), 24);
  const expires_at = new Date(Date.now() + expiresHours * 3600 * 1000).toISOString();

  const shortId = generateId(8);
  const deleteToken = generateId(24);

  // Create a Zero-Knowledge Cluster ID (derived from the secret deleteToken)
  // This ensures an attacker can't group rows in the DB, but the owner can still wipe all nodes.
  const root_hash = await computeHash(new TextEncoder().encode(deleteToken + ":root"));

  const mimeType = file.type || 'application/octet-stream';

  const buffer = await file.arrayBuffer();
  const file_data = bufferToBase64(buffer);

  // Compute SHA-256 integrity hash for tamper detection
  const integrity_hash = await computeHash(buffer);

  // Pick a Turso node based on shortId shard
  const nodeNum = getShardNode(shortId, parseInt(env.TURSO_NODES || '3'));
  const client = await getTursoClient(nodeNum, env);

  // Purge all expired files on each upload (background cluster-wide cleanup)
  context.waitUntil(globalPurgeExpired(env, context, shortId));

  await client.execute({
    sql: `INSERT INTO files (short_id, original_filename, mime_type, size_bytes, file_data, expires_at, delete_token, integrity_hash, cluster_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [shortId, file.name, mimeType, file.size, file_data, expires_at, deleteToken, integrity_hash, root_hash]
  });

  const baseUrl = env.BASE_URL || new URL(request.url).origin;

  return Response.json({
    shortId,
    shortUrl: `${baseUrl}/r/${shortId}`,
    filename: file.name,
    size: file.size,
    expiresAt: expires_at,
    deleteToken,
    integrityHash: integrity_hash,
    node: nodeNum
  });
}
