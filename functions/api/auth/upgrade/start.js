// POST /api/auth/upgrade/start { blinded } — an older, password-hash account
// moving to sign-in where the server never sees the password. Needs the
// session it just got from signing in the old way.
import { verifyToken } from '../../../_turso.js';
import { startRecord, readJson, fail } from '../../../_auth.js';

export async function onRequestPost(context) {
  const auth = await verifyToken(context.request.headers.get('Authorization'), context.env);
  if (!auth) return fail('Sign in first.', 401);
  const body = await readJson(context.request);
  try {
    return Response.json(await startRecord(context.env, auth.username, body?.blinded));
  } catch {
    return fail('That request is malformed.');
  }
}
