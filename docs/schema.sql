-- Run this on your Turso database to set up the files table.
-- All sensitive fields (file_data, original_filename, mime_type, annotations)
-- are AES-256-GCM encrypted at the application layer before storage.

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  short_id TEXT UNIQUE NOT NULL,
  original_filename TEXT NOT NULL,    -- encrypted: enc:<base64(iv+ciphertext)>
  mime_type TEXT NOT NULL,            -- encrypted: enc:<base64(iv+ciphertext)>
  size_bytes INTEGER NOT NULL,
  file_data TEXT NOT NULL,            -- encrypted: enc:<base64(iv+ciphertext)>
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME,                -- required, auto-deleted after expiry
  download_count INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  compressed INTEGER DEFAULT 0,       -- 1 = deflate compressed before encrypt
  delete_token TEXT,                  -- plaintext 24-char token for anonymous delete
  user_id INTEGER,                    -- null for anonymous uploads
  integrity_hash TEXT NOT NULL,       -- SHA-256 of raw plaintext bytes (pre-compress/encrypt)
  annotations TEXT DEFAULT '[]',      -- encrypted JSON array of annotation strokes
  cluster_id TEXT,                    -- zero-knowledge group hash
  parent_short_id TEXT                -- for hierarchical deletion
);

CREATE INDEX IF NOT EXISTS idx_expires_at ON files(expires_at);
CREATE INDEX IF NOT EXISTS idx_user_id ON files(user_id);
