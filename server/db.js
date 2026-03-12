'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '../data');

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'sharesecure.db');

// ensure data + uploads directories exist
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const db = new Database(DB_PATH);

// performance & integrity pragmas
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -8000'); // 8 MB cache

// ── schema ──────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL COLLATE NOCASE,
    access_code   TEXT NOT NULL,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS files (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    short_id         TEXT UNIQUE NOT NULL,
    original_filename TEXT NOT NULL,
    mime_type        TEXT NOT NULL,
    size_bytes       INTEGER NOT NULL,
    stored_filename  TEXT,
    integrity_hash   TEXT,
    compressed       INTEGER DEFAULT 0,
    encrypted        INTEGER DEFAULT 0,
    uploaded_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at       DATETIME,
    download_count   INTEGER DEFAULT 0,
    is_active        INTEGER DEFAULT 1,
    user_id          INTEGER,
    delete_token     TEXT,
    cluster_id       TEXT,
    parent_short_id  TEXT,
    allow_annotations INTEGER DEFAULT 1,
    allow_download   INTEGER DEFAULT 0,
    annotations      TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_files_short_id   ON files(short_id);
  CREATE INDEX IF NOT EXISTS idx_files_cluster    ON files(cluster_id);
  CREATE INDEX IF NOT EXISTS idx_files_user       ON files(user_id);
  CREATE INDEX IF NOT EXISTS idx_files_expires    ON files(expires_at);
  CREATE INDEX IF NOT EXISTS idx_files_active     ON files(is_active);

  -- upload_log: persists per-user upload counts even after files are deleted.
  -- Stores a pseudonymous user_tag (HMAC), never a raw username or user_id.
  CREATE TABLE IF NOT EXISTS upload_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_tag     TEXT NOT NULL,
    uploaded_at  DATETIME NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_upload_log_tag ON upload_log(user_tag);
  CREATE INDEX IF NOT EXISTS idx_upload_log_at  ON upload_log(uploaded_at);
`);

// ── safe migrations (add columns that may be missing in older DBs) ──────────
const migrations = [
  'ALTER TABLE files ADD COLUMN annotations TEXT',
  'ALTER TABLE files ADD COLUMN allow_annotations INTEGER DEFAULT 1',
  'ALTER TABLE files ADD COLUMN allow_download INTEGER DEFAULT 0',
  'ALTER TABLE files ADD COLUMN cluster_id TEXT',
  'ALTER TABLE files ADD COLUMN parent_short_id TEXT',
  'ALTER TABLE files ADD COLUMN delete_token TEXT',
  'ALTER TABLE files ADD COLUMN integrity_hash TEXT',
  'ALTER TABLE files ADD COLUMN compressed INTEGER DEFAULT 0',
  'ALTER TABLE files ADD COLUMN encrypted INTEGER DEFAULT 0',
  'ALTER TABLE files ADD COLUMN stored_filename TEXT',
  // pseudonymous user tag replaces direct user_id linkage in queries
  'ALTER TABLE files ADD COLUMN user_tag TEXT',
];

for (const sql of migrations) {
  try { db.exec(sql); } catch { /* column already exists — ignore */ }
}

module.exports = { db, DATA_DIR, UPLOADS_DIR, DB_PATH };
