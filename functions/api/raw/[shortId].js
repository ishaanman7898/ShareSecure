// GET /api/raw/:shortId — the file's bytes for the viewer (PDF.js, images, DOCX).
import { serveFile } from '../../_serve.js';

export async function onRequestGet(context) {
  // only same-origin fetches from the viewer; typing the URL in gets nothing
  if (context.request.headers.get('Sec-Fetch-Mode') === 'navigate') {
    return new Response('Direct access not allowed', { status: 403 });
  }
  return serveFile(context, { disposition: 'inline' });
}
