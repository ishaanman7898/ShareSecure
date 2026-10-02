// POST /api/auth/login/finish { state, client_mac } — the browser's proof that
// it knew the password. Gives back a session.
import { checkProof, sessionFor, attemptKeys, forgiveTries, readJson, fail } from '../../../_auth.js';
import { getDb } from '../../../_turso.js';

export async function onRequestPost(context) {
  const body = await readJson(context.request);
  if (!body) return fail('Invalid request body');
  const user = await checkProof(context, body);
  if (user instanceof Response) return user;
  await forgiveTries(getDb(context.env), await attemptKeys(context.request, user.username, context.env));
  return Response.json(await sessionFor(user, context.env));
}
