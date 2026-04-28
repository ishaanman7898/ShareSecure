// Lightweight Turso HTTP client — no npm packages, pure fetch.
// Works natively in Cloudflare Pages Functions.

function createClient({ url, authToken }) {
  // accept both libsql:// and https:// URLs
  const base = url.replace(/^libsql:\/\//, 'https://');

  return {
    async execute({ sql, args = [] }) {
      // convert plain JS values to Turso typed args
      const typedArgs = args.map(v => {
        if (v === null || v === undefined) return { type: 'null' };
        if (typeof v === 'number') {
          return Number.isInteger(v)
            ? { type: 'integer', value: String(v) }
            : { type: 'float', value: String(v) };
        }
        return { type: 'text', value: String(v) };
      });

      const res = await fetch(`${base}/v2/pipeline`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          requests: [
            { type: 'execute', stmt: { sql, args: typedArgs } },
            { type: 'close' }
          ]
        })
      });

      if (!res.ok) throw new Error(`Turso error ${res.status}: ${await res.text()}`);

      const data = await res.json();
      const result = data.results[0];
      if (result.type === 'error') throw new Error(result.error.message);

      // DDL statements (CREATE TABLE, etc.) may return a response without a result object
      const resultBody = result.response?.result;
      if (!resultBody) return { rows: [] };
      const { cols, rows } = resultBody;

      // convert to plain row objects keyed by column name
      const rowObjects = rows.map(row => {
        const obj = {};
        cols.forEach((col, i) => {
          const cell = row[i];
          if (cell.type === 'null') obj[col.name] = null;
          else if (cell.type === 'integer') obj[col.name] = parseInt(cell.value, 10);
          else if (cell.type === 'float') obj[col.name] = parseFloat(cell.value);
          else obj[col.name] = cell.value;
        });
        return obj;
      });

      return { rows: rowObjects };
    }
  };
}

// ── DB clients ───────────────────────────────────────────────────────────────

export function getFilesClient(env) {
  return createClient({
    url: 'libsql://fileshare-node-1-ishman.aws-us-east-2.turso.io',
    authToken: env.TURSO_TOKEN
  });
}

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

export async function getTursoClient(_nodeNum, env) {
  return getFilesClient(env);
}

export async function getClientById(_shortId, env) {
  return getFilesClient(env);
}

// hard-delete expired rows so the DB stays lean
export async function globalPurgeExpired(env, context) {
  const client = getFilesClient(env);
  context.waitUntil(
    client.execute({ sql: "DELETE FROM files WHERE expires_at < datetime('now')", args: [] }).catch(() => {})
  );
}

// sha-256 hex (web crypto, no Node needed)
export async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── base64url helpers ────────────────────────────────────────────────────────
function b64urlEncode(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let str = '';
  for (let i = 0; i < arr.length; i += 8192) str += String.fromCharCode(...arr.subarray(i, i + 8192));
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - str.length % 4) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

// constant-time string compare
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── HMAC helpers ─────────────────────────────────────────────────────────────
async function hmacKey(secret) {
  const keyBytes = new TextEncoder().encode(secret);
  return crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function hmacHex(secret, msg) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacB64url(secret, msg) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return b64urlEncode(new Uint8Array(sig));
}

// ── Signed auth tokens ───────────────────────────────────────────────────────
// New format: <b64url(payload_json)>.<b64url(hmac_sig)>
// Legacy: <base64(username:userId)>  — accepted only if TOKEN_SECRET unset or for migration
export async function signToken(payload, env) {
  const secret = env.TOKEN_SECRET || '';
  if (!secret) {
    // fall back to legacy unsigned format if no secret configured
    return btoa(`${payload.username}:${payload.userId}`);
  }
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacB64url(secret, body);
  return `${body}.${sig}`;
}

export async function verifyToken(authHeader, env) {
  if (!authHeader) return null;
  const tokenPart = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  const secret = env.TOKEN_SECRET || '';

  // signed token: payload.signature
  if (tokenPart.includes('.')) {
    const [body, sig] = tokenPart.split('.', 2);
    if (!secret) return null;
    const expected = await hmacB64url(secret, body);
    if (!timingSafeEqual(sig, expected)) return null;
    try {
      const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
      if (typeof payload.userId !== 'number' && typeof payload.userId !== 'string') return null;
      return { username: payload.username, userId: parseInt(payload.userId, 10) };
    } catch {
      return null;
    }
  }

  // legacy token (accept only if TOKEN_SECRET not set — clean migration period)
  if (!secret) {
    try {
      const decoded = atob(tokenPart);
      const parts = decoded.split(':');
      if (parts.length < 2) return null;
      const userId = parseInt(parts[parts.length - 1], 10);
      if (isNaN(userId)) return null;
      return { username: parts.slice(0, -1).join(':'), userId };
    } catch { return null; }
  }
  return null;
}

// Legacy synchronous decoder (still used by paths that haven't migrated yet).
// Prefer verifyToken for new code.
export function decodeToken(authHeader) {
  if (!authHeader) return null;
  try {
    const tokenPart = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    if (tokenPart.includes('.')) {
      // signed token — decode payload without verification (caller must verify separately)
      const body = tokenPart.split('.', 1)[0];
      const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
      const userId = parseInt(payload.userId, 10);
      if (isNaN(userId)) return null;
      return { username: payload.username, userId };
    }
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

// ── User pseudonym (HMAC tag) ────────────────────────────────────────────────
// Stored in files.user_tag instead of raw user_id. Without TAG_SECRET, the row
// reveals nothing about which account uploaded it. Server reverses by computing
// the tag from the authenticated user's id at query time.
export async function getUserTag(userId, env) {
  const secret = env.TAG_SECRET || env.TOKEN_SECRET || '';
  if (!secret) return null;
  return hmacHex(secret, `u:${userId}`);
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

// Get raw master key bytes for HKDF-style derivation
async function getMasterKeyBytes(env) {
  if (!env.ENCRYPTION_KEY) return null;
  return new Uint8Array(env.ENCRYPTION_KEY.match(/.{2}/g).map(b => parseInt(b, 16)));
}

// HKDF-derive a per-file AES-GCM key from master + salt (shortId).
// Each file ends up with a unique key; one file's compromise does not weaken others.
async function deriveFileKey(env, salt) {
  const master = await getMasterKeyBytes(env);
  if (!master) return null;
  const hkdfKey = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(`ss:file:${salt}`),
      info: new TextEncoder().encode('sharesecure-v2-aead')
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Encrypt a binary buffer.
// shortId provided -> per-file derived key, prefix 'enc2:' (preferred).
// shortId omitted  -> legacy master-key path, prefix 'enc:' (back-compat).
// No master key    -> plain base64 (only for fully unconfigured deployments).
export async function encryptField(buffer, key, env, shortId) {
  if (env && shortId) {
    const fileKey = await deriveFileKey(env, shortId);
    if (fileKey) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, fileKey, buffer);
      const combined = new Uint8Array(12 + ct.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(ct), 12);
      return 'enc2:' + bufToB64(combined.buffer);
    }
  }
  if (!key) return bufToB64(buffer);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer);
  const combined = new Uint8Array(12 + ct.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ct), 12);
  return 'enc:' + bufToB64(combined.buffer);
}

// Decrypt a stored field back to ArrayBuffer.
// Auto-detects format: 'enc2:' (per-file key, needs shortId+env), 'enc:' (master key), legacy plain b64.
export async function decryptField(stored, key, env, shortId) {
  if (stored.startsWith('enc2:')) {
    if (!env || !shortId) throw new Error('enc2 field needs env+shortId for key derivation');
    const fileKey = await deriveFileKey(env, shortId);
    if (!fileKey) throw new Error('Per-file decryption requested but ENCRYPTION_KEY is not set');
    const bytes = Uint8Array.from(atob(stored.slice(5)), c => c.charCodeAt(0));
    const iv = bytes.slice(0, 12);
    const ct = bytes.slice(12);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, fileKey, ct);
  }
  if (stored.startsWith('enc:')) {
    if (!key) throw new Error('Data is encrypted but ENCRYPTION_KEY is not set');
    const bytes = Uint8Array.from(atob(stored.slice(4)), c => c.charCodeAt(0));
    const iv = bytes.slice(0, 12);
    const ct = bytes.slice(12);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  }
  return Uint8Array.from(atob(stored), c => c.charCodeAt(0)).buffer;
}

// Encrypt a short string (filename, mime_type, annotations)
export async function encryptStr(str, key, env, shortId) {
  if (env && shortId) {
    const buf = new TextEncoder().encode(str);
    return encryptField(buf, key, env, shortId);
  }
  if (!key) return str;
  const buf = new TextEncoder().encode(str);
  return encryptField(buf, key);
}

// Decrypt a short string
export async function decryptStr(stored, key, env, shortId) {
  if (!stored) return '';
  if (stored.startsWith('enc2:')) {
    const buf = await decryptField(stored, key, env, shortId);
    return new TextDecoder().decode(buf);
  }
  if (!key || !stored.startsWith('enc:')) return stored ?? '';
  const buf = await decryptField(stored, key);
  return new TextDecoder().decode(buf);
}
