export async function onRequestGet(context) {
  const { params, env, request } = context;
  const origin = new URL(request.url).origin;

  const file = await env.DB.prepare(
    'SELECT short_id, expires_at, is_active FROM files WHERE short_id = ?'
  ).bind(params.shortId).first();

  if (!file || !file.is_active) {
    return env.ASSETS.fetch(new URL('/404.html', origin));
  }

  if (file.expires_at && new Date(file.expires_at) < new Date()) {
    return env.ASSETS.fetch(new URL('/expired.html', origin));
  }

  // Serve the static viewer page — shortId is read from the URL by viewer.js
  return env.ASSETS.fetch(new URL('/viewer.html', origin));
}
