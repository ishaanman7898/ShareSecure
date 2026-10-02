// POST /api/auth/upgrade/finish { record, public_key?, private_key_box? }
// Saves the account's new sign-in record and drops its password hash for good.
import { getDb, verifyToken, ensureUserColumns } from '../../../_turso.js';
import { recordFrom, keyPairFrom, ensureAuthTables, readJson, fail } from '../../../_auth.js';

export async function onRequestPost(context) {
  const auth = await verifyToken(context.request.headers.get('Authorization'), context.env);
  if (!auth) return fail('Sign in first.', 401);
  const body = await readJson(context.request);
  const record = recordFrom(body);
  const keys = keyPairFrom(body);
  if (!record || keys === false) return fail('That request is malformed.');

  const db = getDb(context.env);
  await ensureUserColumns(db);
  await ensureAuthTables(db);
  await db.execute({
    sql: "UPDATE users SET opaque_record = ?, access_code = 'opaque' WHERE id = ? AND opaque_record IS NULL",
    args: [record, auth.userId]
  });
  if (keys) {
    await db.execute({
      sql: 'UPDATE users SET public_key = ?, private_key_box = ? WHERE id = ? AND public_key IS NULL',
      args: [keys.publicKey, keys.box, auth.userId]
    });
  }
  return Response.json({ upgraded: true });
}
