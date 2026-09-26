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
      if (!resultBody) return { rows: [], rowsAffected: 0, lastInsertRowid: null };
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

      return {
        rows: rowObjects,
        rowsAffected: resultBody.affected_row_count ?? 0,
        lastInsertRowid: resultBody.last_insert_rowid ?? null,
      };
    }
  };
}

// ── schema migrations ────────────────────────────────────────────────────────
// Idempotent "add column / create table" statements only need to run once per
// worker instance, not on every request. Each one is a round trip to Turso.
const migrated = new Set();
export async function migrateOnce(key, client, statements) {
  if (migrated.has(key)) return;
  for (const sql of statements) {
    try { await client.execute({ sql, args: [] }); } catch { /* already applied */ }
  }
  migrated.add(key);
}

// Every column added to files since the original schema, in one place. Endpoints
// call ensureFileColumns before reading them; it only runs once per instance.
const FILE_COLUMNS = [
  'ALTER TABLE files ADD COLUMN allow_annotations INTEGER DEFAULT 1',
  'ALTER TABLE files ADD COLUMN allow_download INTEGER DEFAULT 0',
  'ALTER TABLE files ADD COLUMN user_tag TEXT',
  'ALTER TABLE files ADD COLUMN recipient_user_tag TEXT',
  'ALTER TABLE files ADD COLUMN inbox_status TEXT',
  'ALTER TABLE files ADD COLUMN inbox_note TEXT',
  // reshares and files sent to people point at the original's stored data
  'ALTER TABLE files ADD COLUMN data_short_id TEXT',
  // 1 = only people signed in to ShareSecure can open the link
  'ALTER TABLE files ADD COLUMN require_account INTEGER DEFAULT 0',
  'CREATE INDEX IF NOT EXISTS idx_files_parent ON files(parent_short_id)',
  'CREATE INDEX IF NOT EXISTS idx_files_cluster ON files(cluster_id)',
];

export function ensureFileColumns(client) {
  return migrateOnce('files', client, FILE_COLUMNS);
}

// ── DB clients ───────────────────────────────────────────────────────────────

const TURSO_FALLBACK_URL = 'libsql://fileshare-node-1-ishman.aws-us-east-2.turso.io';

export function getFilesClient(env) {
  return createClient({
    url: env.TURSO_URL || TURSO_FALLBACK_URL,
    authToken: env.TURSO_TOKEN
  });
}

export function getAuthClient(env) {
  return createClient({
    url: env.TURSO_URL || TURSO_FALLBACK_URL,
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
    client.execute({ sql: "DELETE FROM files WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", args: [] }).catch(() => {})
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
// Format: <b64url(payload_json)>.<b64url(hmac_sig)>. There is no unsigned
// fallback: without TOKEN_SECRET nobody can sign in, rather than anyone being
// able to make up a token. Tokens last 30 days.
const TOKEN_TTL_S = 30 * 24 * 60 * 60;

export async function signToken(payload, env) {
  const secret = env.TOKEN_SECRET || '';
  if (!secret) throw new Error('TOKEN_SECRET is not set');
  const iat = typeof payload.iat === 'number' ? payload.iat : Math.floor(Date.now() / 1000);
  const full = { ...payload, iat, exp: typeof payload.exp === 'number' ? payload.exp : iat + TOKEN_TTL_S };
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(full)));
  const sig = await hmacB64url(secret, body);
  return `${body}.${sig}`;
}

export async function verifyToken(authHeader, env) {
  if (!authHeader) return null;
  const secret = env.TOKEN_SECRET || '';
  if (!secret) return null;
  const tokenPart = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  const [body, sig] = tokenPart.split('.', 2);
  if (!body || !sig) return null;

  const expected = await hmacB64url(secret, body);
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (typeof payload.userId !== 'number' && typeof payload.userId !== 'string') return null;
    // older tokens have no exp, so they run out 30 days after they were issued
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number') {
      if (payload.exp < now) return null;
    } else if (typeof payload.iat !== 'number' || payload.iat + TOKEN_TTL_S < now) {
      return null;
    }
    const userId = parseInt(payload.userId, 10);
    if (!Number.isSafeInteger(userId) || userId < 1) return null;
    const user = (await getAuthClient(env).execute({ sql: 'SELECT username FROM users WHERE id = ?', args: [userId] })).rows[0];
    if (!user) return null;
    return { username: user.username, userId };
  } catch {
    return null;
  }
}

// ── Secrets compared without leaking timing ──────────────────────────────────
// Hashing both sides first means the compare always runs over 64 characters,
// whatever was sent, so it gives away neither the length nor a matching prefix.
export async function tokensMatch(given, stored) {
  if (!given || !stored || typeof given !== 'string' || typeof stored !== 'string') return false;
  return timingSafeEqual(await sha256(given), await sha256(stored));
}

// ── Access codes ─────────────────────────────────────────────────────────────
// Stored as pbkdf2$<iterations>$<salt b64>$<hash b64>, with a random salt per
// account. Cloudflare Workers refuse PBKDF2 above 100,000 iterations, and the
// free plan gives a request about 10 ms of CPU, so the default is 10,000; set
// PBKDF2_ITER higher on a paid plan (each hash records its own count). Accounts
// made before this have a plain SHA-256 hex digest; login upgrades them.
const PBKDF2_MAX_ITER = 100000;
const PBKDF2_DEFAULT_ITER = 10000;

function pbkdf2Iterations(env) {
  const n = parseInt(env?.PBKDF2_ITER, 10);
  return Number.isInteger(n) && n > 0 ? Math.min(n, PBKDF2_MAX_ITER) : PBKDF2_DEFAULT_ITER;
}

async function pbkdf2(code, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashAccessCode(code, env) {
  const iterations = pbkdf2Iterations(env);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(String(code), salt, iterations);
  return `pbkdf2$${iterations}$${bufToB64(salt)}$${bufToB64(hash)}`;
}

// { ok, upgrade }: upgrade is true when the stored hash is the old unsalted kind.
export async function checkAccessCode(code, stored, env) {
  if (!code || !stored) return { ok: false, upgrade: false };
  if (stored.startsWith('pbkdf2$')) {
    const [, iter, saltB64, hashB64] = stored.split('$');
    const iterations = parseInt(iter, 10);
    if (!iterations || !saltB64 || !hashB64) return { ok: false, upgrade: false };
    const hash = await pbkdf2(String(code), b64ToBytes(saltB64), iterations);
    return { ok: timingSafeEqual(bufToB64(hash), hashB64), upgrade: false };
  }
  if (/^[0-9a-f]{64}$/i.test(stored)) {
    const ok = timingSafeEqual(await sha256(String(code)), stored.toLowerCase());
    return { ok, upgrade: ok };
  }
  return { ok: false, upgrade: false };
}

// ── User pseudonym (HMAC tag) ────────────────────────────────────────────────
// Stored in files.user_tag instead of raw user_id. Without TAG_SECRET, the row
// reveals nothing about which account uploaded it. Server reverses by computing
// the tag from the authenticated user's id at query time.
// Falling back to TOKEN_SECRET is on purpose: deployments that never set
// TAG_SECRET already have rows tagged with it, and changing the key would cut
// those accounts off from their own files and inbox.
export async function getUserTag(userId, env) {
  const secret = env.TAG_SECRET || env.TOKEN_SECRET || '';
  if (!secret) return null;
  return hmacHex(secret, `u:${userId}`);
}

// ── Uploads in the last 24h ──────────────────────────────────────────────────
// ZK uploads store no user_tag, so they can't be counted from the files table.
// Each one costs a challenge, and zk_challenge_log is per user, so the total is
// tagged uploads + challenges issued. Both paths share the one 5/day budget.
export async function countUploadsToday(userId, userTag, env) {
  const files = await getFilesClient(env).execute({
    sql: `SELECT COUNT(*) as count FROM files
          WHERE (user_tag = ? OR (user_tag IS NULL AND user_id = ?))
            AND uploaded_at > datetime('now', '-1 day')`,
    args: [userTag, userId]
  });
  let zk = 0;
  try {
    const log = await getAuthClient(env).execute({
      sql: "SELECT COUNT(*) as count FROM zk_challenge_log WHERE user_id = ? AND issued_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')",
      args: [userId]
    });
    zk = Number(log.rows[0].count);
  } catch { /* no ZK uploads yet, so the table may not exist */ }
  return Number(files.rows[0].count) + zk;
}

// ── AES-GCM helpers ──────────────────────────────────────────────────────────
// Requires ENCRYPTION_KEY env secret: 64 hex chars (32 bytes / AES-256)

// Base64 in both directions. Files are stored as base64 text, so this runs over
// every byte of every upload and view: use the runtime's native version when it
// has one, and a plain loop otherwise (a per-byte callback blew the CPU limit).
function bufToB64(buffer) {
  const bytes = new Uint8Array(buffer);
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let str = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    str += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(str);
}

export function b64ToBytes(b64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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
    const bytes = b64ToBytes(stored.slice(5));
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, fileKey, bytes.subarray(12));
  }
  if (stored.startsWith('enc:')) {
    if (!key) throw new Error('Data is encrypted but ENCRYPTION_KEY is not set');
    const bytes = b64ToBytes(stored.slice(4));
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12));
  }
  return b64ToBytes(stored).buffer;
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

// ── stored file bytes ────────────────────────────────────────────────────────
async function inflate(buffer) {
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Response(stream).arrayBuffer();
}

// A link's file, decrypted. Reshares and files sent to people hold no copy of
// their own: they point at the original upload (data_short_id), whose id is
// what that data's encryption key was derived from. Older links carry a copy.
export async function loadFileBytes(client, file, env) {
  let holder = file;
  if (!file.file_data && file.data_short_id) {
    holder = (await client.execute({
      sql: 'SELECT short_id, file_data, compressed FROM files WHERE short_id = ?',
      args: [file.data_short_id]
    })).rows[0];
    if (!holder?.file_data) return null;
  }
  if (!holder.file_data) return null;
  const encKey = await getEncKey(env);
  let buffer = await decryptField(holder.file_data, encKey, env, holder.short_id);
  if (holder.compressed) buffer = await inflate(buffer);
  return { buffer, wasEncrypted: /^enc2?:/.test(holder.file_data) };
}

// Links can be limited to people signed in to ShareSecure. Returns the response
// to send when the viewer isn't signed in, or null when they may continue.
export async function signInRequired(file, request, env) {
  if (!file?.require_account && !file?.recipient_user_tag) return null;
  const auth = await verifyToken(request.headers.get('Authorization'), env);
  if (auth) {
    if (!file.recipient_user_tag || file.recipient_user_tag === await getUserTag(auth.userId, env)) return null;
    return Response.json({ error: 'This file was sent to another account.', code: 'recipient_required' }, { status: 403 });
  }
  return Response.json(
    { error: 'Sign in to ShareSecure to open this file.', code: 'sign_in_required' },
    { status: 401 }
  );
}

// Deleting a link removes it and every link shared onward from it (its branch).
// Deleting the original upload removes every link to the file.
export async function deleteBranch(client, file) {
  if (file.cluster_id && file.short_id === file.cluster_id) {
    await client.execute({ sql: 'DELETE FROM files WHERE cluster_id = ?', args: [file.cluster_id] });
    return 'everyone';
  }
  await client.execute({
    sql: `WITH RECURSIVE branch(id) AS (
            SELECT ?
            UNION
            SELECT f.short_id FROM files f JOIN branch b ON f.parent_short_id = b.id
          )
          DELETE FROM files WHERE short_id IN (SELECT id FROM branch)`,
    args: [file.short_id]
  });
  return 'branch';
}
