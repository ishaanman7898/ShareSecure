export async function onRequest(context) {
  const response = await context.next();
  const h = new Headers(response.headers);

  // Pages, the API and file content are never cached (no browser history of
  // anything shared). The site's own code, fonts and icons contain nothing
  // private, so browsers keep them: fonts and icons for a week, scripts and
  // styles revalidated on every load so a deploy is picked up at once.
  const path = new URL(context.request.url).pathname;
  const isOwnAsset = !path.startsWith('/api/') && !path.startsWith('/r/');
  if (isOwnAsset && /\.(woff2|png|ico|svg)$/.test(path)) {
    h.set('Cache-Control', 'public, max-age=604800');
  } else if (isOwnAsset && /\.(js|css)$/.test(path)) {
    h.set('Cache-Control', 'public, no-cache');
  } else {
    h.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    h.set('Pragma', 'no-cache');
  }

  // don't leak referrer to any third-party (qr api sees no referrer)
  h.set('Referrer-Policy', 'no-referrer');

  // don't let search engines index or cache any link
  h.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');

  // block framing so files can't be embedded/traced via iframes
  h.set('X-Frame-Options', 'DENY');
  h.set('Content-Security-Policy', "frame-ancestors 'none'");

  // strip server identity — remove all fingerprinting headers
  h.delete('Server');
  h.delete('X-Powered-By');
  h.delete('CF-Cache-Status');
  h.delete('CF-Ray');
  h.delete('cf-request-id');

  // prevent content sniffing
  h.set('X-Content-Type-Options', 'nosniff');

  // install scripts must be served as UTF-8 text so `irm | iex` and `curl | bash` read them correctly
  const { pathname } = new URL(context.request.url);
  if (pathname === '/install.sh' || pathname === '/install.ps1') {
    h.set('Content-Type', 'text/plain; charset=utf-8');
  }

  // strict transport security — force https always
  h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');

  // permissions policy — disable all device apis
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: h
  });
}
