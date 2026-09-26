// POST /api/alive { ids } → { alive } — which of these links still work, so
// "Your shares" can drop ones deleted elsewhere (a parent link, another device).
// It only answers for ids the caller already has.
import { getFilesClient } from '../_turso.js';

export async function onRequestPost(context) {
  const { ids } = await context.request.json().catch(() => ({}));
  const list = (Array.isArray(ids) ? ids : []).filter(id => /^[A-Za-z0-9]{4,32}$/.test(id)).slice(0, 100);
  if (!list.length) return Response.json({ alive: [] });
  const rows = (await getFilesClient(context.env).execute({
    sql: `SELECT short_id FROM files
          WHERE short_id IN (${list.map(() => '?').join(',')})
            AND (is_active = 1 OR inbox_status = 'pending')
            AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    args: list
  })).rows;
  return Response.json({ alive: rows.map(r => r.short_id) });
}
