import { createClient } from '@libsql/client/web';

// files db
export function getFilesClient(env) {
  return createClient({
    url: 'libsql://fileshare-node-1-ishman.aws-us-east-2.turso.io',
    authToken: env.TURSO_TOKEN
  });
}

// auth db
export function getAuthClient(env) {
  return createClient({
    url: 'libsql://fileshare-node-1-ishman.aws-us-east-2.turso.io',
    authToken: env.TURSO_TOKEN
  });
}

// backward-compat aliases
export function getShardNode(shortId, nodes = 3) {
  if (!shortId) return 1;
  return (shortId.charCodeAt(0) % nodes) + 1;
}

export async function getTursoClient(nodeNum, env) {
  return getFilesClient(env);
}

export async function getClientById(shortId, env) {
  return getFilesClient(env);
}

// hard-delete expired rows so the DB stays lean
export async function globalPurgeExpired(env, context) {
  const client = getFilesClient(env);
  context.waitUntil(
    client.execute("DELETE FROM files WHERE expires_at < datetime('now')").catch(() => {})
  );
}

// sha-256 hex (web crypto, no Node needed)
export async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// decode auth bearer token → { username, userId } or null
export function decodeToken(authHeader) {
  if (!authHeader) return null;
  try {
    const tokenPart = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    const decoded = atob(tokenPart);
    const parts = decoded.split(':');
    if (parts.length < 2) return null;
    const userId = parseInt(parts[parts.length - 1], 10);
    if (isNaN(userId)) return null;
    const username = parts.slice(0, -1).join(':');
    return { username, userId };
  } catch {
    return null;
  }
}

// ── AES-GCM helpers ──────────────────────────────────────────────────────────
// Requires ENCRYPTION_KEY env secret: 64 hex chars (32 bytes / AES-256)

function bufToB64(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    str += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(str);
}

export async function getEncKey(env) {
  if (!env.ENCRYPTION_KEY) return null;
  const bytes = new Uint8Array(env.ENCRYPTION_KEY.match(/.{2}/g).map(b => parseInt(b, 16)));
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// Encrypt a binary buffer → returns 'enc:<base64(iv+ciphertext)>'
// If no key, returns plain base64
export async function encryptField(buffer, key) {
  if (!key) return bufToB64(buffer);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer);
  const combined = new Uint8Array(12 + ct.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ct), 12);
  return 'enc:' + bufToB64(combined.buffer);
}

// Decrypt a stored field back to ArrayBuffer
// Handles both encrypted ('enc:...') and legacy plain base64
export async function decryptField(stored, key) {
  if (stored.startsWith('enc:')) {
    if (!key) throw new Error('Data is encrypted but ENCRYPTION_KEY is not set');
    const bytes = Uint8Array.from(atob(stored.slice(4)), c => c.charCodeAt(0));
    const iv = bytes.slice(0, 12);
    const ct = bytes.slice(12);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  }
  // legacy plain base64
  return Uint8Array.from(atob(stored), c => c.charCodeAt(0)).buffer;
}

// Encrypt a short string (filename, mime_type, annotations, etc.)
export async function encryptStr(str, key) {
  if (!key) return str;
  const buf = new TextEncoder().encode(str);
  return encryptField(buf, key);
}

// Decrypt a short string
// Handles encrypted ('enc:...') and plain strings
export async function decryptStr(stored, key) {
  if (!stored || !key || !stored.startsWith('enc:')) return stored ?? '';
  const buf = await decryptField(stored, key);
  return new TextDecoder().decode(buf);
}
