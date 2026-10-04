// File requests: a link you hand someone so they can send you a file, even
// without a ShareSecure account ("send me your W-2 here").
//
// The link is /q/<id>#r=<request key>&pk=<your public key>. Both halves after
// "#" stay in the browser:
//   - the request key unlocks what you asked for (the label), so the server
//     never reads it;
//   - your public key is what the uploader's browser seals each file's key to.
//     It comes from the link, not the server, so a compromised server can't
//     swap in a key of its own.
// What arrives lands in your inbox as a request to accept or decline, sealed
// like any end-to-end encrypted file. The server never sees a file, its name,
// the uploader's note or what you asked for.
import { getDb, migrateOnce, getUserTag, ensureFileColumns, randomId, bufToB64, findUser } from './_turso.js';
import { isSealed, MAX_SEALED_FILE, BOX_OVERHEAD, newFileKey, lockText, sealKey, toB64url } from '../public/sealed.js';

export const MAX_OPEN = 10;            // open requests per account
export const MAX_FILES = 20;           // files one request can take
const MAX_HOURS = 30 * 24;             // a request stays open at most 30 days
const MAX_FILE_HOURS = 240;            // what's received lasts at most 10 days, like any link
const MAX_WAITING = 20;                // same cap as /api/send: requests waiting in one inbox

const nowIso = () => new Date().toISOString();
const clamp = (v, lo, hi, dflt) => Math.min(Math.max(Number(v) || dflt, lo), hi);

export async function ensureRequestTables(db) {
  await migrateOnce('requests1', db, [
    `CREATE TABLE IF NOT EXISTS file_requests (
       id          TEXT PRIMARY KEY,
       owner_id    INTEGER NOT NULL,
       label       TEXT NOT NULL,       -- sealed with the request key
       owner_box   TEXT NOT NULL,       -- the request key, sealed to the owner
       max_files   INTEGER NOT NULL,
       received    INTEGER NOT NULL DEFAULT 0,
       file_hours  INTEGER NOT NULL,
       expires_at  TEXT NOT NULL,
       created_at  TEXT NOT NULL
     )`,
    'CREATE INDEX IF NOT EXISTS idx_file_requests_owner ON file_requests(owner_id)',
  ]);
  await ensureFileColumns(db);
}

// "…/q/<id>#r=…&pk=…"
export const requestLink = (origin, id, requestKey, publicKey) => `${origin}/q/${id}#r=${toB64url(requestKey)}&pk=${publicKey}`;

// Opens a request for the account. label and owner_box arrive sealed by the
// owner's browser. → { id, expires_at } or { error, status }
export async function openRequest(userId, { label, owner_box, max_files, hours, file_hours }, env) {
  if (!isSealed(label) || label.length > 2000 || !isSealed(owner_box) || owner_box.length > 300) {
    return { error: 'What you’re asking for, and its key, have to be sealed.', status: 400 };
  }
  const db = getDb(env);
  await ensureRequestTables(db);
  await db.execute({ sql: 'DELETE FROM file_requests WHERE expires_at < ?', args: [nowIso()] });
  const open = (await db.execute({ sql: 'SELECT COUNT(*) AS n FROM file_requests WHERE owner_id = ?', args: [userId] })).rows[0];
  if (Number(open?.n) >= MAX_OPEN) return { error: `You already have ${MAX_OPEN} open file requests. Close one first.`, status: 429 };

  const id = randomId(10);
  const expires_at = new Date(Date.now() + clamp(hours, 1, MAX_HOURS, 72) * 3600 * 1000).toISOString();
  await db.execute({
    sql: `INSERT INTO file_requests (id, owner_id, label, owner_box, max_files, file_hours, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, userId, label, owner_box, Math.round(clamp(max_files, 1, MAX_FILES, 1)), Math.round(clamp(file_hours, 1, MAX_FILE_HOURS, 168)), expires_at, nowIso()]
  });
  return { id, expires_at };
}

// For assistants on the hosted server: the server makes the request key and
// seals the label itself (it sees the label once, never a file).
// → { url, id, expires_at } or { error }
export async function openRequestFor(user, { label, max_files, hours, file_hours }, origin, env) {
  const text = String(label || '').trim().slice(0, 300);
  if (!text) return { error: 'Say what you’re asking for, e.g. “Your signed lease”.' };
  const db = getDb(env);
  const me = await findUser(db, user.username, 'public_key');
  if (!me?.public_key) return { error: 'This account has no key yet. Sign in on the website once, then try again.' };
  const key = newFileKey();
  const made = await openRequest(user.userId, {
    label: await lockText(key, text, 'request'),
    owner_box: await sealKey(me.public_key, key),
    max_files, hours, file_hours,
  }, env);
  if (made.error) return made;
  return { ...made, url: requestLink(origin, made.id, key, me.public_key), label: text };
}

export async function listRequests(userId, env) {
  const db = getDb(env);
  await ensureRequestTables(db);
  return (await db.execute({
    sql: `SELECT id, label, owner_box, max_files, received, file_hours, expires_at, created_at FROM file_requests
          WHERE owner_id = ? AND expires_at > ? ORDER BY created_at DESC`,
    args: [userId, nowIso()]
  })).rows.map(r => ({ ...r, max_files: Number(r.max_files), received: Number(r.received), file_hours: Number(r.file_hours) }));
}

export async function closeRequest(userId, id, env) {
  const db = getDb(env);
  await ensureRequestTables(db);
  const gone = await db.execute({ sql: 'DELETE FROM file_requests WHERE id = ? AND owner_id = ?', args: [String(id), userId] });
  return gone.rowsAffected > 0;
}

// What the upload page shows. → { username, label, expires_at, remaining } or null
export async function requestInfo(id, env) {
  const db = getDb(env);
  await ensureRequestTables(db);
  const row = (await db.execute({
    sql: `SELECT r.label, r.max_files, r.received, r.expires_at, u.username FROM file_requests r
          JOIN users u ON u.id = r.owner_id WHERE r.id = ?`,
    args: [String(id)]
  })).rows[0];
  if (!row) return null;
  return { username: row.username, label: row.label, expires_at: row.expires_at, remaining: Math.max(0, Number(row.max_files) - Number(row.received)), open: row.expires_at > nowIso() && Number(row.received) < Number(row.max_files) };
}

// One file arriving for a request, already sealed in the uploader's browser.
// → { received: true, id } or { error, status }
export async function receive(id, form, env) {
  const file = form.get('file');
  const meta = String(form.get('meta') || '');
  const inboxKey = String(form.get('inbox_key') || '');
  const note = String(form.get('note') || '');
  if (!file || typeof file === 'string') return { error: 'No file was sent.', status: 400 };
  if (file.size > MAX_SEALED_FILE) return { error: 'That file is over 10 MB.', status: 413 };
  if (!isSealed(meta) || meta.length > 2000 || !isSealed(inboxKey) || inboxKey.length > 300 || (note && (!isSealed(note) || note.length > 1000))) {
    return { error: 'The file, its name and its key have to be sealed in your browser first.', status: 400 };
  }
  const buffer = await file.arrayBuffer();
  if (new Uint8Array(buffer)[0] !== 1 || buffer.byteLength < BOX_OVERHEAD + 4) return { error: 'That isn’t a sealed file.', status: 400 };

  const db = getDb(env);
  await ensureRequestTables(db);
  const req = (await db.execute({ sql: 'SELECT owner_id, file_hours FROM file_requests WHERE id = ?', args: [String(id)] })).rows[0];
  if (!req) return { error: 'This file request doesn’t exist, or was closed.', status: 404 };

  // take a place first, so several uploads at once can't all fit in the last one
  const claimed = await db.execute({
    sql: 'UPDATE file_requests SET received = received + 1 WHERE id = ? AND received < max_files AND expires_at > ?',
    args: [String(id), nowIso()]
  });
  if (!claimed.rowsAffected) return { error: 'This file request is closed: it has expired or already has all its files.', status: 410 };
  const giveBack = () => db.execute({ sql: 'UPDATE file_requests SET received = received - 1 WHERE id = ? AND received > 0', args: [String(id)] }).catch(() => {});

  const ownerTag = await getUserTag(Number(req.owner_id), env);
  const shortId = randomId(8);
  try {
    await db.execute({
      sql: `INSERT INTO files (short_id, original_filename, mime_type, size_bytes, file_data, expires_at, delete_token,
              user_id, user_tag, integrity_hash, compressed, cluster_id, allow_annotations, allow_download, require_account,
              recipient_user_tag, is_active, inbox_status, inbox_note, e2e, inbox_key, uploaded_at, via_request)
            VALUES (?, ?, 'e2e', ?, ?, ?, ?, NULL, NULL, '', 0, ?, 0, 1, 1, ?, 0, 'pending', ?, 1, ?, ?, ?)`,
      args: [shortId, meta, buffer.byteLength - BOX_OVERHEAD, 'e2e:' + bufToB64(buffer),
        new Date(Date.now() + Number(req.file_hours) * 3600 * 1000).toISOString(), randomId(24),
        shortId, ownerTag, note || null, inboxKey, nowIso(), String(id)]
    });
  } catch (err) {
    await giveBack();
    throw err;
  }

  // the same cap as people sending files: an inbox can't be flooded
  const waiting = (await db.execute({
    sql: `SELECT COUNT(*) AS n FROM files WHERE recipient_user_tag = ? AND inbox_status = 'pending'
            AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    args: [ownerTag]
  })).rows[0];
  if (Number(waiting?.n) > MAX_WAITING) {
    await db.execute({ sql: 'DELETE FROM files WHERE short_id = ?', args: [shortId] });
    await giveBack();
    return { error: 'Their inbox is full right now. Try again later.', status: 429 };
  }
  return { received: true, id: shortId };
}
