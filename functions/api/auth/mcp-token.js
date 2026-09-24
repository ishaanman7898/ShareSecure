// /api/auth/mcp-token — the personal token assistants use to connect over MCP.
//   GET     whether a token exists
//   POST    create one (replaces any old one); the token is only shown now
//   DELETE  turn assistant access off
import { verifyToken } from '../../_turso.js';
import { tokenStatus, createToken, revokeToken } from '../../_mcp.js';

async function signedIn(context) {
  return verifyToken(context.request.headers.get('Authorization'), context.env);
}

const mcpUrl = request => new URL('/mcp', request.url).href;
// where apps like Claude and ChatGPT reach this server, and whether the
// custom GPT actions exist here
const reach = request => ({ publicUrl: new URL(request.url).origin, gptActions: true });

export async function onRequestGet(context) {
  const auth = await signedIn(context);
  if (!auth) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  return Response.json({ ...(await tokenStatus(auth.userId, context.env)), mcpUrl: mcpUrl(context.request), ...reach(context.request) });
}

export async function onRequestPost(context) {
  const auth = await signedIn(context);
  if (!auth) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const token = await createToken(auth.userId, context.env);
  return Response.json({ token, mcpUrl: mcpUrl(context.request), ...reach(context.request) });
}

export async function onRequestDelete(context) {
  const auth = await signedIn(context);
  if (!auth) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  await revokeToken(auth.userId, context.env);
  return Response.json({ hasToken: false });
}
