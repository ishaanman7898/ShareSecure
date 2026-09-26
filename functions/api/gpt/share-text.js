// POST /api/gpt/share-text — share text the GPT wrote (or has in the
// conversation) as a .md, .txt or .csv document, and send it to people.
import { shareWrittenText } from '../../_mcp.js';
import { gptUser, unauthorized } from './_auth.js';

export async function onRequestPost(context) {
  const user = await gptUser(context);
  if (!user) return unauthorized();

  let body;
  try { body = await context.request.json(); } catch { return Response.json({ error: 'Send JSON.' }, { status: 400 }); }
  try {
    const result = await shareWrittenText(user, body || {}, context);
    return Response.json(result, { status: result.error ? 400 : 200 });
  } catch (err) {
    console.error('gpt share-text failed', err);
    return Response.json({ error: 'Something went wrong. Try again.' }, { status: 500 });
  }
}
