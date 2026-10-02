// /api/keys — end-to-end encryption keys for accounts.
//
//   GET  ?username=alice   alice's public key, so you can seal a file to her.
//                          No sign-in needed: public keys are public, and
//                          looking one up shouldn't say who's about to send.
//   GET                    your own public key and locked private key
//   POST { public_key, private_key_box }
//                          save your key pair. The private key arrives locked
//                          with the export key from signing in, which never
//                          leaves the browser, so the server can't use it.
//
// Keys can only be set once per account. Replacing them would make files
// already sealed to the old key unreadable, and would let someone holding a
// stolen session swap in their own key to receive files meant for you.
import { getDb, verifyToken, ensureUserColumns, findUser } from '../../_turso.js';
import { isSealed, isPublicKey } from '../../../public/sealed.js';

const fail = (error, status) => Response.json({ error }, { status });

export async function onRequestGet(context) {
  const { request, env } = context;
  const db = getDb(env);
  await ensureUserColumns(db);

  const username = new URL(request.url).searchParams.get('username');
  if (username) {
    const user = await findUser(db, username.trim().replace(/^@/, ''), 'username, public_key');
    if (!user) return fail('User not found', 404);
    return Response.json({ username: user.username, publicKey: user.public_key || null });
  }
  const auth = await verifyToken(request.headers.get('Authorization'), env);
  if (!auth) return fail('Sign in first.', 401);
  const me = (await db.execute({ sql: 'SELECT public_key, private_key_box FROM users WHERE id = ?', args: [auth.userId] })).rows[0];
  return Response.json({ publicKey: me?.public_key || null, privateKeyBox: me?.private_key_box || null });
}

// Setting keys needs a sign-in from the last 10 minutes, so an old session
// someone stole can't put in keys of their own for an account that has none.
const FRESH_S = 10 * 60;

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = await verifyToken(request.headers.get('Authorization'), env);
  if (!auth) return fail('Sign in first.', 401);
  if (Date.now() / 1000 - auth.issuedAt > FRESH_S) return fail('Sign in again to set up your keys.', 401);

  let body;
  try { body = await request.json(); } catch { return fail('Send JSON.', 400); }
  if (!isPublicKey(body.public_key) || !isSealed(body.private_key_box) || body.private_key_box.length > 1000) {
    return fail('That isn’t a valid key pair.', 400);
  }

  const db = getDb(env);
  await ensureUserColumns(db);
  const saved = await db.execute({
    sql: 'UPDATE users SET public_key = ?, private_key_box = ? WHERE id = ? AND public_key IS NULL',
    args: [body.public_key, body.private_key_box, auth.userId]
  });
  if (!saved.rowsAffected) return fail('This account already has keys.', 409);
  return Response.json({ saved: true });
}
