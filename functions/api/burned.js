// POST /api/burned { shares: [{ id, delete_token }] } — which of your links that
// work once have been opened, and whether anyone tried them again afterwards.
// The delete key proves each link is yours, so no sign-in is needed.
import { burnNews } from '../_burn.js';

export async function onRequestPost(context) {
  const body = await context.request.json().catch(() => null);
  if (!Array.isArray(body?.shares)) return Response.json({ error: 'Send { shares: [{ id, delete_token }] }.' }, { status: 400 });
  return Response.json({ burned: await burnNews(body.shares, context.env) });
}
