// /api/auth/assistant — the account's rules for what assistants may send, and
// the sends waiting for its OK (see _agent.js). Only a signed-in session gets
// here: an assistant's token can't change its own rules or approve its own sends.
//   GET                               { mode, allowed_box, waiting: [{ id, box, created_at, expires_at }] }
//   PUT  { mode?, allowed_box? }      change the rules; the list arrives sealed to your own key
//   POST { action: 'done', id }       a waiting send was approved (and sent by your browser) or declined
//   POST { action: 'hold', box }      keep a sealed send for approval (the desktop app's assistant)
// The server can't open any box: the list and the waiting sends are sealed to
// the account's own key, and approved sends go out anonymously from the browser.
import { verifyToken } from '../../_turso.js';
import { agentRules, setAgentRules, heldSends, dropHeld, holdSend } from '../../_agent.js';

const fail = (error, status) => Response.json({ error }, { status });

async function signedIn(context) {
  return verifyToken(context.request.headers.get('Authorization'), context.env);
}

export async function onRequestGet(context) {
  const auth = await signedIn(context);
  if (!auth) return fail('Unauthorized', 401);
  return Response.json({ ...(await agentRules(auth.userId, context.env)), waiting: await heldSends(auth.userId, context.env) });
}

export async function onRequestPut(context) {
  const auth = await signedIn(context);
  if (!auth) return fail('Unauthorized', 401);
  const body = await context.request.json().catch(() => null);
  if (!body || typeof body !== 'object') return fail('Send JSON.', 400);
  const out = await setAgentRules(auth.userId, context.env, body);
  return out.error ? fail(out.error, 400) : Response.json(out);
}

export async function onRequestPost(context) {
  const auth = await signedIn(context);
  if (!auth) return fail('Unauthorized', 401);
  const { action, id, box } = await context.request.json().catch(() => ({}));
  if (action === 'done') {
    return (await dropHeld(auth.userId, id, context.env)) ? Response.json({ done: true }) : fail('That send isn’t waiting any more.', 404);
  }
  if (action === 'hold') {
    const out = await holdSend(auth.userId, box, context.env);
    return out.error ? fail(out.error, 400) : Response.json({ waiting: true, id: out.id });
  }
  return fail('action must be done or hold', 400);
}
