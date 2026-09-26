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
const TYPES_ERROR = 'Only PDF, DOCX, PNG, JPG and text (.txt, .md, .csv) files can be shared.';
const NOT_UTF8 = 'not-utf8';
const ENCODING_ERROR = "This text file isn't saved as UTF-8. Save it as UTF-8 (in Excel: CSV UTF-8) and try again.";
const BINARY_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'zip']);
const EXT_FOR = {
  'application/pdf': '.pdf', [DOCX_MIME]: '.docx', 'image/png': '.png', 'image/jpeg': '.jpg',
  'text/plain': '.txt', 'text/markdown': '.md', 'text/csv': '.csv',
};

// The name people see always ends in the extension of what the file really is,
// so a text share can't be downloaded as .html, .bat or .hta.
function nameFor(requested, fallback, mime) {
  const ext = EXT_FOR[mime];
  let name = String(requested || '').trim() || String(fallback || '').trim();
  name = name.replace(/[\x00-\x1F\x7F<>:"/\\|?*]/g, '').trim();
  // drop an extension the uploader gave ("v1.2" isn't one), then add the real one
  name = name.replace(/\.(?=[a-z0-9]*[a-z])[a-z0-9]{1,10}$/i, '').trim().slice(0, 190);
  return (name || 'file') + ext;
}

// A DOCX is a ZIP with word/document.xml in it; any other ZIP is refused. The
// name sits in the central directory at the end, so look there first.
function isDocx(bytes) {
  const latin1 = b => new TextDecoder('windows-1252').decode(b);
  const tail = bytes.subarray(Math.max(0, bytes.length - 1024 * 1024));
  if (latin1(tail).includes('word/document.xml')) return true;
  return tail.length < bytes.length && latin1(bytes).includes('word/document.xml');
}

// Text files are shown as plain text, so they must really be text: valid UTF-8
// with no control characters other than tab, newlines and form feed.
// (a name like "report.pdf" promises a real PDF, so text under it is refused)
function textType(bytes, name, declared) {
  const ext = (/\.([a-z]+)$/i.exec(name || '') || [])[1]?.toLowerCase();
  if (BINARY_EXT.has(ext)) return null;
  let mime = { txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv' }[ext];
  if (!mime && /^text\//i.test(declared || '')) {
    mime = /^text\/markdown/i.test(declared) ? 'text/markdown' : /^text\/csv/i.test(declared) ? 'text/csv' : 'text/plain';
  }
  if (!mime || !bytes.length) return null;
  let text;
  // not UTF-8 (Excel's plain "CSV", older Notepad) or UTF-16 (full of NUL bytes)
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return NOT_UTF8; }
  if (text.includes('\x00')) return NOT_UTF8;
  return /[\x01-\x08\x0B\x0E-\x1F\x7F]/.test(text) ? null : mime;
}

// PDF, PNG, JPEG and DOCX by their signatures, then text; anything else is refused
function detectType(b, name, declared) {
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b[0] === 0x50 && b[1] === 0x4B && b[2] === 0x03 && b[3] === 0x04) return isDocx(b) ? DOCX_MIME : null;
  return textType(b, name, declared);
}

async function sha256hex(buffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!/^[0-9a-f]{64}$/i.test(env.ENCRYPTION_KEY || '')) {
    return Response.json({ error: 'Encrypted uploads are unavailable until the server encryption key is configured.' }, { status: 503 });
  }

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

  // Older clients may still submit experimental proofs. The disabled adapter
  // rejects them with zk_rejected so those clients retry with their session.
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

  // Only people with an account can share: a valid session or a valid proof.
  const auth = await verifyToken(request.headers.get('Authorization'), env);
  if (!auth && !zkValidated) {
    return Response.json({ error: 'Sign in to share files.' }, { status: 401 });
  }

  // the type comes from the file's bytes, never its name or the browser's claim
  // (the name only says which kind of text a text file is)
  const buffer = await file.arrayBuffer();
  const detectedMime = detectType(new Uint8Array(buffer), file.name, file.type);
  if (!detectedMime || detectedMime === NOT_UTF8) {
    return Response.json({ error: detectedMime ? ENCODING_ERROR : TYPES_ERROR }, { status: 415 });
  }

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

  // Use custom display_name if provided, otherwise fall back to original filename,
  // with the extension set by what the file really is
  const displayName = nameFor(formData.get('display_name'), file.name, mimeType);

  // Encrypt with the per-file derived key (HKDF salt = shortId). No compression:
  // PDF, DOCX, PNG and JPEG are already compressed, deflating them only burned
  // CPU, and text files are small. AES-GCM's tag detects tampering, so only unencrypted installs
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

  // Count again now this upload is in, so several at once can't all slip under
  // the limit; one that went over is taken back out.
  if (auth && !zkValidated && await countUploadsToday(auth.userId, userTag, env) > 5) {
    await client.execute({ sql: 'DELETE FROM files WHERE short_id = ?', args: [shortId] });
    return Response.json({ error: 'Upload limit reached (5 files per 24h)' }, { status: 429 });
  }

  const baseUrl = env.BASE_URL || new URL(request.url).origin;

  return Response.json({
    shortId,
    shortUrl: `${baseUrl}/r/${shortId}`,
    filename: file.name,
    displayName,
    size: file.size,
    expiresAt: expires_at,
    deleteToken
  });
}
