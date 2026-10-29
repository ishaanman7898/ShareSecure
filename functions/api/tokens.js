// /api/tokens — anonymous tokens for uploads and sends (see _tokens.js).
//   GET                         the signing key, and how many you can still get today
//   POST { kind, blinded }      sign one blinded token, if today's limit allows
// One token per request keeps each request well inside Cloudflare's CPU limit.
import { getDb, verifyToken, getUserTag, countUploadsToday } from '../_turso.js';
import { getIssuer, blindSign, issuerAccount, issuedToday, ensureTokenTables, DAILY, today } from '../_tokens.js';
import { fromB64url, toB64url } from '../../public/sealed.js';

const fail = (error, status) => Response.json({ error }, { status });

// What's left today. Uploads made while signed in count too, so the daily
// limit is the same however a file is shared.
async function left(db, auth, env) {
  const account = await issuerAccount(auth.userId, env);
  const uploads = await issuedToday(db, account, 'upload')
    + await countUploadsToday(auth.userId, await getUserTag(auth.userId, env), env);
  return { upload: Math.max(0, DAILY.upload - uploads), send: Math.max(0, DAILY.send - await issuedToday(db, account, 'send')) };
}

// The key is the same for everyone and public, so anyone can check it (the
// apps compare it with the one pinned in their code: a server handing different
// people different keys could tell their tokens apart). What's left today
// needs signing in.
export async function onRequestGet(context) {
  const { env, request } = context;
  const key = await getIssuer(env);
  if (!key) return Response.json({ available: false });
  const auth = await verifyToken(request.headers.get('Authorization'), env);
  return Response.json({
    available: true, publicKey: key.publicJwk, keyId: key.keyId, day: today(),
    ...(auth ? { left: await left(getDb(env), auth, env) } : {}),
  });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const auth = await verifyToken(request.headers.get('Authorization'), env);
  if (!auth) return fail('Sign in first.', 401);
  const key = await getIssuer(env);
  if (!key) return fail('Tokens aren’t set up on this server.', 503);

  const body = await request.json().catch(() => ({}));
  const kind = body.kind;
  if (!DAILY[kind]) return fail('kind must be upload or send', 400);
  let blinded;
  try { blinded = fromB64url(String(body.blinded || '')); } catch { return fail('Bad token request.', 400); }

  const db = getDb(env);
  await ensureTokenTables(db);
  if ((await left(db, auth, env))[kind] <= 0) return fail('That’s all for today.', 429);

  // write the count down first, so several requests at once can't all get one
  const account = await issuerAccount(auth.userId, env);
  await db.execute({
    sql: `INSERT INTO token_issued (account, kind, day, count) VALUES (?, ?, ?, 1)
          ON CONFLICT(account, kind, day) DO UPDATE SET count = count + 1`,
    args: [account, kind, today()]
  });
  const undo = () => db.execute({
    sql: 'UPDATE token_issued SET count = count - 1 WHERE account = ? AND kind = ? AND day = ?', args: [account, kind, today()]
  }).catch(() => {});
  if ((await left(db, auth, env))[kind] < 0 || (await issuedToday(db, account, kind)) > DAILY[kind]) {
    await undo();
    return fail('That’s all for today.', 429);
  }

  try {
    return Response.json({ signature: toB64url(blindSign(key, blinded)), day: today() });
  } catch {
    await undo();
    return fail('Bad token request.', 400);
  }
}
