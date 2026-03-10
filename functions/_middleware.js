export async function onRequest(context) {
  const response = await context.next();
  const h = new Headers(response.headers);

  // never cache anything — no browser history of file content
  h.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  h.set('Pragma', 'no-cache');

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
