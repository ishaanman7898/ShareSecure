const { createClient } = require('@libsql/client');
const path = require('path');

// Local SQLite fallback (optional, but keeping createClient for Turso)
// For local dev, we use Turso clients with the provided URLs

const TURSO_AUTH_URL = process.env.TURSO_AUTH_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;
const TURSO_SECURE_TOKEN = process.env.TURSO_TOKEN;

if (!TURSO_AUTH_URL || !TURSO_AUTH_TOKEN || !TURSO_SECURE_TOKEN) {
  console.error('CRITICAL: Missing Turso environment variables!');
}

// Auth Database Client
const userDb = createClient({
  url: TURSO_AUTH_URL || '',
  authToken: TURSO_AUTH_TOKEN || ''
});

// Main Files Client (Shard Helper)
const getFileClient = (nodeNum = 1) => {
  const nodeName = `fileshare-node-${nodeNum}`;
  const hostname = `${nodeName}-ishman.aws-us-east-2.turso.io`;
  return createClient({
    url: `libsql://${hostname}`,
    authToken: TURSO_SECURE_TOKEN
  });
};

// Simple default client for standard queries
const db = getFileClient(1);

// Initialize Tables on Turso (Auth)
userDb.execute(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    access_code TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).then(() => console.log('Auth DB connected and initialized.'))
  .catch(err => {
    console.error('FAILED TO INITIALIZE USERS TABLE:', err.message);
  });

// Initialize Tables on Turso (Files - Node 1)
async function initFilesDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      short_id TEXT UNIQUE NOT NULL,
      original_filename TEXT NOT NULL,
      stored_filename TEXT,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME,
      download_count INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      user_id INTEGER
    )
  `);

  // Add missing columns (ignore if already exist)
  const addCols = [
    'ALTER TABLE files ADD COLUMN stored_filename TEXT',
    'ALTER TABLE files ADD COLUMN user_id INTEGER',
  ];
  for (const sql of addCols) {
    await db.execute(sql).catch(() => {});
  }

  // Drop old NOT NULL columns from previous schema that break inserts (ignore if already gone)
  const dropCols = [
    'ALTER TABLE files DROP COLUMN file_data',
    'ALTER TABLE files DROP COLUMN integrity_hash',
  ];
  for (const sql of dropCols) {
    await db.execute(sql).catch(() => {});
  }

  console.log('Files DB connected and initialized.');
}

initFilesDb().catch(err => console.error('FAILED TO INITIALIZE FILES TABLE:', err.message));

module.exports = { db, userDb, getFileClient };
