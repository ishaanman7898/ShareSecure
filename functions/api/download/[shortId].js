// GET /api/download/:shortId — save the file, when its owner allows downloads.
import { serveFile } from '../../_serve.js';

export async function onRequestGet(context) {
  return serveFile(context, { disposition: 'attachment' });
}
