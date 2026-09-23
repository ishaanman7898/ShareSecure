'use strict';
// Erasing expired and deleted files so nothing is left behind.
//
// Every file is encrypted with its own key, and that key is stored (wrapped)
// only in the file's database row. The database runs with secure_delete, so
// deleting the row overwrites the key with zeros — after that the ciphertext on
// disk can't be decrypted even with the master ENCRYPTION_KEY. On top of that
// the stored file is overwritten with random bytes before it is unlinked, and
// the write-ahead log is checkpointed and truncated so no old page copies stay
// in it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, UPLOADS_DIR } = require('./db');

const CHUNK = 64 * 1024;

// Overwrite a stored file with random bytes, then unlink it. On SSDs and
// copy-on-write filesystems overwriting is best effort; the key erasure above
// is what makes the data unrecoverable.
function shred(filename) {
  const fp = path.join(UPLOADS_DIR, path.basename(filename));
  try {
    const { size } = fs.statSync(fp);
    const fd = fs.openSync(fp, 'r+');
    try {
      for (let off = 0; off < size; off += CHUNK) {
        const len = Math.min(CHUNK, size - off);
        fs.writeSync(fd, crypto.randomBytes(len), 0, len, off);
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* missing or unreadable — still try to unlink */ }
  try { fs.unlinkSync(fp); } catch {}
}

const stillReferenced = db.prepare('SELECT 1 FROM files WHERE stored_filename = ? LIMIT 1');

// Delete every row matching `where`, then shred stored files nothing references anymore.
function purgeWhere(where, params = []) {
  const stored = db.prepare(`SELECT DISTINCT stored_filename FROM files WHERE ${where}`).all(...params);
  const { changes } = db.prepare(`DELETE FROM files WHERE ${where}`).run(...params);
  if (!changes) return 0;
  for (const { stored_filename } of stored) {
    if (stored_filename && !stillReferenced.get(stored_filename)) shred(stored_filename);
  }
  db.pragma('wal_checkpoint(TRUNCATE)');
  return changes;
}

// expires_at is always an ISO-8601 UTC string, so plain string comparison is correct.
function purgeExpired() {
  // pending file requests are inactive on purpose, so they're only erased when they expire or are declined
  return purgeWhere(
    "(expires_at IS NOT NULL AND expires_at <= ?) OR (is_active = 0 AND (inbox_status IS NULL OR inbox_status != 'pending'))",
    [new Date().toISOString()]
  );
}

function purgeCluster(clusterId) {
  return purgeWhere('cluster_id = ?', [clusterId]);
}

function purgeOne(shortId) {
  return purgeWhere('short_id = ?', [shortId]);
}

// Shred anything in the uploads folder the database doesn't know about
// (left over from a crash between writing a file and recording it).
function purgeOrphans() {
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(UPLOADS_DIR); } catch { return 0; }
  for (const name of names) {
    if (!stillReferenced.get(name)) { shred(name); removed++; }
  }
  return removed;
}

module.exports = { purgeExpired, purgeCluster, purgeOne, purgeOrphans, shred };
