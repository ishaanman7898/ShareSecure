// /api/vault — the account's own list of its shares, so "Your shares" works on
// every device even for anonymous uploads, which the server can't tie to the
// account. The browser seals the list to the account's own public key; the
// server stores a box it can't open.
//   GET            → { vault }
//   PUT { vault }  replace it
import { getDb, verifyToken, ensureUserColumns } from '../_turso.js';
import { isSealed } from '../../public/sealed.js';

const MAX = 512 * 1024;

export async function onRequestGet(context) {
  const auth = await verifyToken(context.request.headers.get('Authorization'), context.env);
  if (!auth) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  const db = getDb(context.env);
  await ensureUserColumns(db);
  const row = (await db.execute({ sql: 'SELECT vault FROM users WHERE id = ?', args: [auth.userId] })).rows[0];
  return Response.json({ vault: row?.vault || null });
}

export async function onRequestPut(context) {
  const auth = await verifyToken(context.request.headers.get('Authorization'), context.env);
  if (!auth) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  const { vault } = await context.request.json().catch(() => ({}));
  if (!isSealed(vault) || vault.length > MAX) return Response.json({ error: 'That isn’t a sealed list.' }, { status: 400 });
  const db = getDb(context.env);
  await ensureUserColumns(db);
  await db.execute({ sql: 'UPDATE users SET vault = ? WHERE id = ?', args: [vault, auth.userId] });
  return Response.json({ saved: true });
}
