import { getAuthClient, sha256 } from '../../_turso.js';
import { storeCommitment } from '../../_zk.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { username, access_code, zk_commitment } = body;
  if (!username || !access_code) {
    return Response.json({ error: 'Username and access code required' }, { status: 400 });
  }
  if (access_code.length < 6) {
    return Response.json({ error: 'Access code must be at least 6 characters' }, { status: 400 });
  }

  try {
    const hashed = await sha256(access_code);
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
    const result = await db.execute({
      sql: 'INSERT INTO users (username, access_code) VALUES (?, ?)',
      args: [username, hashed]
    });

    const userId = result.lastInsertRowid?.toString();

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
