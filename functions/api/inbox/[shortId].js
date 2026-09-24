// POST /api/inbox/:shortId  { action: 'accept' | 'decline' }
// Only the recipient can act on a file request. Accepting makes the file
// viewable; declining erases it immediately.
import { getFilesClient, verifyToken, getUserTag, deleteBranch } from '../../_turso.js';

export async function onRequestPost(context) {
  const { env, request, params } = context;

  const auth = await verifyToken(request.headers.get('Authorization'), env);
  if (!auth) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  let body;
  try { body = await request.json(); } catch { body = {}; }
  const action = body.action;
  if (action !== 'accept' && action !== 'decline') {
    return Response.json({ error: 'action must be accept or decline' }, { status: 400 });
  }

  const userTag = await getUserTag(auth.userId, env);
  const client = getFilesClient(env);

  const res = await client.execute({
    sql: `SELECT short_id FROM files
          WHERE short_id = ? AND recipient_user_tag = ? AND inbox_status = 'pending'
            AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    args: [params.shortId, userTag]
  });
  if (!res.rows[0]) return Response.json({ error: 'Request not found' }, { status: 404 });

  if (action === 'accept') {
    await client.execute({
      sql: "UPDATE files SET is_active = 1, inbox_status = 'accepted' WHERE short_id = ?",
      args: [params.shortId]
    });
    return Response.json({ accepted: true });
  }

  // declining erases this copy and anything reshared from it
  await deleteBranch(client, { short_id: params.shortId, cluster_id: null });
  return Response.json({ declined: true });
}
