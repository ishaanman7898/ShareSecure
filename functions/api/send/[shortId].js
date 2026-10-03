// POST /api/send/:shortId  { targetUsername, deleteToken?, note?, sealed_key? }
// Sends one of your links to a ShareSecure username. They get their own copy as
// a request they accept or decline, and they're never told who sent it.
//
// For an end-to-end encrypted file the server can't read the file key, so the
// sender's browser seals it to the recipient's public key (sealed_key) and the
// note with the file key. The server just stores both.
//
// Who's allowed to send:
//   signed in              counted per account (60 a day)
//   X-ShareSecure-Token    an anonymous send token, plus the link's delete key:
//                          the server doesn't learn who sent it, even to itself
//
// A send an assistant makes (X-ShareSecure-Agent: 1) follows the account's
// rules for assistants: it may wait for the owner's approval (202), or be
// refused. See _agent.js.
import {
  getDb, verifyToken, decryptStr, encryptStr, getUserTag, ensureFileColumns,
  signInRequired, branchFrom, randomId, hmacHex, tokensMatch, findLiveFile, findUser
} from '../../_turso.js';
import { spendToken } from '../../_tokens.js';
import { isSealed } from '../../../public/sealed.js';
import { AGENT_HEADER, ruleFor, holdSend } from '../../_agent.js';

const MAX_WAITING = 20;          // requests anyone can have waiting at once
const MAX_FROM_ONE_SENDER = 5;   // of those, from one signed-in sender
const MAX_SENDS_PER_DAY = 60;    // sends one signed-in account can make in 24 hours

const fail = (error, status) => Response.json({ error }, { status });

export async function onRequestPost(context) {
  const { params, env, request } = context;

  let body;
  try { body = await request.json(); } catch { return fail('Invalid body', 400); }
  const username = String(body.targetUsername || '').trim().replace(/^@/, '');
  if (!username) return fail('targetUsername required', 400);

  const db = getDb(env);
  await ensureFileColumns(db);

  const file = await findLiveFile(db, params.shortId);
  if (!file) return fail('File not found', 404);
  if (file.expired) return fail('File expired', 410);
  if (file.recipient_user_tag) {
    const denied = await signInRequired(file, request, env);
    if (denied) return denied;
  }

  // Only whoever shared the link can send it: they prove it with the link's
  // delete key, or by being the account that uploaded it.
  const sender = await verifyToken(request.headers.get('Authorization'), env);
  const senderUserTag = sender ? await getUserTag(sender.userId, env) : null;
  const holdsKey = await tokensMatch(body.deleteToken, file.delete_token);
  if (!holdsKey && !(file.user_tag && senderUserTag && file.user_tag === senderUserTag)) {
    return fail('You can only send files you shared.', 403);
  }

  // what the recipient will need to open an end-to-end encrypted file
  const sealedKey = String(body.sealed_key || '');
  if (file.e2e && (!isSealed(sealedKey) || sealedKey.length > 300)) {
    return fail('This file is end-to-end encrypted, so its key has to be sealed to the person you send it to.', 400);
  }
  const note = String(body.note || '').trim();
  if (isSealed(note) ? note.length > 1000 : note.length > 140) return fail('The note is too long.', 400);

  const recipient = await findUser(db, username);
  if (!recipient) return fail('User not found', 404);
  const recipientTag = await getUserTag(recipient.id, env);

  // an assistant only sends where the account's rules let it
  if (request.headers.get(AGENT_HEADER) === '1') {
    if (!sender) return fail('Sign in to send files to other users.', 401);
    const rule = await ruleFor(sender.userId, sender.username, username, env);
    if (rule === 'refuse') {
      return fail('This account doesn’t let assistants send files to people. The owner can change that on the website: account menu → Connect an AI assistant.', 403);
    }
    if (rule === 'wait') {
      const held = await holdSend(sender.userId, params.shortId,
        { targetUsername: username, deleteToken: body.deleteToken || null, note: body.note || null, sealed_key: body.sealed_key || null },
        file.expires_at, env);
      if (held.error) return fail(held.error, 429);
      return Response.json({ waiting: true, id: held.id }, { status: 202 });
    }
  }

  // An anonymous send spends a token (checked last, so a typo doesn't waste one).
  // Otherwise the sender must be signed in, and is limited by a tag of their own.
  const anonymous = holdsKey && file.e2e && await spendToken(request, env, 'send');
  if (!anonymous && !sender) return fail('Sign in to send files to other users.', 401);
  const secret = env.TAG_SECRET || env.TOKEN_SECRET;
  if (!secret) return fail('Server misconfigured (TAG_SECRET missing)', 503);
  const senderTag = anonymous ? null : await hmacHex(secret, `sender:${sender.userId}`);

  // Each limit is checked after this send is written down, not before, so
  // several sends at once can't all slip under it. Over the limit → undone.
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  let unlog = async () => {};
  if (senderTag) {
    const logId = (await db.execute({
      sql: 'INSERT INTO send_log (sender_tag, sent_at) VALUES (?, ?) RETURNING rowid AS id', args: [senderTag, now]
    })).rows[0]?.id;
    unlog = () => db.execute({ sql: 'DELETE FROM send_log WHERE rowid = ?', args: [logId] }).catch(() => {});
    const sentToday = (await db.execute({
      sql: 'SELECT COUNT(*) AS n FROM send_log WHERE sender_tag = ? AND sent_at > ?', args: [senderTag, dayAgo]
    })).rows[0];
    if (Number(sentToday.n) > MAX_SENDS_PER_DAY) {
      await unlog();
      return fail(`You can send up to ${MAX_SENDS_PER_DAY} files a day. Try again tomorrow.`, 429);
    }
  }

  // The recipient's copy is a branch of the sender's link (deleting that link
  // withdraws it) and stays inactive until they accept it, so every viewing
  // endpoint treats it as not found until then.
  const newId = randomId(8);
  const copy = async col => file.e2e ? file[col] : encryptStr(await decryptStr(file[col], null, env, params.shortId), null, env, newId);
  const branch = await branchFrom(file, newId, env);

  await db.execute({
    sql: `INSERT INTO files
            (short_id, original_filename, mime_type, size_bytes, file_data, data_ref, expires_at,
             delete_token, integrity_hash, cluster_id, parent_key, uploaded_at,
             compressed, allow_annotations, allow_download, require_account, recipient_user_tag,
             is_active, inbox_status, inbox_note, sender_tag, e2e, inbox_key)
          VALUES (?, ?, ?, ?, '', ?, ?, ?, '', ?, ?, ?, 0, ?, ?, 1, ?, 0, 'pending', ?, ?, ?, ?)`,
    args: [
      newId, await copy('original_filename'), await copy('mime_type'), file.size_bytes, branch.data_ref,
      file.expires_at, randomId(24), newId, branch.parent_key, now,
      file.allow_annotations ?? 1, file.allow_download ?? 0, recipientTag,
      !note ? null : isSealed(note) ? note : await encryptStr(note, null, env, newId),
      senderTag, file.e2e ? 1 : 0, file.e2e ? sealedKey : null,
    ]
  });

  // Cap how many requests can wait, in all and from one signed-in sender, so
  // nobody can flood someone's inbox. If the count can't be made, the copy is
  // taken back, so a send either fully happens or not at all and is safe to retry.
  let waiting;
  try {
    waiting = (await db.execute({
      sql: `SELECT COUNT(*) AS n, SUM(CASE WHEN sender_tag = ? THEN 1 ELSE 0 END) AS mine FROM files
            WHERE recipient_user_tag = ? AND inbox_status = 'pending'
              AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      args: [senderTag, recipientTag]
    })).rows[0];
  } catch (err) {
    console.error('send: waiting count failed', err?.message);
    await db.execute({ sql: 'DELETE FROM files WHERE short_id = ?', args: [newId] }).catch(() => {});
    await unlog();
    return fail('ShareSecure hit a database error, so nothing was sent. Try again.', 503);
  }
  const full = senderTag && Number(waiting.mine || 0) > MAX_FROM_ONE_SENDER
    ? `They already have ${MAX_FROM_ONE_SENDER} files from you waiting. Wait until they accept or decline them.`
    : Number(waiting.n) > MAX_WAITING ? 'Their inbox is full right now. Try again later.' : null;
  if (full) {
    await db.execute({ sql: 'DELETE FROM files WHERE short_id = ?', args: [newId] });
    await unlog();
    return fail(full, 429);
  }

  // now and then, forget sends older than a day
  if (Math.random() < 0.05) {
    context.waitUntil?.(db.execute({ sql: 'DELETE FROM send_log WHERE sent_at < ?', args: [dayAgo] }).catch(() => {}));
  }
  return Response.json({ sent: true, anonymous: Boolean(anonymous) });
}
