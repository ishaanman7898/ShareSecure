// Signing in without the server ever seeing a password: the server's half of
// OPAQUE (public/opaque.js explains the whole thing), plus the limits on how
// many times someone can try.
//
// Everything here is WebCrypto's ECDH, HKDF and HMAC, so it's quick enough for
// Cloudflare's CPU limit. The server's OPAQUE keys come from ENCRYPTION_KEY,
// so there's no extra secret to set up.
import { getDb, migrateOnce, hmacHex, findUser, ensureUserColumns, signToken, encryptStr, decryptStr, sha256, USERS_TABLE } from './_turso.js';
import {
  credentialId, hkdfExpand, hkdfExtract, keySchedule, preamble, ecdh, scalarToPkcs8, toScalar, sameBytes, xor
} from '../public/opaque.js';
import { toB64url, fromB64url, join, randomBytes, isPublicKey, isSealed } from '../public/sealed.js';

const subtle = crypto.subtle;
const utf8 = new TextEncoder();
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const LOGIN_TTL_MS = 2 * 60 * 1000;   // time between the two halves of a sign-in

// New names stick to a small set of characters, so look-alikes such as
// "alice" in Cyrillic can't pass for someone else.
export const USERNAME = /^[a-zA-Z0-9_.-]{3,32}$/;

export const fail = (error, status = 400, extra = {}) => Response.json({ error, ...extra }, { status });

export const ensureAuthTables = db => migrateOnce('auth', db, [
  USERS_TABLE,
  'ALTER TABLE users ADD COLUMN opaque_record TEXT',
  `CREATE TABLE IF NOT EXISTS login_attempts (
     key TEXT PRIMARY KEY,
     failures INTEGER NOT NULL DEFAULT 0,
     first_at INTEGER NOT NULL
   )`,
  // finished sign-ins, so the same proof can't be used twice
  'CREATE TABLE IF NOT EXISTS login_used (proof TEXT PRIMARY KEY, at INTEGER NOT NULL)',
]);

// ── how many tries ───────────────────────────────────────────────────────────
// Counted in 15-minute windows: 10 for one username from one IP address, 20
// from one address in all, and 100 for one username from anywhere. The address
// limits come first, so locking someone out of their own account takes many
// addresses. IP addresses are only stored as a keyed hash.
const WINDOW_MS = 15 * 60 * 1000;
const LIMITS = { userFromIp: 10, ip: 20, user: 100 };

export async function attemptKeys(request, username, env, kind = 'login') {
  const name = new TextDecoder().decode(credentialId(username));
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const keys = [{ key: await hmacHex(env.TOKEN_SECRET, `${kind}:u:${name}:ip:${ip}`), max: LIMITS.userFromIp }];
  if (ip) keys.push({ key: await hmacHex(env.TOKEN_SECRET, `${kind}:ip:${ip}`), max: LIMITS.ip, address: true });
  keys.push({ key: await hmacHex(env.TOKEN_SECRET, `${kind}:u:${name}`), max: LIMITS.user });
  return keys;
}

// Counts this try before anything is checked, so a burst can't all get in
// first. → true when a limit is passed.
export async function tooManyTries(db, keys, context) {
  const now = Date.now(), since = now - WINDOW_MS;
  for (const { key, max } of keys) {
    const row = (await db.execute({
      sql: `INSERT INTO login_attempts (key, failures, first_at) VALUES (?, 1, ?)
            ON CONFLICT(key) DO UPDATE SET
              failures = CASE WHEN first_at <= ? THEN 1 ELSE failures + 1 END,
              first_at = CASE WHEN first_at <= ? THEN ? ELSE first_at END
            RETURNING failures`,
      args: [key, now, since, since, now]
    })).rows[0];
    if (Number(row?.failures) > max) return true;
  }
  context.waitUntil(db.execute({ sql: 'DELETE FROM login_attempts WHERE first_at <= ?', args: [since] }).catch(() => {}));
  return false;
}

// After a good sign-in: the username's counts are cleared, and the address's
// count only gets this try back (so nobody can reset it by signing in).
export async function forgiveTries(db, keys) {
  const userKeys = keys.filter(k => !k.address).map(k => k.key);
  await db.execute({ sql: `DELETE FROM login_attempts WHERE key IN (${userKeys.map(() => '?').join(',')})`, args: userKeys });
  const ipKey = keys.find(k => k.address);
  if (ipKey) await db.execute({ sql: 'UPDATE login_attempts SET failures = failures - 1 WHERE key = ? AND failures > 0', args: [ipKey.key] });
}

// ── the server's keys ────────────────────────────────────────────────────────
let serverKeys = null;

async function getServerKeys(env) {
  if (serverKeys?.from === env.ENCRYPTION_KEY) return serverKeys;
  if (!/^[0-9a-f]{64}$/i.test(env.ENCRYPTION_KEY || '')) throw new Error('ENCRYPTION_KEY is not set');
  const master = new Uint8Array(env.ENCRYPTION_KEY.match(/.{2}/g).map(h => parseInt(h, 16)));
  const prk = await hkdfExtract(utf8.encode('ShareSecure OPAQUE server'), master);
  const privateKey = await subtle.importKey('pkcs8', scalarToPkcs8(toScalar(await hkdfExpand(prk, 'server key', 48))), ECDH, true, ['deriveBits']);
  const jwk = await subtle.exportKey('jwk', privateKey);
  serverKeys = {
    from: env.ENCRYPTION_KEY,
    privateKey,
    publicKey: join(new Uint8Array([4]), fromB64url(jwk.x), fromB64url(jwk.y)),
    oprfSeed: await hkdfExpand(prk, 'oprf seed', 32),
  };
  return serverKeys;
}

// The server's half of the password step: multiply the blinded password by
// this account's own secret number. ECDH gives back the x-coordinate.
async function evaluate(keys, username, blindedB64) {
  const blinded = fromB64url(String(blindedB64 || ''));
  if (blinded.length !== 65 || blinded[0] !== 4) throw new Error('bad blinded value');
  const k = toScalar(await hkdfExpand(keys.oprfSeed, join(utf8.encode('OprfKey'), credentialId(username)), 48));
  const oprfKey = await subtle.importKey('pkcs8', scalarToPkcs8(k), ECDH, false, ['deriveBits']);
  return ecdh(oprfKey, blinded);   // WebCrypto refuses points that aren't on the curve
}

// → { evaluated, serverPublicKey } for registering (or upgrading) an account
export async function startRecord(env, username, blinded) {
  const keys = await getServerKeys(env);
  return { evaluated: toB64url(await evaluate(keys, username, blinded)), serverPublicKey: toB64url(keys.publicKey) };
}

// Checks a record from the browser and turns it into what's stored.
export function recordFrom(body) {
  const r = body?.record || {};
  const ok = isPublicKey(r.client_public_key)
    && fromB64url(String(r.masking_key || '')).length === 32
    && fromB64url(String(r.envelope || '')).length === 64;
  return ok ? JSON.stringify({ client_public_key: r.client_public_key, masking_key: r.masking_key, envelope: r.envelope }) : null;
}

// The end-to-end key pair that can come with a new record, if it's valid.
export function keyPairFrom(body) {
  if (!body?.public_key && !body?.private_key_box) return null;
  if (!isPublicKey(body.public_key) || !isSealed(body.private_key_box) || body.private_key_box.length > 1000) return false;
  return { publicKey: body.public_key, box: body.private_key_box };
}

// ── signing in ───────────────────────────────────────────────────────────────

// First half: the password step's answer, the envelope (masked), and the
// server's side of the handshake. The proof the browser has to send back is
// kept, encrypted, in `state`.
export async function loginStart(context, body) {
  const { env, request } = context;
  const db = getDb(env);
  await ensureUserColumns(db);
  await ensureAuthTables(db);
  const username = String(body?.username || '');
  if (!username) return fail('Enter a username.');

  const tries = await attemptKeys(request, username, env);
  if (await tooManyTries(db, tries, context)) return fail('Too many attempts. Try again in a few minutes.', 429);

  const user = await findUser(db, username, 'id, username, access_code, opaque_record');
  if (!user) return fail('Wrong username or password.', 401);
  if (!user.opaque_record) return Response.json({ legacy: true });

  let blinded, clientNonce, clientEphemeral;
  try {
    blinded = fromB64url(String(body.blinded));
    clientNonce = fromB64url(String(body.client_nonce));
    clientEphemeral = fromB64url(String(body.client_ephemeral));
    if (clientNonce.length !== 32 || clientEphemeral.length !== 65) throw new Error();
  } catch { return fail('That sign-in request is malformed.'); }

  const keys = await getServerKeys(env);
  const record = JSON.parse(user.opaque_record);
  let evaluated;
  try { evaluated = await evaluate(keys, user.username, body.blinded); } catch { return fail('That sign-in request is malformed.'); }

  // the server's public key and the envelope, masked so only the password opens them
  const maskingNonce = randomBytes(32);
  const plain = join(keys.publicKey, fromB64url(record.envelope));
  const pad = await hkdfExpand(fromB64url(record.masking_key), join(maskingNonce, utf8.encode('CredentialResponsePad')), plain.length);
  const credentialResponse = join(evaluated, maskingNonce, xor(plain, pad));

  const serverNonce = randomBytes(32);
  const eph = await subtle.generateKey(ECDH, true, ['deriveBits']);
  const serverEphemeral = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const pre = preamble({ username: user.username, ke1: join(blinded, clientNonce, clientEphemeral), credentialResponse, serverNonce, serverEphemeral });
  let schedule;
  try {
    schedule = await keySchedule([
      await ecdh(eph.privateKey, clientEphemeral),
      await ecdh(keys.privateKey, clientEphemeral),
      await ecdh(eph.privateKey, fromB64url(record.client_public_key)),
    ], pre);
  } catch { return fail('That sign-in request is malformed.'); }

  const state = await encryptStr(JSON.stringify({
    uid: user.id, mac: toB64url(schedule.clientMac), exp: Date.now() + LOGIN_TTL_MS,
  }), null, env, 'opaque-login');
  return Response.json({
    credential_response: toB64url(credentialResponse),
    server_nonce: toB64url(serverNonce),
    server_ephemeral: toB64url(serverEphemeral),
    server_mac: toB64url(schedule.serverMac),
    state,
  });
}

// Second half: checks the browser's proof. → the user row, or a Response.
// Each proof works once.
export async function checkProof(context, body) {
  const { env } = context;
  const db = getDb(env);
  await ensureAuthTables(db);
  let state;
  try { state = JSON.parse(await decryptStr(String(body?.state || ''), null, env, 'opaque-login')); } catch {
    return fail('That sign-in has expired. Try again.', 401);
  }
  if (!state?.uid || state.exp < Date.now()) return fail('That sign-in has expired. Try again.', 401);
  if (!sameBytes(fromB64url(String(body.client_mac || '')), fromB64url(state.mac))) return fail('Wrong username or password.', 401);

  const used = await db.execute({
    sql: 'INSERT INTO login_used (proof, at) VALUES (?, ?) ON CONFLICT(proof) DO NOTHING',
    args: [await sha256(String(body.state)), Date.now()]
  });
  if (!used.rowsAffected) return fail('That sign-in was already used. Try again.', 401);
  context.waitUntil(db.execute({ sql: 'DELETE FROM login_used WHERE at < ?', args: [Date.now() - LOGIN_TTL_MS] }).catch(() => {}));

  const user = (await db.execute({ sql: 'SELECT id, username, public_key, private_key_box FROM users WHERE id = ?', args: [state.uid] })).rows[0];
  return user || fail('Wrong username or password.', 401);
}

// A signed-in session for the account, with what the browser needs to unlock
// its end-to-end keys.
export async function sessionFor(user, env) {
  return {
    success: true,
    token: await signToken({ username: user.username, userId: user.id }, env),
    userId: String(user.id),
    username: user.username,
    publicKey: user.public_key || null,
    privateKeyBox: user.private_key_box || null,
  };
}

export async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}
