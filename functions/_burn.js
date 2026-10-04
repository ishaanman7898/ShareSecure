// Links that work once ("burn after reading"), and telling the owner when
// someone tries one again.
//
// The first view takes the link's only view in one atomic step, gets the file,
// and the file is erased straight away. A small tombstone stays for 30 days:
// just the link's id, a hash of its delete key, when it was opened, and how
// many times anyone tried it since. A second try usually means the link was
// forwarded or leaked, so the owner's browser asks about its own burned links
// with their delete keys and warns them. Nothing ties a tombstone to an account.
import { getDb, migrateOnce, sha256, deleteBranch, dataIdOf } from './_turso.js';

const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const nowIso = () => new Date().toISOString();

async function ensureTable(db) {
  await migrateOnce('burn1', db, [
    `CREATE TABLE IF NOT EXISTS burned_links (
       short_id     TEXT PRIMARY KEY,
       delete_hash  TEXT,
       burned_at    TEXT NOT NULL,
       attempts     INTEGER NOT NULL DEFAULT 0,
       last_attempt TEXT
     )`,
  ]);
}

// Takes one of a link's views. → false when it has none left.
export async function takeView(db, shortId) {
  const took = await db.execute({
    sql: 'UPDATE files SET download_count = download_count + 1 WHERE short_id = ? AND download_count < max_views',
    args: [shortId]
  });
  return took.rowsAffected > 0;
}

// Erases a file that's been opened as often as it allows, through any of its
// links: a copy sent to someone points at the original's bytes, so the
// original goes too, and with it every link to the file. Whoever opens it
// first is the only one who can. The opened link and the original each leave
// a tombstone, so the owner hears it was opened and of any try after that.
export async function burn(db, file, env) {
  await ensureTable(db);
  const rootId = await dataIdOf(file, env);
  const root = rootId === file.short_id ? file
    : (await db.execute({ sql: 'SELECT short_id, delete_token FROM files WHERE short_id = ?', args: [rootId] })).rows[0];
  for (const link of [file, root].filter((l, i, all) => l && all.findIndex(x => x?.short_id === l.short_id) === i)) {
    await db.execute({
      sql: 'INSERT OR IGNORE INTO burned_links (short_id, delete_hash, burned_at) VALUES (?, ?, ?)',
      args: [link.short_id, link.delete_token ? await sha256(link.delete_token) : null, nowIso()]
    });
  }
  await deleteBranch(db, root ? root.short_id : file.short_id, env);
  // now and then, forget old tombstones
  if (Math.random() < 0.05) {
    await db.execute({ sql: 'DELETE FROM burned_links WHERE burned_at < ?', args: [new Date(Date.now() - KEEP_MS).toISOString()] }).catch(() => {});
  }
}

// Was this link opened and erased? (doesn't count as a try)
export async function wasBurned(db, shortId) {
  await ensureTable(db);
  return Boolean((await db.execute({ sql: 'SELECT 1 AS x FROM burned_links WHERE short_id = ?', args: [String(shortId)] })).rows[0]);
}

// Someone asked for a link that's gone. → true if it was burned (and the try is counted)
export async function noteTry(db, shortId) {
  await ensureTable(db);
  const hit = await db.execute({
    sql: 'UPDATE burned_links SET attempts = attempts + 1, last_attempt = ? WHERE short_id = ?',
    args: [nowIso(), String(shortId)]
  });
  return hit.rowsAffected > 0;
}

// For the owner: which of their links were opened, and tried again since.
// shares: [{ id, delete_token }] → [{ id, burned_at, attempts, last_attempt }]
export async function burnNews(shares, env) {
  const db = getDb(env);
  await ensureTable(db);
  const out = [];
  for (const s of shares.slice(0, 50)) {
    if (!s?.id || !s?.delete_token) continue;
    const row = (await db.execute({
      sql: 'SELECT short_id, burned_at, attempts, last_attempt FROM burned_links WHERE short_id = ? AND delete_hash = ?',
      args: [String(s.id), await sha256(String(s.delete_token))]
    })).rows[0];
    if (row) out.push({ id: row.short_id, burned_at: row.burned_at, attempts: Number(row.attempts), last_attempt: row.last_attempt });
  }
  return out;
}
