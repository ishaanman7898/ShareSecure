// Cloudflare Pages Function — returns selfHostMode: false so the frontend
// knows it's on a hosted deployment and should require authentication.
// The Express server has its own /api/mode that returns selfHostMode: true.
export async function onRequest() {
  return new Response(JSON.stringify({ selfHostMode: false }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
