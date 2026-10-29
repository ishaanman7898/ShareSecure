// File requests: a link someone can send you a file through, even without an
// account ("send me your W-2 here").
//
// The link is /q/<id>#r=<request key>&pk=<your public key>, and the part after
// "#" never reaches the server. The request key unlocks the label (what you
// asked for); the public key is what the uploader's browser seals each file
// to, taken from the link so a compromised server can't swap it. Files land in
// your inbox sealed, so the server never sees a file, its name, the note or the label.
import { getDb, migrateOnce, getUserTag, ensureFileColumns, randomId, LINK_ID_LENGTH, bufToB64, findUser } from './_turso.js';
import { isSealed, MAX_SEALED_FILE, BOX_OVERHEAD, newFileKey, lockText, sealKey, toB64url } from '../public/sealed.js';
import { ensureTeamTables, mayRequestFor, isMember, teamBranding, MAX_TEAM_FILES } from './_teams.js';

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
  // a team's request: its files go to the team inbox, sealed to the team's key
  await migrateOnce('requests2', db, ['ALTER TABLE file_requests ADD COLUMN team_id TEXT']);
  await ensureFileColumns(db);
  await ensureTeamTables(db);
}


// "…/q/<id>#r=…&pk=…"
export const requestLink = (origin, id, requestKey, publicKey) => `${origin}/q/${id}#r=${toB64url(requestKey)}&pk=${publicKey}`;

// Opens a request for the account. label and owner_box arrive sealed by the
// owner's browser. → { id, expires_at } or { error, status }
export async function openRequest(userId, { label, owner_box, max_files, hours, file_hours, team_id }, env) {
  if (!isSealed(label) || label.length > 2000 || !isSealed(owner_box) || owner_box.length > 300) {
    return { error: 'What you’re asking for, and its key, have to be sealed.', status: 400 };
  }
  const db = getDb(env);
  await ensureRequestTables(db);
  await db.execute({ sql: 'DELETE FROM file_requests WHERE expires_at < ?', args: [nowIso()] });
  const team = team_id ? String(team_id) : null;
  if (team) {
    // a team's link: owner_box is the request key sealed to the team's key
    const denied = await mayRequestFor(db, team, userId);
    if (denied) return denied;
  }
  const open = (await db.execute(team
    ? { sql: 'SELECT COUNT(*) AS n FROM file_requests WHERE team_id = ?', args: [team] }
    : { sql: 'SELECT COUNT(*) AS n FROM file_requests WHERE owner_id = ? AND team_id IS NULL', args: [userId] })).rows[0];
  const most = team ? 50 : MAX_OPEN;
  if (Number(open?.n) >= most) return { error: `${team ? 'This team already has' : 'You already have'} ${most} open file requests. Close one first.`, status: 429 };

  const id = randomId(10);
  const expires_at = new Date(Date.now() + clamp(hours, 1, MAX_HOURS, 72) * 3600 * 1000).toISOString();
  await db.execute({
    sql: `INSERT INTO file_requests (id, owner_id, label, owner_box, max_files, file_hours, expires_at, created_at, team_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, userId, label, owner_box, Math.round(clamp(max_files, 1, team ? 200 : MAX_FILES, 1)), Math.round(clamp(file_hours, 1, MAX_FILE_HOURS, 168)), expires_at, nowIso(), team]
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

// Your own open requests, or (with teamId) a team's, for any of its members.
export async function listRequests(userId, env, teamId = null) {
  const db = getDb(env);
  await ensureRequestTables(db);
  if (teamId && !(await isMember(db, teamId, userId))) return [];
  return (await db.execute(teamId ? {
    sql: `SELECT r.id, r.label, r.owner_box, r.max_files, r.received, r.file_hours, r.expires_at, r.created_at, u.username AS made_by
          FROM file_requests r LEFT JOIN users u ON u.id = r.owner_id
          WHERE r.team_id = ? AND r.expires_at > ? ORDER BY r.created_at DESC`,
    args: [String(teamId), nowIso()]
  } : {
    sql: `SELECT id, label, owner_box, max_files, received, file_hours, expires_at, created_at FROM file_requests
          WHERE owner_id = ? AND team_id IS NULL AND expires_at > ? ORDER BY created_at DESC`,
    args: [userId, nowIso()]
  })).rows.map(r => ({ ...r, max_files: Number(r.max_files), received: Number(r.received), file_hours: Number(r.file_hours) }));
}

// Whoever made a request can close it; so can any admin of its team.
export async function closeRequest(userId, id, env) {
  const db = getDb(env);
  await ensureRequestTables(db);
  const gone = await db.execute({
    sql: `DELETE FROM file_requests WHERE id = ? AND (owner_id = ? OR team_id IN
            (SELECT team_id FROM team_members WHERE user_id = ? AND role = 'admin'))`,
    args: [String(id), userId, userId],
  });
  return gone.rowsAffected > 0;
}

// What the upload page shows. → { username, label, expires_at, remaining } or null
export async function requestInfo(id, env) {
  const db = getDb(env);
  await ensureRequestTables(db);
  const row = (await db.execute({
    sql: `SELECT r.label, r.max_files, r.received, r.expires_at, r.team_id, u.username FROM file_requests r
          JOIN users u ON u.id = r.owner_id WHERE r.id = ?`,
    args: [String(id)]
  })).rows[0];
  if (!row) return null;
  // a team's link shows the team, not which of its people made it
  const team = row.team_id ? await teamBranding(db, row.team_id) : null;
  return {
    username: team ? null : row.username, team, label: row.label, expires_at: row.expires_at,
    remaining: Math.max(0, Number(row.max_files) - Number(row.received)),
    open: row.expires_at > nowIso() && Number(row.received) < Number(row.max_files),
  };
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
  const req = (await db.execute({ sql: 'SELECT owner_id, file_hours, team_id FROM file_requests WHERE id = ?', args: [String(id)] })).rows[0];
  if (!req) return { error: 'This file request doesn’t exist, or was closed.', status: 404 };
  if (req.team_id) {
    const waiting = (await db.execute({ sql: 'SELECT COUNT(*) AS n FROM files WHERE team_id = ? AND is_active = 1', args: [req.team_id] })).rows[0];
    if (Number(waiting?.n) >= MAX_TEAM_FILES) return { error: 'This team’s inbox is full right now. Try again later.', status: 429 };
  }

  // take a place first, so several uploads at once can't all fit in the last one
  const claimed = await db.execute({
    sql: 'UPDATE file_requests SET received = received + 1 WHERE id = ? AND received < max_files AND expires_at > ?',
    args: [String(id), nowIso()]
  });
  if (!claimed.rowsAffected) return { error: 'This file request is closed: it has expired or already has all its files.', status: 410 };
  const giveBack = () => db.execute({ sql: 'UPDATE file_requests SET received = received - 1 WHERE id = ? AND received > 0', args: [String(id)] }).catch(() => {});

  const shortId = randomId(LINK_ID_LENGTH);
  if (req.team_id) {
    // straight into the team inbox: only its members can list or open it
    try {
      await db.execute({
        sql: `INSERT INTO files (short_id, original_filename, mime_type, size_bytes, file_data, expires_at, delete_token,
                user_id, user_tag, integrity_hash, compressed, cluster_id, allow_annotations, allow_download, require_account,
                is_active, inbox_status, inbox_note, e2e, inbox_key, uploaded_at, via_request, team_id)
              VALUES (?, ?, 'e2e', ?, ?, ?, ?, NULL, NULL, '', 0, ?, 0, 1, 1, 1, 'team', ?, 1, ?, ?, ?, ?)`,
        args: [shortId, meta, buffer.byteLength - BOX_OVERHEAD, 'e2e:' + bufToB64(buffer),
          new Date(Date.now() + Number(req.file_hours) * 3600 * 1000).toISOString(), randomId(24),
          shortId, note || null, inboxKey, nowIso(), String(id), req.team_id]
      });
    } catch (err) {
      await giveBack();
      throw err;
    }
    return { received: true, id: shortId };
  }

  const ownerTag = await getUserTag(Number(req.owner_id), env);
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
