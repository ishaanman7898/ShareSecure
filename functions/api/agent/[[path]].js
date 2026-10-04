// /api/agent/* — for the local ShareSecure MCP server (packages/sharesecure-mcp),
// which encrypts and decrypts on the user's own computer. Signed in with the
// same personal token as /mcp ("Authorization: Bearer ss_…").
//
// It's only for what has to be tied to the account: picking up anonymous
// tokens, the account's own sealed boxes (its list of shares, its rules and
// held sends), its inbox and its file requests. The local server uploads and
// sends with anonymous tokens on the regular endpoints, like the website
// does, so the server can't tell those came from this account.
//
//   GET      me                 { username, publicKey }
//   GET|POST tokens             anonymous upload and send tokens, as /api/tokens
//   GET|PUT  vault              the account's list of shares, sealed to its own key
//   GET      rules              { mode, allowed_box } (the list sealed to the account's key)
//   POST     hold               { box }: a send kept for the owner's OK, sealed to their key
//   GET      shares             shares tied to the account, names and keys still sealed
//   DELETE   shares/:id
//   GET      inbox              files sent to the account, still sealed
//   POST     inbox/:id          { action: 'accept' | 'decline' }
//   GET      file/:id           the sealed bytes of an accepted file
//   POST     requests           open a file request; label and key sealed here
import { getDb, ensureUserColumns } from '../../_turso.js';
import { userForToken, sessionHeader, inboxFiles, answerRequest, deleteShare } from '../../_mcp.js';
import { onRequestGet as sharesHandler } from '../auth/user/files.js';
import * as tokensApi from '../tokens.js';
import * as vaultApi from '../vault.js';
import { serveFile } from '../../_serve.js';
import { openRequest } from '../../_requests.js';
import { agentRules, holdSend } from '../../_agent.js';

const fail = (error, status) => Response.json({ error }, { status });
const ID = /^[A-Za-z0-9]{4,32}$/;

// a request for one of the regular endpoints, signed in as the token's account
async function asUser(context, user, path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', await sessionHeader(user, context.env));
  return new Request(new URL(path, context.request.url), { ...init, headers });
}
const forward = (context, request, params = {}) => ({ request, env: context.env, params, waitUntil: p => context.waitUntil(p) });

// the same request body, re-sent signed in as the account
async function relay(context, user, path, handler) {
  const { request } = context;
  const init = { method: request.method, headers: { 'Content-Type': request.headers.get('Content-Type') || 'application/json' } };
  if (!['GET', 'HEAD'].includes(request.method)) init.body = await request.text();
  return handler(forward(context, await asUser(context, user, path, init)));
}

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

    if (route === 'tokens' && !id && (method === 'GET' || method === 'POST')) {
      return relay(context, user, '/api/tokens', method === 'GET' ? tokensApi.onRequestGet : tokensApi.onRequestPost);
    }
    if (route === 'vault' && !id && (method === 'GET' || method === 'PUT')) {
      return relay(context, user, '/api/vault', method === 'GET' ? vaultApi.onRequestGet : vaultApi.onRequestPut);
    }

    if (route === 'rules' && method === 'GET' && !id) return Response.json(await agentRules(user.userId, env));
    if (route === 'hold' && method === 'POST' && !id) {
      const { box } = await request.json().catch(() => ({}));
      const out = await holdSend(user.userId, box, env);
      return out.error ? fail(out.error, 400) : Response.json({ waiting: true, id: out.id });
    }

    if (route === 'shares' && method === 'GET' && !id) {
      const res = await sharesHandler(forward(context, await asUser(context, user, '/api/auth/user/files')));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return fail(data.error || 'Couldn’t load shares.', res.status);
      const base = new URL(request.url).origin;
      return Response.json({
        shares: (data.files || []).map(f => ({
          id: f.short_id, url: `${base}/r/${f.short_id}`, expires_at: f.expires_at, private: f.e2e,
          name: f.e2e ? null : f.original_filename, sealed_name: f.e2e ? f.original_filename : null, owner_key: f.owner_key, delete_token: f.delete_token,
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

    if (route === 'requests' && method === 'POST' && !id) {
      const body = await request.json().catch(() => null);
      if (!body) return fail('Send JSON.', 400);
      const out = await openRequest(user.userId, body, env);
      return out.error ? fail(out.error, out.status) : Response.json(out);
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
