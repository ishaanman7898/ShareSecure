// GET /api/gpt/shares — the account's live shares, for the custom GPT.
import { liveShares } from '../../_mcp.js';
import { gptUser, unauthorized } from './_auth.js';

export async function onRequestGet(context) {
  const user = await gptUser(context);
  if (!user) return unauthorized();
  return Response.json({ shares: await liveShares(user, context) });
}
