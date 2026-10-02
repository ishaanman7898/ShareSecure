// POST /api/auth/register/start { username, blinded } — the first half of
// making an account. The password never leaves the browser.
import { getDb } from '../../../_turso.js';
import { USERNAME, startRecord, ensureAuthTables, attemptKeys, tooManyTries, readJson, fail } from '../../../_auth.js';

export async function onRequestPost(context) {
  const { env, request } = context;
  const body = await readJson(request);
  const username = String(body?.username || '').trim().normalize('NFKC');
  if (!USERNAME.test(username)) return fail('Usernames are 3 to 32 characters: letters, numbers, dots, dashes and underscores.');

  const db = getDb(env);
  await ensureAuthTables(db);
  // a few new accounts per address, so nobody can make thousands
  if (await tooManyTries(db, await attemptKeys(request, '*', env, 'register'), context)) {
    return fail('Too many new accounts from here. Try again later.', 429);
  }
  const taken = (await db.execute({ sql: 'SELECT id FROM users WHERE lower(username) = lower(?) LIMIT 1', args: [username] })).rows[0];
  if (taken) return fail('Username already exists');
  try {
    return Response.json(await startRecord(env, username, body.blinded));
  } catch {
    return fail('That request is malformed.');
  }
}
