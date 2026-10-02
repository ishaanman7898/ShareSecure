// POST /api/auth/login { username, access_code } — the old way of signing in,
// which sends the password. It only works for accounts made before sign-in
// switched to OPAQUE, and only so they can switch: the browser signs in this
// way once, then saves an OPAQUE record and the password hash is dropped
// (see /api/auth/upgrade and public/opaque.js).
import { getDb, checkAccessCode, findUser, ensureUserColumns } from '../../_turso.js';
import { ensureAuthTables, attemptKeys, tooManyTries, forgiveTries, sessionFor, readJson, fail } from '../../_auth.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await readJson(request);
  if (!body?.username || !body?.access_code) return fail('Username and access code required');
  if (!env.TOKEN_SECRET) return fail('Sign-in isn’t set up on this server yet.', 503);

  try {
    const db = getDb(env);
    await ensureAuthTables(db);
    await ensureUserColumns(db);
    const tries = await attemptKeys(request, body.username, env);
    if (await tooManyTries(db, tries, context)) return fail('Too many attempts. Try again in a few minutes.', 429);

    const user = await findUser(db, body.username, 'id, username, access_code, opaque_record, public_key, private_key_box');
    // accounts that have switched never take a password again
    if (user?.opaque_record) return fail('This account signs in without sending its password. Update ShareSecure and try again.', 401, { code: 'opaque_only' });
    const { ok } = user ? await checkAccessCode(String(body.access_code), user.access_code, env) : { ok: false };
    if (!ok) return fail('Wrong username or password.', 401);

    await forgiveTries(db, tries);
    return Response.json(await sessionFor(user, env));
  } catch (err) {
    console.error('Login error:', err.message);
    return fail('Login failed', 500);
  }
}
