// Plans: Free and Pro. Pro raises the daily limits and lets you run teams.
//
// What you pay never touches what you share. Uploads and sends spend
// anonymous tokens (see _tokens.js); Pro only changes how many tokens an
// account is given each day, and a Pro token looks exactly like a free one.
// So the server knows which accounts are Pro, and Lemon Squeezy knows who
// paid, but neither can tell which shares are anyone's.
//
// Paying works without telling Lemon Squeezy your username: your browser makes
// a random claim code, checkout carries it, the webhook below records it, and
// then your browser hands the code in while signed in. ShareSecure keeps no
// email, name or card details, only a keyed hash of the subscription's id, so
// renewals and cancellations reach the right account.
//
// Settings (Pages → Settings → Variables and Secrets):
//   LEMONSQUEEZY_CHECKOUT_URL      the product's checkout link (https://<store>.lemonsqueezy.com/buy/<id>)
//   LEMONSQUEEZY_WEBHOOK_SECRET    the signing secret of the webhook pointed at /api/plan/webhook
import { getDb, migrateOnce, ensureUserColumns, sha256, hmacHex } from './_turso.js';

export const PLANS = {
  free: { name: 'Free', upload: 5, send: 60, requests: 10, teams: false },
  pro: { name: 'Pro', upload: 100, send: 300, requests: 50, teams: true },
};
// a renewal can arrive a little after the period ends
const GRACE_MS = 3 * 24 * 3600 * 1000;

export const ensurePlanTables = db => migrateOnce('plans1', db, [
  'ALTER TABLE users ADD COLUMN plan TEXT',
  'ALTER TABLE users ADD COLUMN plan_until TEXT',
  'ALTER TABLE users ADD COLUMN plan_sub TEXT',       // keyed hash of the subscription id
  `CREATE TABLE IF NOT EXISTS plan_claims (
     code_hash  TEXT PRIMARY KEY,                      -- SHA-256 of the browser's claim code
     sub        TEXT NOT NULL,                         -- keyed hash of the subscription id
     plan       TEXT NOT NULL,
     until      TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS idx_plan_claims_sub ON plan_claims(sub)',
  'CREATE INDEX IF NOT EXISTS idx_users_plan_sub ON users(plan_sub)',
]);

const subHash = (id, env) => hmacHex(env.TAG_SECRET || env.TOKEN_SECRET || '', `sub:${id}`);

// The plan an account is on now → { id, until, ...limits }
export async function planFor(db, userId) {
  await ensureUserColumns(db);
  await ensurePlanTables(db);
  const row = (await db.execute({ sql: 'SELECT plan, plan_until FROM users WHERE id = ?', args: [userId] })).rows[0];
  const active = row?.plan && PLANS[row.plan] && (!row.plan_until || new Date(row.plan_until).getTime() + GRACE_MS > Date.now());
  const id = active ? row.plan : 'free';
  return { id, until: active ? row.plan_until || null : null, ...PLANS[id] };
}

// ── Lemon Squeezy webhook ────────────────────────────────────────────────────
async function verifySignature(body, signature, secret) {
  if (!secret || !/^[0-9a-f]{64}$/i.test(signature || '')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map(b => b.toString(16).padStart(2, '0')).join('');
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= mac.charCodeAt(i) ^ signature.toLowerCase().charCodeAt(i);
  return diff === 0;
}

// Subscription statuses that still get Pro (cancelled ones run to the end of
// what was paid for).
const PAYING = new Set(['active', 'on_trial', 'past_due', 'cancelled']);

// → { status, body }
export async function handleWebhook(request, env) {
  const body = await request.text();
  if (!(await verifySignature(body, request.headers.get('X-Signature'), env.LEMONSQUEEZY_WEBHOOK_SECRET))) {
    return { status: 401, body: { error: 'Bad signature' } };
  }
  let event;
  try { event = JSON.parse(body); } catch { return { status: 400, body: { error: 'Bad JSON' } }; }
  const name = event?.meta?.event_name || '';
  if (!name.startsWith('subscription_')) return { status: 200, body: { ignored: name } };

  const attrs = event.data?.attributes || {};
  const sub = await subHash(String(event.data?.id || ''), env);
  const paying = PAYING.has(attrs.status);
  // until when it's paid for: the end date once cancelled, otherwise the next renewal
  // (an expired or unpaid one ends now, without the grace period)
  const until = paying ? (attrs.ends_at || attrs.renews_at || new Date(Date.now() + 31 * 86400000).toISOString()) : new Date(Date.now() - GRACE_MS - 60000).toISOString();

  const db = getDb(env);
  await ensureUserColumns(db);
  await ensurePlanTables(db);
  const claim = String(event.meta?.custom_data?.claim || '');
  // every event about a subscription carries its claim code; once an account
  // has claimed it, the code isn't kept again
  const claimed = (await db.execute({ sql: 'SELECT 1 FROM users WHERE plan_sub = ? LIMIT 1', args: [sub] })).rows.length > 0;
  if (!claimed && /^[A-Za-z0-9_-]{43}$/.test(claim)) {
    await db.execute({
      sql: `INSERT INTO plan_claims (code_hash, sub, plan, until, created_at) VALUES (?, ?, 'pro', ?, ?)
            ON CONFLICT(code_hash) DO UPDATE SET until = excluded.until`,
      args: [await sha256(claim), sub, until, new Date().toISOString()],
    });
  }
  // renewals, cancellations and lapses reach an account that already claimed it
  await db.execute({ sql: 'UPDATE plan_claims SET until = ? WHERE sub = ?', args: [until, sub] });
  await db.execute({ sql: "UPDATE users SET plan = 'pro', plan_until = ? WHERE plan_sub = ?", args: [until, sub] });
  return { status: 200, body: { ok: true } };
}

// The signed-in account hands in the claim code its browser made before
// checkout. → { plan } or { error, status }; status 202 means "not paid yet,
// ask again in a moment" (the webhook can arrive after the browser returns).
export async function redeemClaim(env, userId, code) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(code || ''))) return { error: 'That isn’t a claim code.', status: 400 };
  const db = getDb(env);
  await ensurePlanTables(db);
  const hash = await sha256(String(code));
  const claim = (await db.execute({ sql: 'SELECT sub, plan, until FROM plan_claims WHERE code_hash = ?', args: [hash] })).rows[0];
  if (!claim) return { error: 'Payment not received yet.', status: 202 };
  await db.execute({ sql: 'UPDATE users SET plan = ?, plan_until = ?, plan_sub = ? WHERE id = ?', args: [claim.plan, claim.until, claim.sub, userId] });
  // the code has done its job; the subscription stays linked through plan_sub
  await db.execute({ sql: 'DELETE FROM plan_claims WHERE code_hash = ?', args: [hash] });
  return { plan: await planFor(db, userId) };
}
