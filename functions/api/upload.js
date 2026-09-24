import {
  getFilesClient,
  globalPurgeExpired,
  verifyToken,
  getEncKey,
  encryptField,
  encryptStr,
  getUserTag,
  countUploadsToday,
  ensureFileColumns
} from '../_turso.js';
import { verifyProof as zkVerifyProof } from '../_zk.js';

const MAX_BYTES = 10 * 1024 * 1024; // 10MB

function generateId(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// PDF, PNG, JPEG and DOCX (a ZIP) by their signatures; anything else is refused
function detectType(b) {
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b[0] === 0x50 && b[1] === 0x4B && b[2] === 0x03 && b[3] === 0x04) return DOCX_MIME;
  return null;
}

async function sha256hex(buffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
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

  // the type comes from the file's first bytes, never its name or the browser's claim
  const detectedMime = detectType(new Uint8Array(await file.slice(0, 8).arrayBuffer()));
  if (!detectedMime) {
    return Response.json({ error: 'Only PDF, DOCX, PNG and JPG files can be shared.' }, { status: 415 });
  }

  // ZK-auth path: if zk_proof/zk_nullifier/zk_nonce form fields are present,
  // verify the UniGroth proof and accept the upload WITHOUT any user identifier
  // (no user_tag, no user_id). The server confirms the uploader is a registered
  // user but cannot tell which one.
  const zkProofRaw  = formData.get('zk_proof');
  const zkNullifier = formData.get('zk_nullifier');
  const zkNonce     = formData.get('zk_nonce');
  const usingZK     = Boolean(zkProofRaw && zkNullifier && zkNonce);

  let zkValidated = false;
  if (usingZK) {
    let zkProof;
    try {
      zkProof = JSON.parse(zkProofRaw.toString());
    } catch {
      return Response.json({ error: 'ZK proof malformed (invalid JSON)' }, { status: 400 });
    }
    const result = await zkVerifyProof(
      { proof: zkProof, nullifier: zkNullifier.toString(), nonce: zkNonce.toString() },
      env
    );
    if (!result.valid) {
      // 403, not 401: the session is fine, only the proof failed. The app retries
      // with its normal sign-in instead of treating this as being signed out.
      return Response.json({ error: `ZK proof rejected: ${result.error}`, code: 'zk_rejected' }, { status: 403 });
    }
    zkValidated = true;
  }

  const auth = await verifyToken(request.headers.get('Authorization'), env);
  const client = getFilesClient(env);

  await ensureFileColumns(client);

  // When ZK-authenticated, we DON'T store user_tag — the nullifier already
  // proved the uploader is a registered user, and we want zero identity link.
  const userTag = (zkValidated || !auth) ? null : await getUserTag(auth.userId, env);

  if (auth && !zkValidated) {
    // includes ZK uploads, so falling back from ZK can't double the daily limit
    if (await countUploadsToday(auth.userId, userTag, env) >= 5) {
      return Response.json({ error: 'Upload limit reached (5 files per 24h)' }, { status: 429 });
    }
  }

  const rawHours = parseFloat(formData.get('expires_hours')) || 1;
  const expiresHours = Math.min(Math.max(rawHours, 1 / 60), 240); // max 10 days
  const expires_at = new Date(Date.now() + expiresHours * 3600 * 1000).toISOString();

  const allow_annotations = formData.get('allow_annotations') === '1' ? 1 : 0;
  const allow_download = formData.get('allow_download') === '1' ? 1 : 0;
  const require_account = formData.get('require_account') === '1' ? 1 : 0;

  const shortId = generateId(8);
  const deleteToken = generateId(24);
  const mimeType = detectedMime;

  // Use custom display_name if provided, otherwise fall back to original filename
  const rawDisplayName = formData.get('display_name');
  const displayName = (rawDisplayName && rawDisplayName.toString().trim())
    ? rawDisplayName.toString().trim()
    : file.name;

  const buffer = await file.arrayBuffer();

  // Encrypt with the per-file derived key (HKDF salt = shortId). No compression:
  // PDF, DOCX, PNG and JPEG are already compressed, and deflating them only
  // burned CPU. AES-GCM's tag detects tampering, so only unencrypted installs
  // keep a separate content hash.
  const encKey = await getEncKey(env);
  const integrity_hash = encKey ? '' : await sha256hex(buffer);
  const file_data = await encryptField(buffer, encKey, env, shortId);

  // encrypt metadata strings with same per-file key for consistency
  const enc_filename = await encryptStr(displayName, encKey, env, shortId);
  const enc_mime = await encryptStr(mimeType, encKey, env, shortId);

  context.waitUntil(globalPurgeExpired(env, context));

  // Privacy: store user_tag (HMAC pseudonym), not raw user_id, for new rows.
  // Legacy user_id column kept null on new uploads — eliminates the direct DB→account link.
  await client.execute({
    sql: `INSERT INTO files (short_id, original_filename, mime_type, size_bytes, file_data, expires_at, delete_token, user_id, user_tag, integrity_hash, compressed, cluster_id, allow_annotations, allow_download, require_account)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    args: [shortId, enc_filename, enc_mime, file.size, file_data, expires_at, deleteToken, null, userTag, integrity_hash, shortId, allow_annotations, allow_download, require_account]
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
