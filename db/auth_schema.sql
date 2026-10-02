-- Accounts. The API also creates this table, and adds the newer columns, by itself.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  access_code TEXT NOT NULL,      -- 'opaque' once the account signs in without sending its password
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  opaque_record TEXT,             -- what the server keeps instead of a password (see public/opaque.js)
  public_key TEXT,                -- the account's end-to-end public key
  private_key_box TEXT,           -- its private key, locked in the browser
  vault TEXT                      -- its list of shares, sealed to its own key
);
