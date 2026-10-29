// Teams: a shared inbox, shared file request links, the team's own name, colour
// and logo on those links, and admins who decide who's in.
//
// A team has its own key pair. Its private half is sealed to each member's own
// account key (so the server holds it, but can't open it), and every file sent
// through a team request link is sealed to the team's public key in the
// sender's browser. Any member can open those files; the server never can.
// When someone leaves or is removed, an admin's browser makes the team a new
// key and seals it, together with the old ones, to everyone who's still in.
// They also lose the team inbox straight away, since only members can list it.
//
// The server does know who is in which team: that's what a team is. It still
// can't read the team's files, labels or notes. Teams are free (up to
// MAX_TEAMS made per account, MAX_MEMBERS people each).
import { getDb, migrateOnce, findUser, ensureUserColumns, ensureFileColumns, randomId, deleteBranch, LINK_ID_LENGTH, bufToB64 } from './_turso.js';
import { isSealed, isPublicKey, MAX_SEALED_FILE, BOX_OVERHEAD } from '../public/sealed.js';
import { magicOf } from '../public/filetypes.js';

export const MAX_MEMBERS = 25;
export const MAX_TEAMS = 3;          // teams one account can make
export const MAX_TEAM_FILES = 500;   // files in one team inbox
const MAX_FILE_HOURS = 240;          // a team file lasts at most 10 days, like any link
const MAX_LOGO = 60 * 1024;          // bytes, before base64
const nowIso = () => new Date().toISOString();
const err = (error, status = 400) => ({ error, status });

export async function ensureTeamTables(db) {
  await ensureUserColumns(db);
  await ensureFileColumns(db);
  await migrateOnce('teams1', db, [
    `CREATE TABLE IF NOT EXISTS teams (
       id          TEXT PRIMARY KEY,
       name        TEXT NOT NULL,
       color       TEXT,
       logo        TEXT,               -- a small PNG or JPEG as a data: URL, shown on request links
       public_key  TEXT NOT NULL,      -- the team's current key
       requests_by TEXT NOT NULL DEFAULT 'members',   -- who can make team request links: members / admins
       created_by  INTEGER NOT NULL,
       created_at  TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS team_members (
       team_id   TEXT NOT NULL,
       user_id   INTEGER NOT NULL,
       role      TEXT NOT NULL,        -- admin / member
       key_box   TEXT NOT NULL,        -- the team's keys, sealed to this member
       added_at  TEXT NOT NULL,
       PRIMARY KEY (team_id, user_id)
     )`,
    'CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id)',
  ]);
}

// "e2e:…|e2e:…" from sealText, the only shape a key box has
const isKeyBox = box => {
  const parts = String(box || '').split('|');
  return parts.length === 2 && parts.every(isSealed) && String(box).length <= 20000;
};

// What every member's view of a team carries
async function membership(db, teamId, userId) {
  return (await db.execute({
    sql: `SELECT t.id, t.name, t.color, t.logo, t.public_key, t.requests_by, t.created_by, m.role, m.key_box
          FROM teams t JOIN team_members m ON m.team_id = t.id WHERE t.id = ? AND m.user_id = ?`,
    args: [String(teamId), userId],
  })).rows[0] || null;
}

export async function isMember(db, teamId, userId) {
  await ensureTeamTables(db);
  return Boolean(await membership(db, teamId, userId));
}

async function adminCount(db, teamId) {
  return Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND role = 'admin'", args: [teamId] })).rows[0]?.n || 0);
}


function cleanBranding({ name, color, logo }) {
  const out = {};
  if (name !== undefined) {
    out.name = String(name || '').replace(/[\x00-\x1F\x7F<>]/g, '').trim().slice(0, 60);
    if (!out.name) return err('Give the team a name.');
  }
  if (color !== undefined) {
    if (color && !/^#[0-9a-f]{6}$/i.test(String(color))) return err('The colour has to look like #1e3fd8.');
    out.color = color ? String(color).toLowerCase() : null;
  }
  if (logo !== undefined) {
    if (logo) {
      // only a real PNG or JPEG: never SVG, which can carry script
      const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+=*)$/.exec(String(logo));
      if (!m) return err('The logo has to be a PNG or JPEG.');
      const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
      if (bytes.length > MAX_LOGO) return err('The logo has to be under 60 KB.');
      const real = magicOf(bytes)?.type;
      if (real !== `image/${m[1]}`) return err('The logo has to be a PNG or JPEG.');
    }
    out.logo = logo || null;
  }
  return out;
}

// ── teams ────────────────────────────────────────────────────────────────────

export async function myTeams(env, userId) {
  const db = getDb(env);
  await ensureTeamTables(db);
  const rows = (await db.execute({
    sql: `SELECT t.id, t.name, t.color, t.logo, t.public_key, t.requests_by, m.role, m.key_box,
                 (SELECT COUNT(*) FROM team_members x WHERE x.team_id = t.id) AS members
          FROM teams t JOIN team_members m ON m.team_id = t.id WHERE m.user_id = ? ORDER BY t.created_at`,
    args: [userId],
  })).rows;
  const out = [];
  for (const r of rows) out.push({ ...r, members: Number(r.members) });
  return out;
}

// The team's key pair is made in the creator's browser: public_key, and the
// private key sealed to the creator as key_box.
export async function createTeam(env, userId, body) {
  const db = getDb(env);
  await ensureTeamTables(db);
  const made = Number((await db.execute({ sql: 'SELECT COUNT(*) AS n FROM teams WHERE created_by = ?', args: [userId] })).rows[0]?.n || 0);
  if (made >= MAX_TEAMS) return err(`You can make up to ${MAX_TEAMS} teams.`, 429);
  if (!isPublicKey(String(body.public_key || '')) || !isKeyBox(body.key_box)) return err('The team’s key has to be made and sealed in your browser.');
  const brand = cleanBranding({ name: body.name, color: body.color ?? null, logo: body.logo ?? null });
  if (brand.error) return brand;
  const id = randomId(12);
  await db.execute({
    sql: 'INSERT INTO teams (id, name, color, logo, public_key, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    args: [id, brand.name, brand.color, brand.logo, body.public_key, userId, nowIso()],
  });
  await db.execute({
    sql: "INSERT INTO team_members (team_id, user_id, role, key_box, added_at) VALUES (?, ?, 'admin', ?, ?)",
    args: [id, userId, body.key_box, nowIso()],
  });
  return { id };
}

export async function updateTeam(env, userId, teamId, body) {
  const db = getDb(env);
  await ensureTeamTables(db);
  const me = await membership(db, teamId, userId);
  if (!me) return err('Team not found.', 404);
  if (me.role !== 'admin') return err('Only the team’s admins can change it.', 403);
  const brand = cleanBranding(body);
  if (brand.error) return brand;
  const sets = [], args = [];
  for (const k of ['name', 'color', 'logo']) if (k in brand) { sets.push(`${k} = ?`); args.push(brand[k]); }
  if (body.requests_by !== undefined) {
    if (!['members', 'admins'].includes(body.requests_by)) return err('requests_by is members or admins.');
    sets.push('requests_by = ?'); args.push(body.requests_by);
  }
  if (sets.length) await db.execute({ sql: `UPDATE teams SET ${sets.join(', ')} WHERE id = ?`, args: [...args, me.id] });
  return { updated: true };
}

// Deleting a team erases its request links and every file in its inbox.
export async function deleteTeam(env, userId, teamId) {
  const db = getDb(env);
  await ensureTeamTables(db);
  const me = await membership(db, teamId, userId);
  if (!me) return err('Team not found.', 404);
  if (me.role !== 'admin') return err('Only the team’s admins can delete it.', 403);
  const files = (await db.execute({ sql: 'SELECT short_id FROM files WHERE team_id = ?', args: [me.id] })).rows;
  for (const f of files) await deleteBranch(db, f.short_id, env);
  await db.execute({ sql: 'DELETE FROM file_requests WHERE team_id = ?', args: [me.id] });
  await db.execute({ sql: 'DELETE FROM team_members WHERE team_id = ?', args: [me.id] });
  await db.execute({ sql: 'DELETE FROM teams WHERE id = ?', args: [me.id] });
  return { deleted: true };
}

// ── members ──────────────────────────────────────────────────────────────────

export async function listMembers(env, userId, teamId) {
  const db = getDb(env);
  await ensureTeamTables(db);
  if (!(await membership(db, teamId, userId))) return err('Team not found.', 404);
  const members = (await db.execute({
    sql: `SELECT u.username, m.role, m.added_at FROM team_members m JOIN users u ON u.id = m.user_id
          WHERE m.team_id = ? ORDER BY m.role, u.username`,
    args: [String(teamId)],
  })).rows;
  return { members };
}

// An admin adds someone: their browser has already sealed the team's keys to
// that person's public key (checked against the public key log).
export async function addMember(env, userId, teamId, { username, role = 'member', key_box }) {
  const db = getDb(env);
  await ensureTeamTables(db);
  const me = await membership(db, teamId, userId);
  if (!me) return err('Team not found.', 404);
  if (me.role !== 'admin') return err('Only the team’s admins can add people.', 403);
  if (!['admin', 'member'].includes(role)) return err('role is admin or member.');
  if (!isKeyBox(key_box)) return err('The team’s key has to be sealed to them in your browser.');
  const user = await findUser(db, username, 'id, public_key');
  if (!user) return err('User not found', 404);
  if (!user.public_key) return err('They need to sign in to ShareSecure once before they can join a team.', 409);
  const count = Number((await db.execute({ sql: 'SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?', args: [me.id] })).rows[0]?.n || 0);
  if (count >= MAX_MEMBERS) return err(`A team can have up to ${MAX_MEMBERS} people.`, 429);
  await db.execute({
    sql: `INSERT INTO team_members (team_id, user_id, role, key_box, added_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(team_id, user_id) DO UPDATE SET role = excluded.role, key_box = excluded.key_box`,
    args: [me.id, Number(user.id), role, key_box, nowIso()],
  });
  return { added: true };
}

export async function setRole(env, userId, teamId, username, role) {
  const db = getDb(env);
  await ensureTeamTables(db);
  const me = await membership(db, teamId, userId);
  if (!me) return err('Team not found.', 404);
  if (me.role !== 'admin') return err('Only the team’s admins can change roles.', 403);
  if (!['admin', 'member'].includes(role)) return err('role is admin or member.');
  const user = await findUser(db, username, 'id');
  const target = user && await membership(db, teamId, Number(user.id));
  if (!target) return err('They aren’t in this team.', 404);
  if (target.role === 'admin' && role === 'member' && await adminCount(db, me.id) <= 1) return err('A team needs at least one admin.', 409);
  await db.execute({ sql: 'UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?', args: [role, me.id, Number(user.id)] });
  return { updated: true };
}

// An admin removes someone, or anyone leaves. The admin's browser should then
// rotate the team's key (rotateKeys).
export async function removeMember(env, userId, teamId, username) {
  const db = getDb(env);
  await ensureTeamTables(db);
  const me = await membership(db, teamId, userId);
  if (!me) return err('Team not found.', 404);
  const user = await findUser(db, username, 'id');
  const target = user && await membership(db, teamId, Number(user.id));
  if (!target) return err('They aren’t in this team.', 404);
  const self = Number(user.id) === userId;
  if (!self && me.role !== 'admin') return err('Only the team’s admins can remove people.', 403);
  if (target.role === 'admin' && await adminCount(db, me.id) <= 1) {
    return err(self ? 'You’re the only admin. Make someone else an admin first, or delete the team.' : 'A team needs at least one admin.', 409);
  }
  await db.execute({ sql: 'DELETE FROM team_members WHERE team_id = ? AND user_id = ?', args: [me.id, Number(user.id)] });
  return { removed: true };
}

// A new team key: its public half, and the whole key ring sealed to each
// member, every one of them. A box missing for anyone still in is refused,
// so nobody gets locked out by accident.
export async function rotateKeys(env, userId, teamId, { public_key, boxes }) {
  const db = getDb(env);
  await ensureTeamTables(db);
  const me = await membership(db, teamId, userId);
  if (!me) return err('Team not found.', 404);
  if (me.role !== 'admin') return err('Only the team’s admins can change its key.', 403);
  if (!isPublicKey(String(public_key || '')) || !boxes || typeof boxes !== 'object') return err('Send the new key and a box for every member.');
  const members = (await db.execute({
    sql: 'SELECT m.user_id, u.username FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ?', args: [me.id],
  })).rows;
  for (const m of members) if (!isKeyBox(boxes[m.username])) return err(`Missing the key for @${m.username}.`, 409);
  for (const m of members) {
    await db.execute({ sql: 'UPDATE team_members SET key_box = ? WHERE team_id = ? AND user_id = ?', args: [boxes[m.username], me.id, Number(m.user_id)] });
  }
  await db.execute({ sql: 'UPDATE teams SET public_key = ? WHERE id = ?', args: [public_key, me.id] });
  return { rotated: true };
}

// ── the team inbox ───────────────────────────────────────────────────────────
// Files that came in through the team's request links, or that members added
// (via_request is empty). Their names and notes are sealed; inbox_key is the
// file's key sealed to the team.
export async function teamInbox(env, userId, teamId) {
  const db = getDb(env);
  await ensureTeamTables(db);
  const me = await membership(db, teamId, userId);
  if (!me) return err('Team not found.', 404);
  const files = (await db.execute({
    sql: `SELECT short_id, original_filename, size_bytes, expires_at, uploaded_at, inbox_note, inbox_key, via_request
          FROM files WHERE team_id = ? AND is_active = 1
            AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          ORDER BY uploaded_at DESC LIMIT 200`,
    args: [me.id],
  })).rows.map(r => ({ ...r, note: r.inbox_note, e2e: true }));
  return { files };
}

// A member putting a file in the team inbox themselves, sealed in their
// browser exactly like a file sent through a team request link: the file and
// its name locked with a fresh key, that key sealed to the team (inbox_key),
// and a sealed note saying who added it. The server knows a member added a
// file, but can't read it, its name or the note.
// → { added: true, id } or { error, status }
export async function addTeamFile(env, userId, teamId, form) {
  const file = form.get('file');
  const meta = String(form.get('meta') || '');
  const inboxKey = String(form.get('inbox_key') || '');
  const note = String(form.get('note') || '');
  if (!file || typeof file === 'string') return err('No file was sent.');
  if (file.size > MAX_SEALED_FILE) return err('That file is over 10 MB.', 413);
  if (!isSealed(meta) || meta.length > 2000 || !isSealed(inboxKey) || inboxKey.length > 300 || (note && (!isSealed(note) || note.length > 1000))) {
    return err('The file, its name and its key have to be sealed in your browser first.');
  }
  const buffer = await file.arrayBuffer();
  if (new Uint8Array(buffer)[0] !== 1 || buffer.byteLength < BOX_OVERHEAD + 4) return err('That isn’t a sealed file.');

  const db = getDb(env);
  await ensureTeamTables(db);
  const me = await membership(db, teamId, userId);
  if (!me) return err('Team not found.', 404);
  const waiting = (await db.execute({ sql: 'SELECT COUNT(*) AS n FROM files WHERE team_id = ? AND is_active = 1', args: [me.id] })).rows[0];
  if (Number(waiting?.n) >= MAX_TEAM_FILES) return err('This team’s inbox is full. Delete some files first.', 429);

  const hours = Math.min(Math.max(Number(form.get('hours')) || MAX_FILE_HOURS, 1), MAX_FILE_HOURS);
  const shortId = randomId(LINK_ID_LENGTH);
  await db.execute({
    sql: `INSERT INTO files (short_id, original_filename, mime_type, size_bytes, file_data, expires_at, delete_token,
            user_id, user_tag, integrity_hash, compressed, cluster_id, allow_annotations, allow_download, require_account,
            is_active, inbox_status, inbox_note, e2e, inbox_key, uploaded_at, via_request, team_id)
          VALUES (?, ?, 'e2e', ?, ?, ?, ?, NULL, NULL, '', 0, ?, 0, 1, 1, 1, 'team', ?, 1, ?, ?, NULL, ?)`,
    args: [shortId, meta, buffer.byteLength - BOX_OVERHEAD, 'e2e:' + bufToB64(buffer),
      new Date(Date.now() + hours * 3600 * 1000).toISOString(), randomId(24),
      shortId, note || null, inboxKey, nowIso(), me.id],
  });
  return { added: true, id: shortId };
}

export async function deleteTeamFile(env, userId, teamId, shortId) {
  const db = getDb(env);
  await ensureTeamTables(db);
  const me = await membership(db, teamId, userId);
  if (!me) return err('Team not found.', 404);
  const file = (await db.execute({ sql: 'SELECT short_id FROM files WHERE short_id = ? AND team_id = ?', args: [String(shortId), me.id] })).rows[0];
  if (!file) return err('File not found.', 404);
  await deleteBranch(db, file.short_id, env);
  return { deleted: true };
}

// What a team request link shows the person sending: the team's name, colour
// and logo. Nothing about its members.
export async function teamBranding(db, teamId) {
  await ensureTeamTables(db);
  const t = (await db.execute({ sql: 'SELECT name, color, logo FROM teams WHERE id = ?', args: [String(teamId)] })).rows[0];
  return t ? { name: t.name, color: t.color || null, logo: t.logo || null } : null;
}

// Whether this account may open a team request link for the team → null or { error, status }
export async function mayRequestFor(db, teamId, userId) {
  await ensureTeamTables(db);
  const me = await membership(db, teamId, userId);
  if (!me) return err('Team not found.', 404);
  if (me.requests_by === 'admins' && me.role !== 'admin') return err('Only the team’s admins can make its request links.', 403);
  return null;
}
