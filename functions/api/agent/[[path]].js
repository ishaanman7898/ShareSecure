// /api/agent/* — for the local ShareSecure MCP server (packages/sharesecure-mcp),
// which encrypts and decrypts on the user's own computer. Signed in with the
// same personal token as /mcp ("Authorization: Bearer ss_…").
//
// Everything that crosses here is already sealed: uploads must be end-to-end
// encrypted, and file keys arrive sealed to each recipient. So unlike /mcp, the
// server never sees a file or a key, not even for a moment.
//
//   GET    me                 { username, publicKey }
//   POST   upload             multipart, as /api/upload with e2e=1
//   POST   send/:id           { recipients: [{ username, sealed_key }], note }
//   GET    shares             live shares, with names and keys still sealed
//   DELETE shares/:id
//   GET    inbox              files sent to the account, still sealed
//   POST   inbox/:id          { action: 'accept' | 'decline' }
//   GET    file/:id           the sealed bytes of an own share or accepted file
//
// Sends follow the account's rules for assistants (see _agent.js).
import { getDb, ensureUserColumns } from '../../_turso.js';
import { userForToken, sessionHeader, deliver, inboxFiles, answerRequest, deleteShare } from '../../_mcp.js';
import { onRequestPost as uploadHandler } from '../upload.js';
import { onRequestGet as sharesHandler } from '../auth/user/files.js';
import { serveFile } from '../../_serve.js';
import { isSealed } from '../../../public/sealed.js';

const fail = (error, status) => Response.json({ error }, { status });
const ID = /^[A-Za-z0-9]{4,32}$/;

// a request for one of the regular endpoints, signed in as the token's account
async function asUser(context, user, path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', await sessionHeader(user, context.env));
  return new Request(new URL(path, context.request.url), { ...init, headers });
}
const forward = (context, request, params = {}) => ({ request, env: context.env, params, waitUntil: p => context.waitUntil(p) });

export async function onRequest(context) {
  const { request, env } = context;
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return fail('Origin not allowed', 403);
  const user = await userForToken(request.headers.get('Authorization'), env);
  if (!user) return fail('Missing or invalid ShareSecure token. Create one in the account menu under Connect an AI assistant.', 401);

  const [route, id, ...rest] = Array.isArray(context.params.path) ? context.params.path : [];
  if (rest.length || (id !== undefined && !ID.test(id))) return fail('Not found', 404);
  const method = request.method;

  try {
    if (route === 'me' && method === 'GET' && !id) {
      const db = getDb(env);
      await ensureUserColumns(db);
      const row = (await db.execute({ sql: 'SELECT public_key FROM users WHERE id = ?', args: [user.userId] })).rows[0];
      return Response.json({ username: user.username, publicKey: row?.public_key || null });
    }

    if (route === 'upload' && method === 'POST' && !id) {
      let form;
      try { form = await request.formData(); } catch { return fail('Send the file as multipart form data.', 400); }
      // only sealed files: the point of this endpoint is that the server can't read them
      if (form.get('e2e') !== '1' || !isSealed(String(form.get('meta') || ''))) {
        return fail('Encrypt the file before uploading it (e2e=1, with its name and type sealed in meta).', 400);
      }
      const res = await uploadHandler(forward(context, await asUser(context, user, '/api/upload', { method: 'POST', body: form })));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return fail(data.error || `Upload failed (${res.status})`, res.status);
      return Response.json({ id: data.shortId, url: data.shortUrl, expires_at: data.expiresAt });
    }

    if (route === 'send' && method === 'POST' && id) {
      const body = await request.json().catch(() => null);
      const list = Array.isArray(body?.recipients) ? body.recipients.slice(0, 20) : [];
      if (!list.length) return fail('recipients needs at least one { username, sealed_key }.', 400);
      const note = body.note ? String(body.note) : null;
      const entries = list.map(r => ({
        username: String(r?.username || '').trim().replace(/^@/, ''),
        body: { targetUsername: String(r?.username || '').trim().replace(/^@/, ''), ...(r?.sealed_key ? { sealed_key: String(r.sealed_key) } : {}), ...(note ? { note } : {}) },
      })).filter(e => e.username);
      return Response.json(await deliver(user, id, entries, context));
    }

    if (route === 'shares' && method === 'GET' && !id) {
      const res = await sharesHandler(forward(context, await asUser(context, user, '/api/auth/user/files')));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return fail(data.error || 'Couldn’t load shares.', res.status);
      const base = new URL(request.url).origin;
      return Response.json({
        shares: (data.files || []).map(f => ({
          id: f.short_id, url: `${base}/r/${f.short_id}`, expires_at: f.expires_at, private: f.e2e,
          name: f.e2e ? null : f.original_filename, sealed_name: f.e2e ? f.original_filename : null, owner_key: f.owner_key,
        })),
      });
    }

    if (route === 'shares' && method === 'DELETE' && id) {
      return (await deleteShare(user, id, context)) ? Response.json({ deleted: true }) : fail(`No share with id ${id} on this account.`, 404);
    }

    if (route === 'inbox' && method === 'GET' && !id) {
      return Response.json({ files: await inboxFiles(user, context) });
    }

    if (route === 'inbox' && method === 'POST' && id) {
      const { action } = await request.json().catch(() => ({}));
      const out = await answerRequest(user, id, action, context);
      return out.error ? fail(out.error, 400) : Response.json({ done: true, message: out.text });
    }

    if (route === 'file' && method === 'GET' && id) {
      return serveFile(forward(context, await asUser(context, user, `/api/raw/${id}`), { shortId: id }), { disposition: 'inline' });
    }
  } catch (err) {
    console.error('agent api failed', route, err);
    return fail('Something went wrong. Try again.', 500);
  }
  return fail('Not found', 404);
}
