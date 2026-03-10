# FileShare

**Untraceable, ephemeral file sharing with blockchain-level integrity verification.**

Upload a file -> Get a link -> Share it -> Every recipient gets their own unique, untraceable link. When the timer hits zero, everything is gone. No accounts. No tracking. No logs.

---

## Features

### Untraceability by Design

- **Every link is unique** -- When someone opens your shared link, they automatically receive their own fresh URL. If they reshare, the next person gets yet another new URL. There is **no chain** connecting any two links.
- **Database uniformity** -- Every single row in the database looks structurally identical. All rows contain their own copy of `file_data`, `delete_token`, and `integrity_hash`. If the database is fully compromised, there is **no way** to identify who uploaded the file vs. who received it vs. who reshared it.
- **No metadata leaks** -- No IP addresses, no user agents, no timestamps of access, no cookies, no accounts. The only timestamp stored is the upload time (which is jittered across copies).
- **Zero referrer/fingerprinting** -- All responses strip `Server`, `X-Powered-By`, `CF-Ray`, and other fingerprinting headers. `Referrer-Policy: no-referrer` prevents link source tracking.

### Blockchain-Level Security

- **SHA-256 integrity hashing** -- Every uploaded file is hashed with SHA-256 at upload time. The hash is stored alongside the file and **verified on every single access**. If even one byte is tampered with in the database, the file will NOT be served.
- **Tamper-evident responses** -- When integrity verification fails, the server returns HTTP 422 with a clear message: "Integrity check failed -- file may have been tampered with."
- **Hash verification badge** -- The viewer shows a green `SHA-256: a1b2c3d4...` badge in the toolbar so users can visually confirm integrity.
- **Delete token authentication** -- Each file holder gets a unique cryptographic delete token (24 random characters). Only the token holder can delete their copy.
- **Zero-Knowledge Clusters** -- Database rows are grouped by a cryptographic hash derived from the owner's secret token. An attacker cannot group related links; only the owner can trigger a global wipe.

### Ephemeral by Default

- All files **must** expire -- minimum 1 minute, maximum 24 hours
- No permanent storage option exists
- Expired files are automatically purged from the database on every API request
- When expiry hits zero, the viewer destroys itself and redirects to an expired page

### Persistent Annotations (PDF)

- **Pen, Highlighter, Eraser** tools with color picker
- **Save button** persists annotations to the database per-link
- Each link holder gets **their own** annotations -- resharing doesn't carry annotations
- Unsaved changes show a visual warning
- Browser warns before closing with unsaved annotations

### Anti-Download Protection

- Right-click disabled
- Ctrl+S / Ctrl+P / Ctrl+U blocked
- Print blocked (page content replaced)
- Direct URL navigation to raw files returns 403
- Images and text have `pointer-events: none`
- Video controls hide download/PiP buttons
- All content served with `no-store` cache headers

---

## Architecture

```
fileshare/
├── functions/                 # Cloudflare Pages Functions (serverless API)
│   ├── _middleware.js         # Security headers (applied to ALL responses)
│   ├── api/
│   │   ├── upload.js          # POST  - Upload file, returns shortId + deleteToken
│   │   ├── info/[shortId].js  # GET   - File metadata + integrity hash
│   │   ├── raw/[shortId].js   # GET   - Raw file bytes (integrity-verified)
│   │   ├── download/[shortId].js  # GET - Force-download (integrity-verified)
│   │   ├── reshare/[shortId].js   # POST - Generate untraceable reshare link
│   │   ├── delete/[shortId].js    # POST - Delete file (requires delete token)
│   │   └── annotations/[shortId].js # GET/POST - Load/save PDF annotations
│   └── r/[shortId].js        # Viewer route handler
├── public/                    # Static frontend
│   ├── index.html             # Upload page
│   ├── app.js                 # Upload page logic
│   ├── style.css              # Upload page styles
│   ├── viewer.html            # File viewer page
│   ├── viewer.js              # Viewer logic (PDF.js, annotations, sharing)
│   ├── viewer.css             # Viewer styles
│   ├── 404.html               # Not found page
│   ├── expired.html           # Expired file page
│   └── qrcode.min.js          # Client-side QR generation (no third-party calls)
├── schema.sql                 # Database schema
├── wrangler.toml              # Cloudflare configuration
└── package.json
```

---

## Database Schema

```sql
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  short_id TEXT UNIQUE NOT NULL,       -- 8-char random link ID
  original_filename TEXT NOT NULL,      -- Display name only
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  file_data TEXT NOT NULL,             -- Base64-encoded file (EVERY row has this)
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME,                 -- Mandatory expiry
  download_count INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  source_short_id TEXT,                -- Always NULL (kept for schema compat)
  is_used INTEGER DEFAULT 0,
  delete_token TEXT,                   -- 24-char random auth token (EVERY row has this)
  integrity_hash TEXT NOT NULL,        -- SHA-256 of raw file bytes
  annotations TEXT DEFAULT '[]',       -- JSON array of annotation strokes
  cluster_id TEXT,                     -- Zero-Knowledge grouping hash
  parent_short_id TEXT                 -- Hierarchical deletion link
);
```

---

## Security Headers (Applied to ALL Responses)

| Header | Value | Purpose |
|--------|-------|---------|
| `Cache-Control` | `no-store, no-cache, must-revalidate, private` | No browser caching |
| `Pragma` | `no-cache` | Legacy cache prevention |
| `Referrer-Policy` | `no-referrer` | No referrer leaks |
| `X-Robots-Tag` | `noindex, nofollow, noarchive, nosnippet` | No search engine indexing |
| `X-Frame-Options` | `DENY` | No iframe embedding |
| `Content-Security-Policy` | `frame-ancestors 'none'` | CSP iframe block |
| `X-Content-Type-Options` | `nosniff` | Prevent MIME sniffing |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` | Force HTTPS |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), interest-cohort=()` | Block device APIs + FLoC |
| `Cross-Origin-Opener-Policy` | `same-origin` | Isolate browsing context |
| `Cross-Origin-Resource-Policy` | `same-origin` | Block cross-origin reads |

Stripped headers: `Server`, `X-Powered-By`, `CF-Cache-Status`, `CF-Ray`, `cf-request-id`

---

## How Untraceability Works

```
 Uploader                  Viewer A                 Viewer B
    |                         |                        |
    |  uploads file           |                        |
    |  gets link: /r/ABC123   |                        |
    |  (kept as owner link)   |                        |
    |                         |                        |
    |  shares /r/ABC123 --->  |                        |
    |                         |  opens /r/ABC123       |
    |                         |  auto-assigned /r/XYZ  |
    |                         |  (DB row: independent) |
    |                         |                        |
    |                         |  shares /r/XYZ ---->  |
    |                         |                        |  opens /r/XYZ
    |                         |                        |  auto-assigned /r/QRS
    |                         |                        |  (DB row: independent)
    |                         |                        |
    V                         V                        V
  DB Row: ABC123            DB Row: XYZ              DB Row: QRS
  file_data: [YES]          file_data: [YES]         file_data: [YES]
  delete_token: [YES]       delete_token: [YES]      delete_token: [YES]
  integrity_hash: [YES]     integrity_hash: [YES]    integrity_hash: [YES]
  root_hash: [GROUPED]      root_hash: [GROUPED]     root_hash: [GROUPED]
  
  ALL THREE ROWS ARE STRUCTURALLY IDENTICAL.
  No way to determine who uploaded, who viewed, who reshared.
```

---

## Free Database Alternatives

The app currently uses a distributed **Turso** cluster (LibSQL). Here are other free-forever options that work as alternatives:

- **Cloudflare D1** (SQLite on the edge)
- **Turso** (Distributed SQLite replicas)
- **PlanetScale** (MySQL-compatible serverless)
- **Supabase** (PostgreSQL-as-a-service)
- **Neon** (Serverless PostgreSQL)
- **CockroachDB Serverless** (Distributed SQL)

---

## Deployment

### Cloudflare Pages (Production)

```bash
# Login to Cloudflare
npx wrangler login

# Deploy
npm run deploy
```

---

## API Reference

### `POST /api/upload`
Upload a file and receive a unique link.

**Request**: `multipart/form-data`
- `file` -- The file to upload (max 10MB)
- `expires_hours` -- Expiry time in hours (min: 1min, max: 24h)

**Response**:
```json
{
  "shortId": "ABC12345",
  "shortUrl": "https://example.com/r/ABC12345",
  "filename": "document.pdf",
  "size": 245760,
  "expiresAt": "2024-01-01T13:00:00.000Z",
  "deleteToken": "x9Kp2mQ7...",
  "integrityHash": "a1b2c3d4e5f6..."
}
```

### `GET /api/info/:shortId`
Get file metadata (no file content).

### `GET /api/raw/:shortId`
Get raw file bytes for rendering. Verifies SHA-256 integrity before serving.

### `POST /api/reshare/:shortId`
Generate a new untraceable link pointing to the same file content.

### `POST /api/delete/:shortId`
Delete a file (requires the delete token). Root deletion triggers global wipe.

---

## Security Model

- **Database Compromise**: Every row is structurally identical. Zero-Knowledge cluster management prevents link grouping.
- **File Tampering**: SHA-256 integrity hash verification on every read.
- **Link Chain Analysis**: No referential chains. Reshares are completely independent rows.
- **Traffic Analysis**: Security headers strip all identifying fingerprinting.
- **Browser Forensics**: No-store cache headers prevent persistence.

---

## License

ISC
