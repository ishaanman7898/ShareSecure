// POST /api/gpt/delete { id } — delete one of the account's shares, and every link to it.
import { deleteShare } from '../../_mcp.js';
import { gptUser, unauthorized } from './_auth.js';

export async function onRequestPost(context) {
  const user = await gptUser(context);
  if (!user) return unauthorized();
  const { id } = await context.request.json().catch(() => ({}));
  if (!id) return Response.json({ error: 'id is required' }, { status: 400 });
  return (await deleteShare(user, String(id), context))
    ? Response.json({ deleted: true })
    : Response.json({ error: `No share with id ${id} on this account.` }, { status: 404 });
}
