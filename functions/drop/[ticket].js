// /drop/<ticket> — the page an assistant hands you to pick the file it's sharing.
// The page itself is static; it reads the ticket from the URL.
export async function onRequestGet(context) {
  const { request, env } = context;
  return env.ASSETS.fetch(new URL('/drop.html', new URL(request.url).origin));
}
