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

  // Strip server identity
  h.delete('Server');
  h.delete('X-Powered-By');
  h.delete('CF-Cache-Status');

  // Prevent content sniffing
  h.set('X-Content-Type-Options', 'nosniff');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: h
  });
}
