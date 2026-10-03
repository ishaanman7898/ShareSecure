// /api/auth/assistant — the account's rules for what assistants may send, and
// the sends waiting for approval. Only a signed-in session gets here: an
// assistant's token can't change its own rules or approve its own sends.
//   GET                                    { mode, allowed, waiting }
//   PUT  { mode?, allowed? }               change the rules
//   POST { id, action, always? }           approve or decline a waiting send;
//                                          always: true also adds the person to
//                                          the list, so next time it goes at once
import { verifyToken } from '../../_turso.js';
import { agentRules, setAgentRules, waitingSends, takeWaiting } from '../../_agent.js';
import { onRequestPost as sendHandler } from '../send/[shortId].js';

const fail = (error, status) => Response.json({ error }, { status });

async function signedIn(context) {
  return verifyToken(context.request.headers.get('Authorization'), context.env);
}

export async function onRequestGet(context) {
  const auth = await signedIn(context);
  if (!auth) return fail('Unauthorized', 401);
  return Response.json({ ...(await agentRules(auth.userId, context.env)), waiting: await waitingSends(auth.userId, context.env) });
}

export async function onRequestPut(context) {
  const auth = await signedIn(context);
  if (!auth) return fail('Unauthorized', 401);
  const body = await context.request.json().catch(() => null);
  if (!body || typeof body !== 'object') return fail('Send JSON.', 400);
  return Response.json(await setAgentRules(auth.userId, context.env, body));
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = await signedIn(context);
  if (!auth) return fail('Unauthorized', 401);
  const { id, action, always } = await request.json().catch(() => ({}));
  if (action !== 'approve' && action !== 'decline') return fail('action must be approve or decline', 400);

  const held = await takeWaiting(auth.userId, id, env);
  if (!held) return fail('That send isn’t waiting any more.', 404);
  if (action === 'decline') return Response.json({ declined: true });

  // the owner approved it, so it's their send now: no assistant header
  const req = new Request(new URL(`/api/send/${held.shortId}`, request.url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: request.headers.get('Authorization') },
    body: JSON.stringify(held.body),
  });
  const res = await sendHandler({ request: req, env, params: { shortId: held.shortId }, waitUntil: p => context.waitUntil(p) });
  const out = await res.json().catch(() => ({}));
  if (res.status === 404 || res.status === 410) {
    return fail(out.error === 'User not found' ? 'That person no longer has an account.' : 'That file was deleted or has expired, so it wasn’t sent.', 410);
  }
  if (!out.sent) return fail(out.error || 'Couldn’t send it.', res.status >= 400 ? res.status : 502);

  if (always) {
    const rules = await agentRules(auth.userId, env);
    await setAgentRules(auth.userId, env, { allowed: [...rules.allowed, held.body.targetUsername] });
  }
  return Response.json({ sent: true, username: held.body.targetUsername });
}
