// Cloudflare Pages Function — returns selfHostMode: false so the frontend
// knows it's on a hosted deployment and should require authentication.
// The Express server has its own /api/mode that returns selfHostMode: true.
// The version comes from package.json, so the site always shows what's deployed.
import pkg from '../../package.json';

export async function onRequest() {
  return new Response(JSON.stringify({ selfHostMode: false, version: pkg.version }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
