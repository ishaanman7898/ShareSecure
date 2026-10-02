// POST /api/auth/upgrade/finish { access_code, record, public_key?, private_key_box? }
// Saves an older account's new sign-in record and drops its password hash for
// good. It needs the old password, not just a session: otherwise anyone holding
// a stolen session could put in a record of their own and take the account.
import { getDb, verifyToken, ensureUserColumns, checkAccessCode } from '../../../_turso.js';
import { recordFrom, keyPairFrom, ensureAuthTables, attemptKeys, tooManyTries, readJson, fail } from '../../../_auth.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = await verifyToken(request.headers.get('Authorization'), env);
  if (!auth) return fail('Sign in first.', 401);
  const body = await readJson(request);
  const record = recordFrom(body);
  const keys = keyPairFrom(body);
  if (!record || keys === false) return fail('That request is malformed.');

  const db = getDb(env);
  await ensureUserColumns(db);
  await ensureAuthTables(db);
  // guesses here count against the same limits as signing in
  if (await tooManyTries(db, await attemptKeys(request, auth.username, env), context)) {
    return fail('Too many attempts. Try again in a few minutes.', 429);
  }
  const user = (await db.execute({ sql: 'SELECT access_code, opaque_record FROM users WHERE id = ?', args: [auth.userId] })).rows[0];
  if (!user || user.opaque_record) return fail('This account already signs in without sending its password.', 409);
  if (!(await checkAccessCode(String(body.access_code || ''), user.access_code, env)).ok) return fail('Wrong password.', 403);

  await db.execute({
    sql: "UPDATE users SET opaque_record = ?, access_code = 'opaque' WHERE id = ? AND opaque_record IS NULL",
    args: [record, auth.userId]
  });
  if (keys) {
    await db.execute({
      sql: 'UPDATE users SET public_key = ?, private_key_box = ? WHERE id = ? AND public_key IS NULL',
      args: [keys.publicKey, keys.box, auth.userId]
    });
  }
  return Response.json({ upgraded: true });
}
