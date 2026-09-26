// POST /api/gpt/send { id, send_to, note } — send one of the account's shares
// to ShareSecure usernames. Each gets their own copy to accept or decline.
import { sendShare } from '../../_mcp.js';
import { gptUser, unauthorized } from './_auth.js';

export async function onRequestPost(context) {
  const user = await gptUser(context);
  if (!user) return unauthorized();

  let body;
  try { body = await context.request.json(); } catch { return Response.json({ error: 'Send JSON.' }, { status: 400 }); }
  try {
    const result = await sendShare(user, body || {}, context);
    return Response.json(result, { status: result.error ? 400 : 200 });
  } catch (err) {
    console.error('gpt send failed', err);
    return Response.json({ error: 'Something went wrong. Try again.' }, { status: 500 });
  }
}
