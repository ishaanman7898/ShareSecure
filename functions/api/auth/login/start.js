// POST /api/auth/login/start — the first half of signing in (see _auth.js).
import { loginStart, readJson, fail } from '../../../_auth.js';

export async function onRequestPost(context) {
  if (!context.env.TOKEN_SECRET) return fail('Sign-in isn’t set up on this server yet.', 503);
  const body = await readJson(context.request);
  if (!body) return fail('Invalid request body');
  try {
    return await loginStart(context, body);
  } catch (err) {
    console.error('login start failed', err);
    return fail('Sign-in failed. Try again.', 500);
  }
}
