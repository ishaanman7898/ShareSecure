// /q/<id> — a file request's upload page. The page is static; it reads the id
// from the address, and the request key and the owner's public key from after "#".
export async function onRequestGet(context) {
  const { request, env } = context;
  return env.ASSETS.fetch(new URL('/request.html', new URL(request.url).origin));
}
