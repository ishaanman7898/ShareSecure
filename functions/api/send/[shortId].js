import {
  getFilesClient, getAuthClient, verifyToken,
  getEncKey, decryptStr, encryptStr,
  getUserTag, ensureFileColumns, migrateOnce, signInRequired
} from '../../_turso.js';

const MAX_WAITING = 20;             // requests anyone can have waiting at once
const MAX_FROM_ONE_SENDER = 5;      // of those, from one sender
const MAX_SENDS_PER_DAY = 60;       // sends one account can make in 24 hours

function generateId(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Compares two secrets without leaking how much of them matched: both sides are
// hashed first, so the loop always runs over the same length.
async function sameSecret(given, stored) {
  if (typeof given !== 'string' || typeof stored !== 'string' || !given || !stored) return false;
  const [a, b] = await Promise.all([hmacHex('compare', given), hmacHex('compare', stored)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// An opaque tag for the sender, separate from the one on their uploads. It's
// only used to limit how much one account can send.
async function getSenderTag(userId, env) {
  const secret = env.TAG_SECRET || env.TOKEN_SECRET || '';
  if (!secret) return null;
  return hmacHex(secret, `sender:${userId}`);
}

// The same way sign-in finds an account: the exact name first, so older
// accounts with unusual names keep working, then any capitalisation, as long as
// only one account fits.
async function findRecipient(db, username) {
  const exact = (await db.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: [username] })).rows[0];
  if (exact) return exact;
  const loose = (await db.execute({
    sql: 'SELECT id FROM users WHERE lower(username) = lower(?) LIMIT 2',
    args: [username.normalize('NFKC')]
  })).rows;
  return loose.length === 1 ? loose[0] : null;
}

const SEND_COLUMNS = [
  'ALTER TABLE files ADD COLUMN sender_tag TEXT',
  'CREATE INDEX IF NOT EXISTS idx_files_sender ON files(sender_tag, recipient_user_tag)',
  // one row per send, kept for a day, so declined requests still count
  'CREATE TABLE IF NOT EXISTS send_log (sender_tag TEXT NOT NULL, sent_at TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_send_log ON send_log(sender_tag, sent_at)',
];

export async function onRequestPost(context) {
  const { params, env, request } = context;

  // sender must be signed in (for limits); who sent it is never shown to the recipient
  const senderAuth = await verifyToken(request.headers.get('Authorization'), env);
  if (!senderAuth) {
    return Response.json({ error: 'Sign in to send files to other users.' }, { status: 401 });
  }

  let body;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'Invalid body' }, { status: 400 });
  }

  const targetUsername = String(body.targetUsername || '').trim().replace(/^@/, '');
  if (!targetUsername) {
    return Response.json({ error: 'targetUsername required' }, { status: 400 });
  }
  const note = String(body.note || '').trim().slice(0, 140);

  const authClient = getAuthClient(env);
  const filesClient = getFilesClient(env);

  await ensureFileColumns(filesClient);
  await migrateOnce('send-limits', filesClient, SEND_COLUMNS);

  // fetch source file
  const fileRes = await filesClient.execute({
    sql: 'SELECT * FROM files WHERE short_id = ? AND is_active = 1',
    args: [params.shortId]
  });
  const file = fileRes.rows[0];
  if (!file) return Response.json({ error: 'File not found' }, { status: 404 });
  if (file.expires_at && new Date(file.expires_at) < new Date()) {
    return Response.json({ error: 'File expired' }, { status: 410 });
  }
  if (file.recipient_user_tag) {
    const denied = await signInRequired(file, request, env);
    if (denied) return denied;
  }

  // Only the person who shared it can send it. Private uploads prove that with
  // the link's delete key; uploads made while signed in (and by assistants)
  // carry the account's tag.
  const senderUserTag = await getUserTag(senderAuth.userId, env);
  const owns = await sameSecret(body.deleteToken, file.delete_token)
    || Boolean(file.user_tag && senderUserTag && file.user_tag === senderUserTag);
  if (!owns) {
    return Response.json({ error: 'You can only send files you shared.' }, { status: 403 });
  }

  const senderTag = await getSenderTag(senderAuth.userId, env);
  if (!senderTag) {
    return Response.json({ error: 'Server misconfigured (TAG_SECRET missing)' }, { status: 503 });
  }

  // resolve target username → userId → recipient user_tag
  const recipient = await findRecipient(authClient, targetUsername);
  if (!recipient) {
    return Response.json({ error: 'User not found' }, { status: 404 });
  }
  const recipientTag = await getUserTag(recipient.id, env);
  if (!recipientTag) {
    return Response.json({ error: 'Server misconfigured (TAG_SECRET missing)' }, { status: 503 });
  }

  // Each limit below is checked after this send is written down, not before,
  // so several sends at once can't all slip under it. Anything over the limit
  // is taken back out.
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  const logged = await filesClient.execute({
    sql: 'INSERT INTO send_log (sender_tag, sent_at) VALUES (?, ?) RETURNING rowid AS id',
    args: [senderTag, now]
  });
  const logId = logged.rows[0]?.id;
  const unlog = () => filesClient.execute({ sql: 'DELETE FROM send_log WHERE rowid = ?', args: [logId] }).catch(() => {});
  const sentToday = await filesClient.execute({
    sql: 'SELECT COUNT(*) AS n FROM send_log WHERE sender_tag = ? AND sent_at > ?',
    args: [senderTag, dayAgo]
  });
  if (Number(sentToday.rows[0].n) > MAX_SENDS_PER_DAY) {
    await unlog();
    return Response.json({ error: `You can send up to ${MAX_SENDS_PER_DAY} files a day. Try again tomorrow.` }, { status: 429 });
  }

  // The copy is stored inactive (is_active = 0) until the recipient accepts it,
  // so every viewing endpoint treats it as not found until then.
  const newShortId = generateId(8);
  const newDeleteToken = generateId(24);
  const encKey = await getEncKey(env);

  // The recipient's copy points at the original upload's data rather than
  // copying it, and hangs off the sender's link: deleting that link withdraws it.
  const name = await decryptStr(file.original_filename, encKey, env, params.shortId);
  const mime = await decryptStr(file.mime_type, encKey, env, params.shortId);

  await filesClient.execute({
    sql: `INSERT INTO files
            (short_id, original_filename, mime_type, size_bytes, file_data, data_short_id, expires_at,
             delete_token, integrity_hash, cluster_id, parent_short_id, uploaded_at,
             compressed, allow_annotations, allow_download, require_account, recipient_user_tag,
             is_active, inbox_status, inbox_note, sender_tag)
          VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, 'pending', ?, ?)`,
    args: [
      newShortId,
      await encryptStr(name, encKey, env, newShortId),
      await encryptStr(mime, encKey, env, newShortId),
      file.size_bytes,
      file.data_short_id || file.short_id,
      file.expires_at, newDeleteToken, file.integrity_hash || '',
      file.cluster_id || file.short_id, params.shortId, now,
      file.allow_annotations ?? 1, file.allow_download ?? 0, 1,
      recipientTag,
      note ? await encryptStr(note, encKey, env, newShortId) : null,
      senderTag
    ]
  });

  // Files arrive as requests the recipient has to accept. Cap how many can wait,
  // in total and from any one sender, so nobody can flood someone's inbox.
  const waiting = await filesClient.execute({
    sql: `SELECT COUNT(*) AS n, SUM(CASE WHEN sender_tag = ? THEN 1 ELSE 0 END) AS mine FROM files
          WHERE recipient_user_tag = ? AND inbox_status = 'pending'
            AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    args: [senderTag, recipientTag]
  });
  const full = Number(waiting.rows[0].mine || 0) > MAX_FROM_ONE_SENDER
    ? `They already have ${MAX_FROM_ONE_SENDER} files from you waiting. Wait until they accept or decline them.`
    : Number(waiting.rows[0].n) > MAX_WAITING ? 'Their inbox is full right now. Try again later.' : null;
  if (full) {
    await filesClient.execute({ sql: 'DELETE FROM files WHERE short_id = ?', args: [newShortId] });
    await unlog();
    return Response.json({ error: full }, { status: 429 });
  }

  // now and then, forget sends older than a day
  if (Math.random() < 0.05) {
    context.waitUntil?.(filesClient.execute({ sql: 'DELETE FROM send_log WHERE sent_at < ?', args: [dayAgo] }).catch(() => {}));
  }

  return Response.json({ sent: true });
}
