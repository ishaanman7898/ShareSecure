// The public key log, stored (see public/kt.js for what it is and why).
//
//   kt_leaves   one row per entry, in order: the account's label (a hash of its
//               username), 'key' or 'gone', the public key, and the leaf hash
//   kt_nodes    hashes of whole blocks of leaves (BLOCK of them and up), kept
//               so a proof never needs more than a few blocks' leaves
//
// Entries are only ever added. A free Cloudflare request gets about 10 ms of
// CPU, so proofs hash at most a few blocks of leaves; bigger subtrees come
// from kt_nodes, worked out once and kept.
import { getDb, migrateOnce } from './_turso.js';
import { labelFor, leafHash, nodeHash, splitPoint, inclusionProof, consistencyProof, EMPTY_ROOT } from '../public/kt.js';

const DEFAULT_BLOCK = 256;
const blockSize = env => Number(env?.KT_BLOCK) || DEFAULT_BLOCK;   // smaller in tests
const nowIso = () => new Date().toISOString();

async function ensureTables(db) {
  await migrateOnce('kt1', db, [
    `CREATE TABLE IF NOT EXISTS kt_leaves (
       idx        INTEGER PRIMARY KEY,
       label      TEXT NOT NULL,
       kind       TEXT NOT NULL,
       public_key TEXT,
       added_at   TEXT NOT NULL,
       hash       TEXT NOT NULL
     )`,
    'CREATE INDEX IF NOT EXISTS idx_kt_label ON kt_leaves(label, idx)',
    `CREATE TABLE IF NOT EXISTS kt_nodes (
       size INTEGER NOT NULL,      -- how many leaves the node covers
       idx  INTEGER NOT NULL,      -- which one of that size, from the left
       hash TEXT NOT NULL,
       PRIMARY KEY (size, idx)
     )`,
    `CREATE TABLE IF NOT EXISTS kt_meta (name TEXT PRIMARY KEY, value TEXT)`,
  ]);
}

// Adds an entry → its index. Indexes are given out in order with no gaps:
// two entries added at once can't take the same one, so one tries again.
export async function append(env, username, kind, publicKey = null) {
  const db = getDb(env);
  await ensureTables(db);
  await backfill(env);
  const label = await labelFor(username);
  const hash = await leafHash(label, kind, publicKey);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const row = (await db.execute({
        sql: `INSERT INTO kt_leaves (idx, label, kind, public_key, added_at, hash)
              SELECT COALESCE(MAX(idx) + 1, 0), ?, ?, ?, ?, ? FROM kt_leaves
              RETURNING idx`,
        args: [label, kind, publicKey, nowIso(), hash]
      })).rows[0];
      return Number(row.idx);
    } catch (err) {
      if (!/UNIQUE|PRIMARY KEY|constraint/i.test(err.message) || attempt === 4) throw err;
    }
  }
}

// Accounts that set their key before the log existed go in once, oldest first.
async function backfill(env) {
  const db = getDb(env);
  const claimed = await db.execute({ sql: "INSERT OR IGNORE INTO kt_meta (name, value) VALUES ('backfilled', ?)", args: [nowIso()] });
  if (!claimed.rowsAffected) return;
  const users = (await db.execute({ sql: 'SELECT username, public_key FROM users WHERE public_key IS NOT NULL ORDER BY id', args: [] })).rows;
  for (const u of users) {
    const label = await labelFor(u.username);
    const there = (await db.execute({ sql: 'SELECT 1 AS x FROM kt_leaves WHERE label = ? LIMIT 1', args: [label] })).rows[0];
    if (there) continue;
    const hash = await leafHash(label, 'key', u.public_key);
    await db.execute({
      sql: `INSERT INTO kt_leaves (idx, label, kind, public_key, added_at, hash)
            SELECT COALESCE(MAX(idx) + 1, 0), ?, 'key', ?, ?, ? FROM kt_leaves`,
      args: [label, u.public_key, nowIso(), hash]
    });
  }
}

// The tree as it is now, able to hash any range of its leaves.
async function openTree(env) {
  const db = getDb(env);
  await ensureTables(db);
  await backfill(env);
  const BLOCK = blockSize(env);
  const size = Number((await db.execute({ sql: 'SELECT COALESCE(MAX(idx) + 1, 0) AS n FROM kt_leaves', args: [] })).rows[0].n);
  const nodes = new Map();
  for (const r of (await db.execute({ sql: 'SELECT size, idx, hash FROM kt_nodes WHERE idx * size + size <= ?', args: [size] })).rows) {
    nodes.set(`${r.size}:${r.idx}`, r.hash);
  }
  const leaves = new Map();
  const memo = new Map();

  // a block's leaf hashes, fetched when first needed
  async function leaf(i) {
    if (!leaves.has(i)) {
      const start = Math.floor(i / BLOCK) * BLOCK;
      for (const r of (await db.execute({ sql: 'SELECT idx, hash FROM kt_leaves WHERE idx >= ? AND idx < ?', args: [start, start + BLOCK] })).rows) {
        leaves.set(Number(r.idx), r.hash);
      }
    }
    return leaves.get(i);
  }

  async function hashRange(lo, hi) {
    const n = hi - lo;
    if (n === 0) return EMPTY_ROOT;
    if (n === 1) return leaf(lo);
    const key = `${lo}:${hi}`;
    if (memo.has(key)) return memo.get(key);
    // a whole, aligned block or bigger: kept once worked out
    const whole = (n & (n - 1)) === 0 && lo % n === 0 && n >= BLOCK;
    const stored = whole ? nodes.get(`${n}:${lo / n}`) : null;
    let h = stored;
    if (!h) {
      const k = splitPoint(n);
      h = await nodeHash(await hashRange(lo, lo + k), await hashRange(lo + k, hi));
      if (whole) {
        nodes.set(`${n}:${lo / n}`, h);
        await db.execute({ sql: 'INSERT OR IGNORE INTO kt_nodes (size, idx, hash) VALUES (?, ?, ?)', args: [n, lo / n, h] });
      }
    }
    memo.set(key, h);
    return h;
  }

  return { size, hashRange, db };
}

export async function head(env) {
  const tree = await openTree(env);
  return { size: tree.size, root: await tree.hashRange(0, tree.size) };
}

// The proof that username's latest entry is in the log, with the head it's for,
// or null when the log has no 'key' entry for them.
export async function proofFor(env, username) {
  const tree = await openTree(env);
  const label = await labelFor(username);
  const row = (await tree.db.execute({ sql: 'SELECT idx, kind, public_key FROM kt_leaves WHERE label = ? ORDER BY idx DESC LIMIT 1', args: [label] })).rows[0];
  if (!row || row.kind !== 'key') return null;
  const index = Number(row.idx);
  return {
    index, size: tree.size, root: await tree.hashRange(0, tree.size),
    path: await inclusionProof(index, tree.size, tree.hashRange),
    public_key: row.public_key,
  };
}

// username's current key with its proof. If the log doesn't show that key as
// their latest entry yet (a new account, or one from before the log), it's
// added first, so every key the server hands out is in the log.
export async function keyProof(env, username, publicKey) {
  let proof = await proofFor(env, username);
  if (!proof || proof.public_key !== publicKey) {
    await append(env, username, 'key', publicKey);
    proof = await proofFor(env, username);
  }
  const { public_key, ...rest } = proof;
  return rest;
}

// The proof that the log at size `from` is the start of the log at size `to`.
export async function consistency(env, from, to) {
  const tree = await openTree(env);
  if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from <= to && to <= tree.size)) return null;
  return { from, to, path: await consistencyProof(from, to, tree.hashRange) };
}

// Entries in order, for monitors that check the whole log.
export async function entries(env, start, count) {
  const db = getDb(env);
  await ensureTables(db);
  await backfill(env);
  return (await db.execute({
    sql: 'SELECT idx, label, kind, public_key, added_at FROM kt_leaves WHERE idx >= ? ORDER BY idx LIMIT ?',
    args: [Math.max(0, start), Math.min(Math.max(1, count), 1000)]
  })).rows.map(r => ({ index: Number(r.idx), label: r.label, kind: r.kind, public_key: r.public_key, added_at: r.added_at }));
}
