import { getAuthClient, hashAccessCode } from '../../_turso.js';
import { storeCommitment } from '../../_zk.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { access_code, zk_commitment } = body;
  if (!body.username || !access_code) {
    return Response.json({ error: 'Username and access code required' }, { status: 400 });
  }
  if (String(access_code).length < 6) {
    return Response.json({ error: 'Access code must be at least 6 characters' }, { status: 400 });
  }

  // New names are kept to a small set of characters, so look-alikes such as
  // "alice" in Cyrillic can't pass for someone else. Existing accounts keep
  // whatever name they have.
  const username = String(body.username).trim().normalize('NFKC');
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
    return Response.json({
      error: 'Usernames are 3 to 32 characters: letters, numbers, dots, dashes and underscores.'
    }, { status: 400 });
  }

  try {
    const hashed = await hashAccessCode(access_code, env);
    const db = getAuthClient(env);
    await db.execute({
      sql: `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        access_code TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      args: []
    });
    // "Alice" and "alice" are the same person
    const taken = await db.execute({
      sql: 'SELECT id FROM users WHERE lower(username) = lower(?) LIMIT 1',
      args: [username]
    });
    if (taken.rows.length) {
      return Response.json({ error: 'Username already exists' }, { status: 400 });
    }
    await db.execute({
      sql: 'INSERT INTO users (username, access_code) VALUES (?, ?)',
      args: [username, hashed]
    });

    // Turso's HTTP client doesn't return lastInsertRowid, so look the id up.
    // Without it the ZK commitment was never saved and private uploads failed.
    const row = await db.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: [username] });
    const userId = row.rows[0]?.id?.toString();

    // Optional: client may pre-compute a UniGroth commitment and send it now.
    // The server NEVER sees the underlying secret — only the commitment.
    if (zk_commitment && userId) {
      try {
        await storeCommitment(parseInt(userId, 10), zk_commitment, env);
      } catch {
        // Don't fail registration if commitment is malformed — user can re-enroll later.
      }
    }

    return Response.json({ success: true, userId });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return Response.json({ error: 'Username already exists' }, { status: 400 });
    }
    return Response.json({ error: 'Registration failed' }, { status: 500 });
  }
}
