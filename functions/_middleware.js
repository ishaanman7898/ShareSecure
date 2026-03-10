export async function onRequest(context) {
  const response = await context.next();
  const h = new Headers(response.headers);

  // Never cache anything — no browser history of file content
  h.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  h.set('Pragma', 'no-cache');

  // Don't leak referrer to any third-party (QR API sees no referrer)
  h.set('Referrer-Policy', 'no-referrer');

  // Don't let search engines index or cache any link
  h.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');

  // Block framing so files can't be embedded/traced via iframes
  h.set('X-Frame-Options', 'DENY');
  h.set('Content-Security-Policy', "frame-ancestors 'none'");

  // Strip server identity — remove all fingerprinting headers
  h.delete('Server');
  h.delete('X-Powered-By');
  h.delete('CF-Cache-Status');
  h.delete('CF-Ray');
  h.delete('cf-request-id');

  // Prevent content sniffing
  h.set('X-Content-Type-Options', 'nosniff');

  // Strict Transport Security — force HTTPS always
  h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');

  // Permissions Policy — disable all device APIs
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');

  // Cross-Origin policies — maximum isolation
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: h
  });
}
