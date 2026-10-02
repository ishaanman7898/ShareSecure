// POST /api/inbox/:shortId  { action: 'accept' | 'decline' }
// Only the recipient can answer a file request. Accepting makes the file
// viewable; declining erases it right away.
import { getDb, verifyToken, getUserTag, deleteBranch } from '../../_turso.js';

export async function onRequestPost(context) {
  const { env, request, params } = context;
  const auth = await verifyToken(request.headers.get('Authorization'), env);
  if (!auth) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { action } = await request.json().catch(() => ({}));
  if (action !== 'accept' && action !== 'decline') {
    return Response.json({ error: 'action must be accept or decline' }, { status: 400 });
  }

  const db = getDb(env);
  const found = (await db.execute({
    sql: `SELECT short_id FROM files
          WHERE short_id = ? AND recipient_user_tag = ? AND inbox_status = 'pending'
            AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    args: [params.shortId, await getUserTag(auth.userId, env)]
  })).rows[0];
  if (!found) return Response.json({ error: 'Request not found' }, { status: 404 });

  if (action === 'decline') {
    await deleteBranch(db, params.shortId, env);
    return Response.json({ declined: true });
  }
  // the sender tag only limits waiting requests, so it goes once one is accepted
  await db.execute({
    sql: "UPDATE files SET is_active = 1, inbox_status = 'accepted', sender_tag = NULL WHERE short_id = ?",
    args: [params.shortId]
  });
  return Response.json({ accepted: true });
}
