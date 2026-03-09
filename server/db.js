const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../fileshare.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    short_id TEXT UNIQUE NOT NULL,
    original_filename TEXT NOT NULL,
    stored_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    download_count INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1
  )
`);

module.exports = db;
