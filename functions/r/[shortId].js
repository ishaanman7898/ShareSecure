// GET /r/:shortId — a share link. Shows the viewer, or a "gone" page if the link
// doesn't exist or has expired. The viewer reads the id (and, for end-to-end
// encrypted files, the key after "#") from the address itself.
import { getDb } from '../_turso.js';
import { wasBurned } from '../_burn.js';

export async function onRequestGet(context) {
  const { params, request, env } = context;
  const page = name => env.ASSETS.fetch(new URL(name, new URL(request.url).origin));

  const file = (await getDb(env).execute({
    sql: 'SELECT expires_at, is_active FROM files WHERE short_id = ?', args: [params.shortId]
  })).rows[0];

  if (!file || !file.is_active) {
    // a link that worked once and was already opened: the viewer says so, and
    // counts the try unless this browser is the one that opened it
    if (!file && await wasBurned(getDb(env), params.shortId)) return page('/viewer.html');
    return page('/404.html');
  }
  if (file.expires_at && new Date(file.expires_at) < new Date()) return page('/expired.html');
  return page('/viewer.html');
}
