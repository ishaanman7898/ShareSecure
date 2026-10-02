// POST /api/auth/register/finish { username, record, public_key, private_key_box }
// Saves the new account. `record` is what the server keeps instead of a
// password (OPAQUE), and the key pair is the account's end-to-end keys, with
// the private half locked in the browser.
import { getDb, ensureUserColumns } from '../../../_turso.js';
import { USERNAME, recordFrom, keyPairFrom, ensureAuthTables, readJson, fail } from '../../../_auth.js';

export async function onRequestPost(context) {
  const body = await readJson(context.request);
  const username = String(body?.username || '').trim().normalize('NFKC');
  if (!USERNAME.test(username)) return fail('That username isn’t allowed.');
  const record = recordFrom(body);
  const keys = keyPairFrom(body);
  if (!record || keys === false) return fail('That account request is malformed.');

  const db = getDb(context.env);
  await ensureUserColumns(db);
  await ensureAuthTables(db);
  try {
    const made = await db.execute({
      sql: `INSERT INTO users (username, access_code, opaque_record, public_key, private_key_box)
            SELECT ?, 'opaque', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users WHERE lower(username) = lower(?))
            RETURNING id`,
      args: [username, record, keys?.publicKey ?? null, keys?.box ?? null, username]
    });
    if (!made.rows[0]) return fail('Username already exists');
    return Response.json({ success: true, userId: String(made.rows[0].id) });
  } catch (err) {
    return err.message?.includes('UNIQUE') ? fail('Username already exists') : fail('Registration failed', 500);
  }
}
