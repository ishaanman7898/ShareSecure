// /api/requests — file requests (see _requests.js).
//   GET    /api/requests              your open requests            (signed in)
//   POST   /api/requests              open one: { label, owner_box, max_files, hours, file_hours }, sealed in your browser
//   DELETE /api/requests/:id          close one; files already received stay
//   GET    /api/requests/:id          what the upload page shows    (anyone with the link)
//   POST   /api/requests/:id/upload   one sealed file (multipart: file, meta, inbox_key, note?)
import { verifyToken } from '../../_turso.js';
import { openRequest, listRequests, closeRequest, requestInfo, receive } from '../../_requests.js';

const fail = (error, status) => Response.json({ error }, { status });
const ID = /^[A-Za-z0-9]{6,32}$/;

export async function onRequest(context) {
  const { request, env } = context;
  const [id, action, ...rest] = Array.isArray(context.params.path) ? context.params.path : [];
  if (rest.length || (id !== undefined && !ID.test(id))) return fail('Not found', 404);
  const method = request.method;

  try {
    // anyone with the link: see the request, and send a file to it
    if (id && !action && method === 'GET') {
      const info = await requestInfo(id, env);
      return info ? Response.json(info) : fail('This file request doesn’t exist, or was closed.', 404);
    }
    if (id && action === 'upload' && method === 'POST') {
      const origin = request.headers.get('Origin');
      if (origin && origin !== new URL(request.url).origin) return fail('Origin not allowed', 403);
      let form;
      try { form = await request.formData(); } catch { return fail('Send the file as multipart form data.', 400); }
      const out = await receive(id, form, env);
      return out.error ? fail(out.error, out.status) : Response.json(out);
    }

    // the owner
    const auth = await verifyToken(request.headers.get('Authorization'), env);
    if (!auth) return fail('Sign in first.', 401);
    if (!id && method === 'GET') return Response.json({ requests: await listRequests(auth.userId, env) });
    if (!id && method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body) return fail('Send JSON.', 400);
      const out = await openRequest(auth.userId, body, env);
      return out.error ? fail(out.error, out.status) : Response.json(out);
    }
    if (id && !action && method === 'DELETE') {
      return (await closeRequest(auth.userId, id, env)) ? Response.json({ closed: true }) : fail('No open request with that id.', 404);
    }
  } catch (err) {
    console.error('requests api failed', err);
    return fail('Something went wrong. Try again.', 500);
  }
  return fail('Not found', 404);
}
