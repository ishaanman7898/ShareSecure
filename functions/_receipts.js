// Open receipts: a sender can ask to hear when their link is opened.
//
// When they do, their browser makes a key pair just for that share. The public
// half is stored with the link; the private half stays in the sender's own list
// of shares (sealed to them, see public/vault.js). Each time someone opens the
// link, their browser seals a receipt to that public key: a tag that's the same
// every time this one device opens this one link, and different for every
// other link, so the sender can tell "opened again" from "opened somewhere new"
// without anyone being able to follow a device from link to link.
//
// The server keeps the sealed receipt and the minute it arrived, never an
// address or a browser name, and can't read the tag. Only someone holding the
// link's delete token can fetch them, and they go when the link expires.
import { getDb, migrateOnce, findLiveFile } from './_turso.js';
import { isSealed, isPublicKey } from '../public/sealed.js';

export const MAX_RECEIPTS = 100;   // per link; after that, opens aren't recorded
const nowIso = () => new Date().toISOString();

export const ensureReceipts = db => migrateOnce('receipts1', db, [
  `CREATE TABLE IF NOT EXISTS receipts (
     short_id    TEXT NOT NULL,
     owner       TEXT NOT NULL,   -- SHA-256 of the link's delete token
     box         TEXT NOT NULL,   -- sealed to the link's receipt key
     at          TEXT NOT NULL,   -- to the minute
     expires_at  TEXT NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS idx_receipts ON receipts(short_id, owner)',
]);

// The receipt key a new upload asked for, or null
export const receiptKeyFrom = value => (isPublicKey(String(value || '')) ? String(value) : null);

async function tokenHash(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token)));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const toMinute = () => nowIso().slice(0, 16) + ':00Z';

// Someone opened the link. → { recorded } or { error, status }
export async function addReceipt(env, shortId, box) {
  const parts = String(box || '').split('|');
  if (parts.length !== 2 || !parts.every(isSealed) || String(box).length > 600) {
    return { error: 'A receipt has to be sealed.', status: 400 };
  }
  const db = getDb(env);
  await ensureReceipts(db);
  const file = await findLiveFile(db, shortId, 'short_id, delete_token, receipt_key, expires_at');
  if (!file || file.expired || !file.receipt_key) return { error: 'This link doesn’t take receipts.', status: 404 };
  await db.execute({ sql: 'DELETE FROM receipts WHERE expires_at <= ?', args: [nowIso()] });
  const owner = await tokenHash(file.delete_token);
  const count = (await db.execute({ sql: 'SELECT COUNT(*) AS n FROM receipts WHERE short_id = ? AND owner = ?', args: [shortId, owner] })).rows[0];
  if (Number(count?.n) >= MAX_RECEIPTS) return { recorded: false };
  await db.execute({
    sql: 'INSERT INTO receipts (short_id, owner, box, at, expires_at) VALUES (?, ?, ?, ?, ?)',
    args: [shortId, owner, String(box), toMinute(), file.expires_at],
  });
  return { recorded: true };
}

// The sender's receipts for a link, oldest first. A link that worked once is
// erased when it's opened, but its receipts stay until it would have expired.
export async function listReceipts(env, shortId, deleteToken) {
  if (!deleteToken) return [];
  const db = getDb(env);
  await ensureReceipts(db);
  return (await db.execute({
    sql: 'SELECT box, at FROM receipts WHERE short_id = ? AND owner = ? AND expires_at > ? ORDER BY at, rowid',
    args: [shortId, await tokenHash(deleteToken), nowIso()],
  })).rows;
}
