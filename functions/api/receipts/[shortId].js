// /api/receipts/:shortId — open receipts (see _receipts.js).
//   POST  { box }                      the viewer: this link was just opened
//   GET   X-Delete-Token: <token>      the sender: the sealed receipts so far
import { addReceipt, listReceipts } from '../../_receipts.js';
import { overPublicLimit } from '../../_auth.js';

const ID = /^[A-Za-z0-9]{6,32}$/;
const fail = (error, status) => Response.json({ error }, { status });

export async function onRequestPost(context) {
  const { request, env, params } = context;
  if (!ID.test(params.shortId)) return fail('Not found', 404);
  const limited = await overPublicLimit(context, 'lookup');
  if (limited) return limited;
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return fail('Origin not allowed', 403);
  const body = await request.json().catch(() => null);
  const out = await addReceipt(env, params.shortId, body?.box);
  return out.error ? fail(out.error, out.status) : Response.json(out);
}

export async function onRequestGet(context) {
  const { request, env, params } = context;
  if (!ID.test(params.shortId)) return fail('Not found', 404);
  const limited = await overPublicLimit(context, 'lookup');
  if (limited) return limited;
  const receipts = await listReceipts(env, params.shortId, request.headers.get('X-Delete-Token'));
  return Response.json({ receipts }, { headers: { 'Cache-Control': 'no-store' } });
}
