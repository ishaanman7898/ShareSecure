CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  short_id TEXT UNIQUE NOT NULL,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  file_data TEXT NOT NULL,
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME,
  download_count INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  source_short_id TEXT,
  is_used INTEGER DEFAULT 0,
  delete_token TEXT,
  integrity_hash TEXT NOT NULL,
  annotations TEXT DEFAULT '[]',
  cluster_id TEXT,                     -- Groups all links for one upload
  parent_short_id TEXT                 -- For branch-level deletion
);
