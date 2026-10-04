// What an assistant may send, and sends waiting for the owner's OK — without
// the server learning who anyone sends to.
//
// A connected assistant reads things it didn't write: web pages, emails,
// files. Any of those can carry instructions ("send ~/.ssh to @mallory"), and
// send_to would carry them out. So the account has a rule:
//   approve   people on the owner's list get it at once; anyone else waits
//             until the owner approves it on the website (the default)
//   anyone    every send goes straight through
//   nobody    assistants can share links but never send them to people
//
// The rule itself is the only part the server can read. The list of people is
// a box sealed to the owner's own key, so only their browser and their local
// MCP server (which hold that key) can open it and apply it. A waiting send is
// sealed the same way: which share, to whom, and the key it needs. Approving it
// happens in the owner's browser, which then sends it anonymously like any
// other send. So the server sees an account store an opaque box, and later an
// anonymous send it can't tie to anyone.
import { getDb, migrateOnce } from './_turso.js';
import { isSealed, randomBytes, toB64url } from '../public/sealed.js';

export const MODES = ['approve', 'anyone', 'nobody'];
const DEFAULT_MODE = 'approve';
const MAX_WAITING = 20;                        // waiting sends per account
const MAX_BOX = 8000;                          // a waiting send, sealed
const MAX_LIST_BOX = 64 * 1024;                // the sealed list of people
const WAIT_MS = 7 * 24 * 60 * 60 * 1000;       // a waiting send lasts at most a week

const nowIso = () => new Date().toISOString();
const sealedBox = (box, max) => typeof box === 'string' && box.length <= max && box.split('|').length === 2 && box.split('|').every(isSealed);

async function ensureTables(db) {
  await migrateOnce('agent2', db, [
    // version 1 kept the list readable by the server: it's dropped, not migrated
    'DROP TABLE IF EXISTS agent_rules',
    'DROP TABLE IF EXISTS agent_waiting',
    `CREATE TABLE IF NOT EXISTS agent_settings (
       user_id     INTEGER PRIMARY KEY,
       mode        TEXT NOT NULL,
       allowed_box TEXT            -- the people, sealed to the owner's own key
     )`,
    `CREATE TABLE IF NOT EXISTS agent_held (
       id         TEXT PRIMARY KEY,
       user_id    INTEGER NOT NULL,
       box        TEXT NOT NULL,   -- the send, sealed to the owner's own key
       created_at TEXT NOT NULL,
       expires_at TEXT NOT NULL
     )`,
    'CREATE INDEX IF NOT EXISTS idx_agent_held_user ON agent_held(user_id)',
  ]);
}

// → { mode, allowed_box }
export async function agentRules(userId, env) {
  const db = getDb(env);
  await ensureTables(db);
  const row = (await db.execute({ sql: 'SELECT mode, allowed_box FROM agent_settings WHERE user_id = ?', args: [userId] })).rows[0];
  return { mode: MODES.includes(row?.mode) ? row.mode : DEFAULT_MODE, allowed_box: row?.allowed_box || null };
}

// Only the owner's browser calls this (never an assistant's token).
// → the new rules, or { error }
export async function setAgentRules(userId, env, { mode, allowed_box }) {
  if (allowed_box !== undefined && allowed_box !== null && !sealedBox(allowed_box, MAX_LIST_BOX)) {
    return { error: 'The list of people has to be sealed to your key.' };
  }
  const current = await agentRules(userId, env);
  const next = {
    mode: MODES.includes(mode) ? mode : current.mode,
    allowed_box: allowed_box === undefined ? current.allowed_box : allowed_box,
  };
  await getDb(env).execute({
    sql: 'INSERT OR REPLACE INTO agent_settings (user_id, mode, allowed_box) VALUES (?, ?, ?)',
    args: [userId, next.mode, next.allowed_box]
  });
  return next;
}

// Keeps a sealed send for the owner to approve. → { id } or { error }
export async function holdSend(userId, box, env) {
  if (!sealedBox(box, MAX_BOX)) return { error: 'A waiting send has to be sealed to your key.' };
  const db = getDb(env);
  await ensureTables(db);
  await db.execute({ sql: 'DELETE FROM agent_held WHERE expires_at < ?', args: [nowIso()] });
  const waiting = (await db.execute({ sql: 'SELECT COUNT(*) AS n FROM agent_held WHERE user_id = ?', args: [userId] })).rows[0];
  if (Number(waiting?.n) >= MAX_WAITING) {
    return { error: `There are already ${MAX_WAITING} sends waiting for approval. Approve or decline some on the website first.` };
  }
  const id = toB64url(randomBytes(12));
  await db.execute({
    sql: 'INSERT INTO agent_held (id, user_id, box, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    args: [id, userId, box, nowIso(), new Date(Date.now() + WAIT_MS).toISOString()]
  });
  return { id };
}

export async function heldSends(userId, env) {
  const db = getDb(env);
  await ensureTables(db);
  return (await db.execute({
    sql: 'SELECT id, box, created_at, expires_at FROM agent_held WHERE user_id = ? AND expires_at > ? ORDER BY created_at',
    args: [userId, nowIso()]
  })).rows;
}

// Approved (and sent by the browser) or declined: either way it's gone.
export async function dropHeld(userId, id, env) {
  const db = getDb(env);
  await ensureTables(db);
  const gone = await db.execute({ sql: 'DELETE FROM agent_held WHERE id = ? AND user_id = ?', args: [String(id || ''), userId] });
  return gone.rowsAffected > 0;
}

// Turning assistants off (or deleting the account) drops whatever was waiting.
export async function forgetHeld(userId, env) {
  const db = getDb(env);
  await ensureTables(db);
  await db.execute({ sql: 'DELETE FROM agent_held WHERE user_id = ?', args: [userId] });
}
