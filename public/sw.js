// The installed app's only service worker job: catching what's shared to it
// from the phone's Share button (manifest.webmanifest → share_target).
//
// It caches nothing else and touches no other request, so every page and file
// still comes straight from the site (and `npm run verify-site` still checks
// what runs). What's shared waits in a cache that only this site can read,
// for the upload page to pick up and clear straight away; nothing is uploaded
// until you choose to share it.
const INBOX = 'shared-to-app';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.origin !== location.origin || url.pathname !== '/share-target') return;
  event.respondWith((async () => {
    try {
      const form = await event.request.formData();
      const cache = await caches.open(INBOX);
      // anything left from a share that was never picked up goes first
      for (const old of await cache.keys()) await cache.delete(old);
      let n = 0;
      for (const file of form.getAll('files')) {
        if (typeof file === 'string' || !file.size) continue;
        await cache.put(`/shared/${n++}`, new Response(file, {
          headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Name': encodeURIComponent(file.name || 'file') },
        }));
      }
      // a shared page or note, with no file, arrives as text
      const text = [form.get('title'), form.get('text'), form.get('url')].filter(v => typeof v === 'string' && v.trim()).join('\n');
      if (!n && text) {
        await cache.put('/shared/0', new Response(text, { headers: { 'Content-Type': 'text/plain', 'X-Name': encodeURIComponent('Shared text.txt') } }));
      }
      return Response.redirect('/?shared=1', 303);
    } catch {
      return Response.redirect('/?shared=failed', 303);
    }
  })());
});
