import { getAuthClient, signToken, checkAccessCode, hashAccessCode, migrateOnce } from '../../_turso.js';

// Sign-in attempts are counted in 15-minute windows: 10 for one username from
// one IP address, 20 from one address in all, and 100 for one username from
// anywhere. The address limits are checked first, and an attempt they turn
// away never reaches the username's overall count, so locking someone out of
// their own account takes many addresses rather than one. IP addresses are only ever stored as a keyed hash,
// never as the address itself.
const WINDOW_MS = 15 * 60 * 1000;
const LIMITS = { userFromIp: 10, ip: 20, user: 100 };

function ensureAttemptsTable(db) {
  return migrateOnce('login_attempts', db, [
    `CREATE TABLE IF NOT EXISTS login_attempts (
       key TEXT PRIMARY KEY,
       failures INTEGER NOT NULL DEFAULT 0,
       first_at INTEGER NOT NULL
     )`,
  ]);
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function attemptKeys(request, username, env) {
  const name = normalise(username).toLowerCase();
  const ip = request.headers.get('CF-Connecting-IP') || '';
  // in the order they're counted: the address ones before the username's overall one
  const keys = [{ key: await hmacHex(env.TOKEN_SECRET, `login:u:${name}:ip:${ip}`), max: LIMITS.userFromIp }];
  if (ip) keys.push({ key: await hmacHex(env.TOKEN_SECRET, `login:ip:${ip}`), max: LIMITS.ip, address: true });
  keys.push({ key: await hmacHex(env.TOKEN_SECRET, `login:u:${name}`), max: LIMITS.user });
  return keys;
}

// Counts this attempt before the access code is checked, in one statement per
// key, so a burst of requests at once can't all get in before any is counted.
// True when a count is over its limit; the keys after it aren't counted then.
async function countAttempt(db, keys, context) {
  const now = Date.now();
  const since = now - WINDOW_MS;
  let over = false;
  for (const { key, max } of keys) {
    // an attempt after the window has passed starts a fresh count
    const row = (await db.execute({
      sql: `INSERT INTO login_attempts (key, failures, first_at) VALUES (?, 1, ?)
            ON CONFLICT(key) DO UPDATE SET
              failures = CASE WHEN first_at <= ? THEN 1 ELSE failures + 1 END,
              first_at = CASE WHEN first_at <= ? THEN ? ELSE first_at END
            RETURNING failures`,
      args: [key, now, since, since, now]
    })).rows[0];
    if (Number(row?.failures) > max) { over = true; break; }
  }
  // old counts are no use to anyone
  context.waitUntil(
    db.execute({ sql: 'DELETE FROM login_attempts WHERE first_at <= ?', args: [since] }).catch(() => {})
  );
  return over;
}

const normalise = name => String(name).trim().normalize('NFKC');

// Exact match first, so older accounts with unusual names keep working, then
// any capitalisation, as long as only one account fits.
async function findUser(db, username) {
  const exact = (await db.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [String(username)] })).rows[0];
  if (exact) return exact;
  const loose = (await db.execute({
    sql: 'SELECT * FROM users WHERE lower(username) = lower(?) LIMIT 2',
    args: [normalise(username)]
  })).rows;
  return loose.length === 1 ? loose[0] : null;
}

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
  if (!env.TOKEN_SECRET) {
    console.error('Login error: TOKEN_SECRET is not set');
    return Response.json({ error: 'Sign-in isn’t set up on this server yet.' }, { status: 503 });
  }

  try {
    const db = getAuthClient(env);
    await ensureAttemptsTable(db);
    const keys = await attemptKeys(request, username, env);
    if (await countAttempt(db, keys, context)) {
      return Response.json({ error: 'Too many attempts. Try again in a few minutes.' }, { status: 429 });
    }

    const user = await findUser(db, username);
    const { ok, upgrade } = user ? await checkAccessCode(String(access_code), user.access_code, env) : { ok: false };
    if (!ok) {
      return Response.json({ error: 'Invalid username or access code' }, { status: 401 });
    }

    // Only the username's counts are cleared; the address's count just gets
    // this attempt back. Clearing it would let someone reset it by signing in
    // to their own account.
    const userKeys = keys.filter(k => !k.address).map(k => k.key);
    await db.execute({
      sql: 'DELETE FROM login_attempts WHERE key IN (?, ?)',
      args: userKeys
    });
    const ipKey = keys.find(k => k.address);
    if (ipKey) {
      await db.execute({
        sql: 'UPDATE login_attempts SET failures = failures - 1 WHERE key = ? AND failures > 0',
        args: [ipKey.key]
      });
    }

    // move accounts off the old unsalted hash the first time they sign in
    if (upgrade) {
      try {
        await db.execute({
          sql: 'UPDATE users SET access_code = ? WHERE id = ?',
          args: [await hashAccessCode(String(access_code), env), user.id]
        });
      } catch (err) {
        console.error('Access code upgrade failed:', err.message);
      }
    }

    const token = await signToken({ username: user.username, userId: user.id, iat: Math.floor(Date.now() / 1000) }, env);
    return Response.json({
      success: true,
      userId: user.id.toString(),
      username: user.username,
      token
    });
  } catch (err) {
    console.error('Login error:', err.message, err.stack);
    return Response.json({ error: 'Login failed' }, { status: 500 });
  }
}
