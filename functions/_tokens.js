// Anonymous tokens for uploads and sends (Privacy Pass style, blind RSA).
// public/blindrsa.js explains the idea. Here: the server signs blinded tokens
// for signed-in accounts (a few a day), and later accepts spent tokens without
// knowing whose they are. Each token works once.
//
// The signing key is TOKEN_ISSUER_KEY: an RSA-2048 private key, PKCS#8 in
// base64 (make one with `npm run token-key`). Without it, uploads and sends
// just use the signed-in session instead.
import { getDb, migrateOnce, getUserTag, sha256 } from './_turso.js';
import { bytesToInt, intToBytes, powMod, invMod, randomBelow, tokenMessage } from '../public/blindrsa.js';
import { fromB64url, toB64url } from '../public/sealed.js';

export const DAILY = { upload: 5, send: 60 };
const DAY_MS = 24 * 60 * 60 * 1000;
export const today = () => Math.floor(Date.now() / DAY_MS);

export const ensureTokenTables = db => migrateOnce('tokens', db, [
  // how many tokens each account was given today (the account as a keyed hash)
  `CREATE TABLE IF NOT EXISTS token_issued (
     account TEXT NOT NULL, kind TEXT NOT NULL, day INTEGER NOT NULL, count INTEGER NOT NULL,
     PRIMARY KEY (account, kind, day))`,
  // tokens already spent; kept two days, as long as a token can be spent
  'CREATE TABLE IF NOT EXISTS token_spent (nonce TEXT PRIMARY KEY, day INTEGER NOT NULL)',
]);

export const issuerAccount = (userId, env) => getUserTag(`issue:${userId}`, env);

// ── the key ──────────────────────────────────────────────────────────────────
let issuer = null;

export async function getIssuer(env) {
  if (!env.TOKEN_ISSUER_KEY) return null;
  if (issuer?.from === env.TOKEN_ISSUER_KEY) return issuer;
  const key = await crypto.subtle.importKey('pkcs8', fromB64url(env.TOKEN_ISSUER_KEY.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')),
    { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  const big = k => bytesToInt(fromB64url(jwk[k]));
  const publicJwk = { kty: 'RSA', n: jwk.n, e: jwk.e };
  const n = big('n');
  issuer = {
    from: env.TOKEN_ISSUER_KEY,
    n, e: big('e'), p: big('p'), q: big('q'), dp: big('dp'), dq: big('dq'), qi: big('qi'),
    size: Math.ceil(n.toString(16).length / 2),
    publicJwk,
    keyId: toB64url(await crypto.subtle.digest('SHA-256', fromB64url(jwk.n))),
    verifyKey: await crypto.subtle.importKey('jwk', { ...publicJwk, alg: 'PS384' }, { name: 'RSA-PSS', hash: 'SHA-384' }, false, ['verify']),
  };
  return issuer;
}

// RSA signature on a blinded message (RFC 9474 BlindSign). The message is
// blinded again here too (r^e), so the time this takes says nothing about the
// key, and the result is checked before it's sent back.
export function blindSign(key, blindedBytes) {
  const m = bytesToInt(blindedBytes);
  if (blindedBytes.length !== key.size || m >= key.n) throw new Error('bad blinded message');
  const r = randomBelow(key.n);
  const mr = m * powMod(r, key.e, key.n) % key.n;
  const s1 = powMod(mr, key.dp, key.p), s2 = powMod(mr, key.dq, key.q);
  const sr = s2 + ((key.qi * (s1 - s2)) % key.p + key.p) % key.p * key.q;
  const s = sr * invMod(r, key.n) % key.n;
  if (powMod(s, key.e, key.n) !== m) throw new Error('signing failed');
  return intToBytes(s, key.size);
}

// ── spending a token ─────────────────────────────────────────────────────────
// The header is "X-ShareSecure-Token: <kind>.<day>.<nonce>.<signature>".
// → true when it's a good, unspent token for this kind (and it's now spent).
export async function spendToken(request, env, kind) {
  const header = request.headers.get('X-ShareSecure-Token');
  if (!header) return false;
  const key = await getIssuer(env);
  if (!key) return false;
  const [k, dayText, nonceText, sigText] = header.split('.');
  const day = Number(dayText);
  if (k !== kind || !Number.isInteger(day) || (day !== today() && day !== today() - 1)) return false;
  let nonce, sig;
  try { nonce = fromB64url(nonceText); sig = fromB64url(sigText); } catch { return false; }
  if (nonce.length !== 32 || sig.length !== key.size) return false;
  const ok = await crypto.subtle.verify({ name: 'RSA-PSS', saltLength: 48 }, key.verifyKey, sig, tokenMessage(kind, day, key.keyId, nonce));
  if (!ok) return false;

  const db = getDb(env);
  await ensureTokenTables(db);
  const spent = await db.execute({
    sql: 'INSERT INTO token_spent (nonce, day) VALUES (?, ?) ON CONFLICT(nonce) DO NOTHING',
    args: [await sha256(nonceText), day]
  });
  if (Math.random() < 0.05) db.execute({ sql: 'DELETE FROM token_spent WHERE day < ?', args: [today() - 2] }).catch(() => {});
  return spent.rowsAffected === 1;
}

// How many tokens of a kind the account was given today.
export async function issuedToday(db, account, kind) {
  await ensureTokenTables(db);
  const row = (await db.execute({
    sql: 'SELECT count FROM token_issued WHERE account = ? AND kind = ? AND day = ?', args: [account, kind, today()]
  })).rows[0];
  return Number(row?.count || 0);
}
