// POST /share-target — normally caught by the installed app's service worker
// (public/sw.js) and never reaches here. If it does (the worker was cleared),
// nothing is kept: back to the upload page, which says to try again.
export const onRequestPost = () => new Response(null, { status: 303, headers: { Location: '/?shared=failed' } });
