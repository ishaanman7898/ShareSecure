import { getAuthClient, sha256 } from '../../_turso.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { username, access_code } = body;
  if (!username || !access_code) {
    return Response.json({ error: 'Username and access code required' }, { status: 400 });
  }

  try {
    const db = getAuthClient(env);
    const result = await db.execute({
      sql: 'SELECT * FROM users WHERE username = ?',
      args: [username]
    });

    const user = result.rows[0];
    if (!user) {
      return Response.json({ error: 'Invalid username or access code' }, { status: 401 });
    }

    const hashed = await sha256(access_code);
    if (user.access_code !== hashed) {
      return Response.json({ error: 'Invalid username or access code' }, { status: 401 });
    }

    const token = btoa(`${user.username}:${user.id.toString()}`);
    return Response.json({
      success: true,
      userId: user.id.toString(),
      username: user.username,
      token
    });
  } catch (err) {
    console.error('Login error:', err.message);
    return Response.json({ error: 'Login failed' }, { status: 500 });
  }
}
