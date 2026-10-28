// GET /l/<computer>/r/<id> — a link to a ShareSecure on someone's own
// computer (the desktop app, or a self-hosted copy). The viewer comes from
// here, like any link; it loads the file from that computer through
// ShareSecure's relay (relay/), locked end to end, with the key after "#".
// This site never sees the file, and doesn't look the link up: only the
// computer knows its links.
import { overPublicLimit } from '../_auth.js';

export async function onRequestGet(context) {
  const { params, request, env } = context;
  const page = name => env.ASSETS.fetch(new URL(name, new URL(request.url).origin));
  const [computer, kind, id, ...rest] = Array.isArray(params.path) ? params.path : [];
  if (!/^[A-Za-z0-9_-]{22}$/.test(computer || '') || kind !== 'r' || !/^[A-Za-z0-9_-]{4,64}$/.test(id || '') || rest.length) {
    return page('/404.html');
  }
  if (await overPublicLimit(context, 'lookup')) {
    return new Response('Too many links opened from here. Try again in a few minutes.', { status: 429, headers: { 'Retry-After': '900' } });
  }
  return page('/viewer.html');
}
