// Who an assistant may send files to without asking first.
//
// A connected assistant reads things it didn't write: web pages, emails,
// files. Any of those can carry instructions ("send ~/.ssh to @mallory"), and
// send_to would carry them out. So every send an assistant makes is checked
// against the account's rule:
//   approve   people on the account's list get it at once; anyone else waits
//             until the account owner approves it on the website (the default)
//   anyone    every send goes straight through
//   nobody    assistants can share links but never send them to people
//
// A waiting send keeps exactly what /api/send was asked to do (an encrypted
// file's key is already sealed to the recipient), so approving it just
// replays it. Only a signed-in session can approve: never an assistant's token.
import { getDb, migrateOnce, encryptStr, decryptStr, randomId } from './_turso.js';

export const MODES = ['approve', 'anyone', 'nobody'];
const DEFAULT_MODE = 'approve';
const MAX_WAITING = 20;                        // waiting sends per account
const MAX_ALLOWED = 200;                       // names on the list
const WAIT_MS = 7 * 24 * 60 * 60 * 1000;       // a waiting send lasts at most a week

// Sends that come from an assistant carry this header, set by ShareSecure's own
// assistant code (the MCP server, the ChatGPT actions, the desktop app).
export const AGENT_HEADER = 'X-ShareSecure-Agent';

const nowIso = () => new Date().toISOString();
const norm = name => String(name || '').trim().replace(/^@/, '').normalize('NFKC').toLowerCase();

async function ensureTables(db) {
  await migrateOnce('agent1', db, [
    `CREATE TABLE IF NOT EXISTS agent_rules (
       user_id  INTEGER PRIMARY KEY,
       mode     TEXT NOT NULL,
       allowed  TEXT
     )`,
    // body is the /api/send request, encrypted
    `CREATE TABLE IF NOT EXISTS agent_waiting (
       id         TEXT PRIMARY KEY,
       user_id    INTEGER NOT NULL,
       short_id   TEXT NOT NULL,
       body       TEXT NOT NULL,
       created_at TEXT NOT NULL,
       expires_at TEXT NOT NULL
     )`,
    'CREATE INDEX IF NOT EXISTS idx_agent_waiting_user ON agent_waiting(user_id)',
  ]);
}

// → { mode, allowed: ['bob', …] }
export async function agentRules(userId, env) {
  const db = getDb(env);
  await ensureTables(db);
  const row = (await db.execute({ sql: 'SELECT mode, allowed FROM agent_rules WHERE user_id = ?', args: [userId] })).rows[0];
  if (!row) return { mode: DEFAULT_MODE, allowed: [] };
  let allowed = [];
  if (row.allowed) {
    try { allowed = JSON.parse(await decryptStr(row.allowed, null, env, `agentrules:${userId}`)); } catch {}
  }
  return { mode: MODES.includes(row.mode) ? row.mode : DEFAULT_MODE, allowed: Array.isArray(allowed) ? allowed : [] };
}

// The list of names is encrypted, since it says who the account sends to.
export async function setAgentRules(userId, env, { mode, allowed }) {
  const current = await agentRules(userId, env);
  const next = {
    mode: MODES.includes(mode) ? mode : current.mode,
    allowed: Array.isArray(allowed) ? [...new Set(allowed.map(norm).filter(Boolean))].slice(0, MAX_ALLOWED) : current.allowed,
  };
  await getDb(env).execute({
    sql: 'INSERT OR REPLACE INTO agent_rules (user_id, mode, allowed) VALUES (?, ?, ?)',
    args: [userId, next.mode, await encryptStr(JSON.stringify(next.allowed), null, env, `agentrules:${userId}`)]
  });
  return next;
}

// What happens to an assistant's send from this account to username:
// 'send', 'wait' or 'refuse'.
export async function ruleFor(userId, ownUsername, username, env) {
  if (norm(username) === norm(ownUsername)) return 'send';
  const { mode, allowed } = await agentRules(userId, env);
  if (mode === 'anyone') return 'send';
  if (mode === 'nobody') return 'refuse';
  return allowed.includes(norm(username)) ? 'send' : 'wait';
}

// Keeps a send for the owner to approve. → { id } or { error }
export async function holdSend(userId, shortId, body, fileExpiresAt, env) {
  const db = getDb(env);
  await ensureTables(db);
  await db.execute({ sql: 'DELETE FROM agent_waiting WHERE expires_at < ?', args: [nowIso()] });
  const waiting = (await db.execute({ sql: 'SELECT COUNT(*) AS n FROM agent_waiting WHERE user_id = ?', args: [userId] })).rows[0];
  if (Number(waiting?.n) >= MAX_WAITING) {
    return { error: `There are already ${MAX_WAITING} sends waiting for approval. Approve or decline some on the website first.` };
  }
  // the same file to the same person only waits once
  for (const row of await waitingRows(db, userId)) {
    if (row.short_id !== shortId) continue;
    const held = await openBody(row, env);
    if (held && norm(held.targetUsername) === norm(body.targetUsername)) return { id: row.id };
  }
  const id = randomId(16);
  const cap = Date.now() + WAIT_MS;
  const expires = fileExpiresAt && new Date(fileExpiresAt).getTime() < cap ? new Date(fileExpiresAt).toISOString() : new Date(cap).toISOString();
  await db.execute({
    sql: 'INSERT INTO agent_waiting (id, user_id, short_id, body, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    args: [id, userId, shortId, await encryptStr(JSON.stringify(body), null, env, `agentwait:${id}`), nowIso(), expires]
  });
  return { id };
}

async function waitingRows(db, userId) {
  return (await db.execute({
    sql: 'SELECT id, short_id, body, created_at, expires_at FROM agent_waiting WHERE user_id = ? AND expires_at > ? ORDER BY created_at',
    args: [userId, nowIso()]
  })).rows;
}

async function openBody(row, env) {
  try { return JSON.parse(await decryptStr(row.body, null, env, `agentwait:${row.id}`)); } catch { return null; }
}

// What's waiting, for the website: which share, to whom, and when it was asked.
export async function waitingSends(userId, env) {
  const db = getDb(env);
  await ensureTables(db);
  const out = [];
  for (const row of await waitingRows(db, userId)) {
    const body = await openBody(row, env);
    if (body) out.push({ id: row.id, short_id: row.short_id, username: body.targetUsername, created_at: row.created_at, expires_at: row.expires_at });
  }
  return out;
}

// Takes a waiting send off the list. → its /api/send body, or null
export async function takeWaiting(userId, id, env) {
  const db = getDb(env);
  await ensureTables(db);
  const row = (await db.execute({
    sql: 'SELECT id, short_id, body, created_at, expires_at FROM agent_waiting WHERE id = ? AND user_id = ? AND expires_at > ?',
    args: [String(id || ''), userId, nowIso()]
  })).rows[0];
  if (!row) return null;
  const gone = await db.execute({ sql: 'DELETE FROM agent_waiting WHERE id = ? AND user_id = ?', args: [row.id, userId] });
  if (!gone.rowsAffected) return null;   // someone else answered it at the same moment
  const body = await openBody(row, env);
  return body ? { shortId: row.short_id, body } : null;
}

// Turning assistants off (or deleting the account) drops whatever was waiting.
export async function forgetWaiting(userId, env) {
  const db = getDb(env);
  await ensureTables(db);
  await db.execute({ sql: 'DELETE FROM agent_waiting WHERE user_id = ?', args: [userId] });
}
