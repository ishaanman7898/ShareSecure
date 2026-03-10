const { createClient } = require('@libsql/client');
const path = require('path');

// local sqlite fallback (optional, but keeping createclient for turso)
// for local dev, we use turso clients with the provided urls

const TURSO_AUTH_URL = process.env.TURSO_AUTH_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;
const TURSO_SECURE_TOKEN = process.env.TURSO_TOKEN;

if (!TURSO_AUTH_URL || !TURSO_AUTH_TOKEN || !TURSO_SECURE_TOKEN) {
  console.error('CRITICAL: Missing Turso environment variables!');
}

// auth database client
const userDb = createClient({
  url: TURSO_AUTH_URL || '',
  authToken: TURSO_AUTH_TOKEN || ''
});

// main files client (shard helper)
const getFileClient = (nodeNum = 1) => {
  const nodeName = `fileshare-node-${nodeNum}`;
  const hostname = `${nodeName}-ishman.aws-us-east-2.turso.io`;
  return createClient({
    url: `libsql://${hostname}`,
    authToken: TURSO_SECURE_TOKEN
  });
};

// simple default client for standard queries
const db = getFileClient(1);

// initialize tables on turso (auth)
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

// initialize tables on turso (files - node 1)
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

  // add any missing columns — safe to run every startup (fails silently if already exists)
  const migrations = [
    'ALTER TABLE files ADD COLUMN stored_filename TEXT',
    'ALTER TABLE files ADD COLUMN user_id INTEGER',
    'ALTER TABLE files ADD COLUMN file_data TEXT',
    'ALTER TABLE files ADD COLUMN delete_token TEXT',
  ];
  for (const sql of migrations) {
    await db.execute(sql).catch(() => {});
  }

  console.log('Files DB connected and initialized.');
}

initFilesDb().catch(err => console.error('FAILED TO INITIALIZE FILES TABLE:', err.message));

module.exports = { db, userDb, getFileClient };
