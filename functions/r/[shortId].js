import { getClientById } from '../_turso.js';

export async function onRequestGet(context) {
  const { params, request, env } = context;
  const origin = new URL(request.url).origin;
  const client = await getClientById(params.shortId, env);

  const res = await client.execute({
    sql: 'SELECT short_id, expires_at, is_active FROM files WHERE short_id = ?',
    args: [params.shortId]
  });

  const file = res.rows[0];

  if (!file || !file.is_active) {
    return env.ASSETS.fetch(new URL('/404.html', origin));
  }

  if (file.expires_at && new Date(file.expires_at) < new Date()) {
    return env.ASSETS.fetch(new URL('/expired.html', origin));
  }

  // serve the static viewer page — shortid is read from the url by viewer.js
  return env.ASSETS.fetch(new URL('/viewer.html', origin));
}
