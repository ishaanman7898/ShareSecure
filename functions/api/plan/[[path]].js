// /api/plan — your plan, and paying for Pro (see _plans.js).
//   GET                    your plan and its limits, and where to pay      (signed in)
//   POST /claim { code }   hand in the claim code your browser made before checkout
//   POST /webhook          Lemon Squeezy's subscription events (signed by them)
import { getDb, verifyToken } from '../../_turso.js';
import { planFor, redeemClaim, handleWebhook, PLANS } from '../../_plans.js';

const fail = (error, status) => Response.json({ error }, { status });

export async function onRequest(context) {
  const { request, env } = context;
  const [action, ...rest] = Array.isArray(context.params.path) ? context.params.path : [];
  if (rest.length) return fail('Not found', 404);

  if (action === 'webhook' && request.method === 'POST') {
    const out = await handleWebhook(request, env);
    return Response.json(out.body, { status: out.status });
  }

  const auth = await verifyToken(request.headers.get('Authorization'), env);
  if (!auth) return fail('Sign in first.', 401);

  if (!action && request.method === 'GET') {
    return Response.json({
      plan: await planFor(getDb(env), auth.userId),
      plans: PLANS,
      checkoutUrl: env.LEMONSQUEEZY_CHECKOUT_URL || null,
      manageUrl: 'https://app.lemonsqueezy.com/my-orders',
    });
  }
  if (action === 'claim' && request.method === 'POST') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== new URL(request.url).origin) return fail('Origin not allowed', 403);
    const { code } = await request.json().catch(() => ({}));
    const out = await redeemClaim(env, auth.userId, code);
    if (out.status === 202) return Response.json({ waiting: true }, { status: 202 });
    return out.error ? fail(out.error, out.status) : Response.json(out);
  }
  return fail('Not found', 404);
}
