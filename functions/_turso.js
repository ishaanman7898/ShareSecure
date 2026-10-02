// Shared helpers for the website's API: the database, sign-in tokens, password
// hashes, encryption, and the rules every endpoint follows for links.

// ── database ─────────────────────────────────────────────────────────────────
// A tiny Turso client over plain fetch, so the API needs no npm packages.

function createClient({ url, authToken }) {
  const base = url.replace(/^libsql:\/\//, 'https://');

  return {
    async execute({ sql, args = [] }) {
      // Turso wants every value labelled with its type
      const typedArgs = args.map(v => {
        if (v === null || v === undefined) return { type: 'null' };
        if (typeof v === 'number') {
          return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: String(v) };
        }
        return { type: 'text', value: String(v) };
      });

      const res = await fetch(`${base}/v2/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql, args: typedArgs } }, { type: 'close' }] })
      });
      if (!res.ok) throw new Error(`Turso error ${res.status}: ${await res.text()}`);

      const result = (await res.json()).results[0];
      if (result.type === 'error') throw new Error(result.error.message);

      // statements like CREATE TABLE come back without rows
      const body = result.response?.result;
      if (!body) return { rows: [], rowsAffected: 0, lastInsertRowid: null };

      // turn each row into a plain object keyed by column name
      const rows = body.rows.map(row => {
        const obj = {};
        body.cols.forEach((col, i) => {
          const cell = row[i];
          obj[col.name] = cell.type === 'null' ? null
            : cell.type === 'integer' ? parseInt(cell.value, 10)
            : cell.type === 'float' ? parseFloat(cell.value)
            : cell.value;
        });
        return obj;
      });
      return { rows, rowsAffected: body.affected_row_count ?? 0, lastInsertRowid: body.last_insert_rowid ?? null };
    }
  };
}

const TURSO_FALLBACK_URL = 'libsql://fileshare-node-1-ishman.aws-us-east-2.turso.io';

// Accounts and files live in the same database.
export function getDb(env) {
  return createClient({ url: env.TURSO_URL || TURSO_FALLBACK_URL, authToken: env.TURSO_TOKEN });
}

// "Add this column if it isn't there" statements only need to run once per
// server instance, not on every request (each one is a round trip).
const migrated = new Set();
// A statement that fails only because it already happened ("duplicate column")
// is fine; anything else (the database couldn't be reached, say) means it's
// tried again on the next request instead of being skipped for good.
export async function migrateOnce(name, db, statements) {
  if (migrated.has(name)) return;
  let done = true;
  for (const sql of statements) {
    try { await db.execute({ sql, args: [] }); } catch (err) {
      if (!/duplicate column|already exists/i.test(err.message)) {
        done = false;
        console.error(`setup "${name}" failed:`, err.message);
      }
    }
  }
  if (done) migrated.add(name);
}

// Every column added to files since the first version, in one place.
const FILE_COLUMNS = [
  'ALTER TABLE files ADD COLUMN allow_annotations INTEGER DEFAULT 1',
  'ALTER TABLE files ADD COLUMN allow_download INTEGER DEFAULT 0',
  'ALTER TABLE files ADD COLUMN user_tag TEXT',              // which account shared it (a keyed hash)
  'ALTER TABLE files ADD COLUMN recipient_user_tag TEXT',    // who it was sent to
  'ALTER TABLE files ADD COLUMN inbox_status TEXT',          // pending / accepted
  'ALTER TABLE files ADD COLUMN inbox_note TEXT',
  'ALTER TABLE files ADD COLUMN data_short_id TEXT',         // older links: where the bytes are
  'ALTER TABLE files ADD COLUMN require_account INTEGER DEFAULT 0',
  'ALTER TABLE files ADD COLUMN parent_key TEXT',            // keyed hash of the link it came from
  'ALTER TABLE files ADD COLUMN data_ref TEXT',              // encrypted pointer to the bytes
  'ALTER TABLE files ADD COLUMN sender_tag TEXT',            // only used to limit sends
  'ALTER TABLE files ADD COLUMN e2e INTEGER DEFAULT 0',      // 1 = end-to-end encrypted
  'ALTER TABLE files ADD COLUMN owner_key TEXT',             // file key sealed to the owner
  'ALTER TABLE files ADD COLUMN inbox_key TEXT',             // file key sealed to the recipient
  'ALTER TABLE files ADD COLUMN passcode_salt TEXT',         // set when the link also needs a passcode
  'CREATE INDEX IF NOT EXISTS idx_files_parent ON files(parent_short_id)',
  'CREATE INDEX IF NOT EXISTS idx_files_parent_key ON files(parent_key)',
  'CREATE INDEX IF NOT EXISTS idx_files_cluster ON files(cluster_id)',
  'CREATE INDEX IF NOT EXISTS idx_files_sender ON files(sender_tag, recipient_user_tag)',
  // one row per send, kept for a day, so declined requests still count
  'CREATE TABLE IF NOT EXISTS send_log (sender_tag TEXT NOT NULL, sent_at TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_send_log ON send_log(sender_tag, sent_at)',
];
export const ensureFileColumns = db => migrateOnce('files', db, FILE_COLUMNS);

// Each account's key pair for end-to-end encryption. The private key is locked
// with the account password in the browser before it gets here.
// The accounts table, for a database that doesn't have one yet.
export const USERS_TABLE = `CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  access_code TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`;

export const ensureUserColumns = db => migrateOnce('users', db, [
  USERS_TABLE,
  'ALTER TABLE users ADD COLUMN public_key TEXT',
  'ALTER TABLE users ADD COLUMN private_key_box TEXT',
  // the account's own list of its shares, sealed to its own key (public/vault.js)
  'ALTER TABLE users ADD COLUMN vault TEXT',
]);

// Expired links are deleted for good, in the background.
export function purgeExpired(env, context) {
  context.waitUntil(getDb(env).execute({
    sql: "DELETE FROM files WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", args: []
  }).catch(() => {}));
}

// Finds an account by name: the exact name first, so older accounts with
// unusual names keep working, then any capitalisation, as long as only one
// account fits.
export async function findUser(db, username, columns = 'id') {
  const name = String(username);
  const exact = (await db.execute({ sql: `SELECT ${columns} FROM users WHERE username = ?`, args: [name] })).rows[0];
  if (exact) return exact;
  const loose = (await db.execute({
    sql: `SELECT ${columns} FROM users WHERE lower(username) = lower(?) LIMIT 2`, args: [name.trim().normalize('NFKC')]
  })).rows;
  return loose.length === 1 ? loose[0] : null;
}

// ── small helpers ────────────────────────────────────────────────────────────

// A random id from letters and digits (links, delete keys, tokens).
export function randomId(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), b => chars[b % chars.length]).join('');
}

const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');

export async function sha256(text) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
}
export const hmacHex = async (secret, msg) => hex(await hmac(secret, msg));

// Base64 in both directions. Stored files are base64 text, so this runs over
// every byte: use the runtime's own version when it has one (a per-byte
// callback was too slow for Cloudflare's CPU limit).
export function bufToB64(buffer) {
  const bytes = new Uint8Array(buffer);
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let str = '';
  for (let i = 0; i < bytes.length; i += 8192) str += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(str);
}

export function b64ToBytes(b64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const b64url = bytes => bufToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = s => b64ToBytes(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4));

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Compares two secrets without giving away how much matched: both are hashed
// first, so the compare always runs over the same 64 characters.
export async function tokensMatch(given, stored) {
  if (!given || !stored || typeof given !== 'string' || typeof stored !== 'string') return false;
  return timingSafeEqual(await sha256(given), await sha256(stored));
}

// ── sign-in tokens ───────────────────────────────────────────────────────────
// A token is <base64url JSON>.<HMAC signature>, valid for 30 days. Without
// TOKEN_SECRET nobody can sign in (rather than anyone being able to forge one).
const TOKEN_TTL_S = 30 * 24 * 60 * 60;

export async function signToken(payload, env) {
  if (!env.TOKEN_SECRET) throw new Error('TOKEN_SECRET is not set');
  const iat = Math.floor(Date.now() / 1000);
  const body = b64url(new TextEncoder().encode(JSON.stringify({ ...payload, iat, exp: iat + TOKEN_TTL_S })));
  return `${body}.${b64url(await hmac(env.TOKEN_SECRET, body))}`;
}

// "Bearer <token>" → { userId, username } for a live account, or null.
export async function verifyToken(authHeader, env) {
  if (!authHeader || !env.TOKEN_SECRET) return null;
  const [body, sig] = authHeader.replace(/^Bearer /, '').split('.', 2);
  if (!body || !sig) return null;
  if (!timingSafeEqual(sig, b64url(await hmac(env.TOKEN_SECRET, body)))) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    // older tokens have no exp, so they run out 30 days after they were issued
    const exp = typeof payload.exp === 'number' ? payload.exp : (payload.iat ?? 0) + TOKEN_TTL_S;
    if (exp < Date.now() / 1000) return null;
    const userId = parseInt(payload.userId, 10);
    if (!Number.isSafeInteger(userId) || userId < 1) return null;
    const user = (await getDb(env).execute({ sql: 'SELECT username FROM users WHERE id = ?', args: [userId] })).rows[0];
    return user ? { userId, username: user.username } : null;
  } catch {
    return null;
  }
}

// ── passwords ("access codes") ───────────────────────────────────────────────
// Stored as pbkdf2$<iterations>$<salt>$<hash>. Cloudflare caps PBKDF2 at
// 100,000 rounds and the free plan gives a request ~10 ms of CPU, so the
// default is 10,000; raise PBKDF2_ITER on a paid plan. Very old accounts have
// a bare SHA-256 instead, which sign-in upgrades.
function pbkdf2Iterations(env) {
  const n = parseInt(env?.PBKDF2_ITER, 10);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 100000) : 10000;
}

async function pbkdf2(code, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashAccessCode(code, env) {
  const iterations = pbkdf2Iterations(env);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${iterations}$${bufToB64(salt)}$${bufToB64(await pbkdf2(String(code), salt, iterations))}`;
}

// → { ok, upgrade }. upgrade means "re-hash it, it's the old unsalted kind".
export async function checkAccessCode(code, stored, env) {
  if (!code || !stored) return { ok: false, upgrade: false };
  if (stored.startsWith('pbkdf2$')) {
    const [, iter, salt, hash] = stored.split('$');
    if (!parseInt(iter, 10) || !salt || !hash) return { ok: false, upgrade: false };
    const got = await pbkdf2(String(code), b64ToBytes(salt), parseInt(iter, 10));
    return { ok: timingSafeEqual(bufToB64(got), hash), upgrade: false };
  }
  if (/^[0-9a-f]{64}$/i.test(stored)) {
    const ok = timingSafeEqual(await sha256(String(code)), stored.toLowerCase());
    return { ok, upgrade: ok };
  }
  return { ok: false, upgrade: false };
}

// ── account tags ─────────────────────────────────────────────────────────────
// Files store a keyed hash of the account ("user tag") instead of its id, so a
// copy of the database alone can't say whose file is whose. TOKEN_SECRET is the
// fallback key on purpose: older deployments tagged rows with it.
export async function getUserTag(userId, env) {
  const secret = env.TAG_SECRET || env.TOKEN_SECRET || '';
  return secret ? hmacHex(secret, `u:${userId}`) : null;
}

// How many files the account shared in the last 24 hours.
export async function countUploadsToday(userId, userTag, env) {
  const res = await getDb(env).execute({
    sql: `SELECT COUNT(*) as count FROM files
          WHERE (user_tag = ? OR (user_tag IS NULL AND user_id = ?))
            AND uploaded_at > datetime('now', '-1 day')`,
    args: [userTag, userId]
  });
  return Number(res.rows[0].count);
}

// ── server-side encryption ───────────────────────────────────────────────────
// Files that aren't end-to-end encrypted are still encrypted here, each with its
// own AES-256 key made from ENCRYPTION_KEY (64 hex characters) and the link id.

function masterKeyBytes(env) {
  return env.ENCRYPTION_KEY ? new Uint8Array(env.ENCRYPTION_KEY.match(/.{2}/g).map(b => parseInt(b, 16))) : null;
}

// The master key itself; only very old rows ("enc:") were encrypted with it.
export async function getEncKey(env) {
  const bytes = masterKeyBytes(env);
  return bytes ? crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']) : null;
}

async function deriveFileKey(env, salt) {
  const master = masterKeyBytes(env);
  if (!master) return null;
  const base = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(`ss:file:${salt}`), info: new TextEncoder().encode('sharesecure-v2-aead') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

// bytes → "enc2:<base64 of nonce + ciphertext>", keyed to `id`
export async function encryptField(buffer, _legacyKey, env, id) {
  const key = await deriveFileKey(env, id);
  if (!key) throw new Error('ENCRYPTION_KEY is not set');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return 'enc2:' + bufToB64(out);
}

// Stored text → bytes. Understands every format rows have been saved in.
export async function decryptField(stored, legacyKey, env, id) {
  if (stored.startsWith('enc2:')) {
    const key = await deriveFileKey(env, id);
    if (!key) throw new Error('ENCRYPTION_KEY is not set');
    const bytes = b64ToBytes(stored.slice(5));
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12));
  }
  if (stored.startsWith('enc:')) {
    if (!legacyKey) throw new Error('ENCRYPTION_KEY is not set');
    const bytes = b64ToBytes(stored.slice(4));
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, legacyKey, bytes.subarray(12));
  }
  return b64ToBytes(stored).buffer;
}

export const encryptStr = (str, key, env, id) => encryptField(new TextEncoder().encode(str), key, env, id);

// Text sealed end to end ("e2e:…") is passed through untouched: only a browser
// holding the file's key can open it.
export async function decryptStr(stored, key, env, id) {
  if (!stored) return '';
  if (stored.startsWith('e2e:')) return stored;
  if (!/^enc2?:/.test(stored)) return stored;
  return new TextDecoder().decode(await decryptField(stored, key, env, id));
}

// ── links and branches ───────────────────────────────────────────────────────
// A reshare, or a copy sent to someone, is a "branch" of the link it came from.
// It doesn't store that link's id, only a keyed hash of it, and its pointer to
// the bytes is encrypted. The server can still find a link's branches; a copy
// of the database alone can't tell which links belong together.
function parentKey(env, shortId) {
  return hmacHex(env.TAG_SECRET || env.TOKEN_SECRET || '', `parent:${shortId}`);
}

// Which row holds this link's bytes (older links store the id in plain).
async function dataIdOf(file, env) {
  if (file.file_data) return file.short_id;
  if (file.data_ref) return decryptStr(file.data_ref, null, env, file.short_id);
  return file.data_short_id || file.short_id;
}

// The columns a new branch of `parent` needs.
export async function branchFrom(parent, childId, env) {
  return {
    parent_key: await parentKey(env, parent.short_id),
    data_ref: await encryptStr(await dataIdOf(parent, env), null, env, childId),
  };
}

// A link's file as bytes. End-to-end encrypted files come back still sealed.
export async function loadFileBytes(db, file, env) {
  const dataId = await dataIdOf(file, env);
  const holder = dataId === file.short_id ? file : (await db.execute({
    sql: 'SELECT short_id, file_data, compressed FROM files WHERE short_id = ?', args: [dataId]
  })).rows[0];
  if (!holder?.file_data) return null;
  if (holder.file_data.startsWith('e2e:')) return { buffer: b64ToBytes(holder.file_data.slice(4)).buffer, sealed: true };
  let buffer = await decryptField(holder.file_data, await getEncKey(env), env, holder.short_id);
  // very old uploads were deflated first
  if (holder.compressed) {
    buffer = await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
  }
  return { buffer, sealed: false };
}

// Deletes a link and every link shared onward from it, so deleting an original
// removes every link to the file. → 'everyone', 'branch', or null if not found.
export async function deleteBranch(db, shortId, env) {
  const file = (await db.execute({
    sql: 'SELECT short_id, parent_key, parent_short_id FROM files WHERE short_id = ?', args: [shortId]
  })).rows[0];
  if (!file) return null;
  // walk down the tree of branches
  const ids = [shortId];
  for (let i = 0; i < ids.length && ids.length < 5000; i++) {
    const kids = (await db.execute({
      sql: 'SELECT short_id FROM files WHERE parent_key = ? OR parent_short_id = ?',
      args: [await parentKey(env, ids[i]), ids[i]]
    })).rows;
    for (const k of kids) if (!ids.includes(k.short_id)) ids.push(k.short_id);
  }
  const original = !file.parent_key && !file.parent_short_id;
  // links made before branches were tracked are grouped under the original
  if (original) await db.execute({ sql: 'DELETE FROM files WHERE cluster_id = ?', args: [shortId] });
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    await db.execute({ sql: `DELETE FROM files WHERE short_id IN (${chunk.map(() => '?').join(',')})`, args: chunk });
  }
  return original ? 'everyone' : 'branch';
}

// Some links only open for signed-in people, or for the one person they were
// sent to. → the response to send back, or null when the viewer may continue.
export async function signInRequired(file, request, env) {
  if (!file?.require_account && !file?.recipient_user_tag) return null;
  const auth = await verifyToken(request.headers.get('Authorization'), env);
  if (!auth) return Response.json({ error: 'Sign in to ShareSecure to open this file.', code: 'sign_in_required' }, { status: 401 });
  if (!file.recipient_user_tag || file.recipient_user_tag === await getUserTag(auth.userId, env)) return null;
  return Response.json({ error: 'This file was sent to another account.', code: 'recipient_required' }, { status: 403 });
}

// The live, active link with this id, or null.
export async function findLiveFile(db, shortId, columns = '*') {
  const file = (await db.execute({
    sql: `SELECT ${columns} FROM files WHERE short_id = ? AND is_active = 1`, args: [shortId]
  })).rows[0];
  if (!file) return null;
  if (file.expires_at && new Date(file.expires_at) < new Date()) return { expired: true };
  return file;
}
