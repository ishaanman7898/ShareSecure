# ShareSecure

![ShareSecure](./public/ShareSecure.png)

**Private, encrypted, ephemeral file sharing — built for people who care about privacy.**

Upload a PDF or Word document, get a short-lived encrypted link, share it. Every recipient gets their own unique, untraceable link. When the timer hits zero, the file is gone for good.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org)
[![Security: AES-256-GCM](https://img.shields.io/badge/Security-AES--256--GCM-success.svg)](#security)

---

## Features

| Feature | Details |
|---|---|
| **End-to-end privacy** | No IP logging, no cookies, no analytics. Zero user tracking by default. |
| **AES-256-GCM encryption** | Every file is encrypted at rest with a unique per-file key (forward secrecy). |
| **Untraceable resharing** | Each Share click generates an independent link with no chain back to the original. |
| **Metadata Stripping** | Automatically removes author, creator, and timestamp metadata from PDF/DOCX files before storage. |
| **Magic Byte Validation** | Content-based file type detection. Prevents type spoofing via extensions or MIME headers. |
| **SHA-256 Integrity** | Every file access is verified against its upload-time HMAC-SHA256 hash. |
| **Auto-expiry** | Files self-destruct in as little as 1 minute and up to 30 days. Configurable at upload. |
| **Screenshot Protection** | Content blanks when the window loses focus. Right-click and print are disabled. |
| **Pseudonymous Dashboard** | Upload history lives in `localStorage`. The server never stores your username next to your files. |
| **Rate Limiting** | Built-in 5-upload-per-day limit for authenticated users to prevent abuse. |
| **Anonymous Inbox** | Send files to other registered users without revealing who sent them. |

---

## Privacy Model

Every time someone clicks **Share**, a brand-new database row is created pointing to the same encrypted file bytes — with a fresh ID, fresh delete token, and a randomised integrity hash. There is no `parent_id`, no chain, no timestamp correlation. Even a full database dump cannot reconstruct who shared with whom.

```
 You                      Friend A                  Friend B
   │                         │                         │
   │  upload → link /r/ABC   │                         │
   │  send /r/ABC ─────────► │                         │
   │                         │  opens /r/ABC           │
   │                         │  Share → /r/XYZ         │
   │                         │  send /r/XYZ ─────────► │
   │                         │                         │  opens /r/XYZ
   │                         │                         │  Share → /r/QRS
   ▼                         ▼                         ▼
DB Row ABC               DB Row XYZ               DB Row QRS
[no parent link]         [no parent link]         [no parent link]
```

### The "Zero-Knowledge" Philosophy

- **No User Association**: The server never stores your username next to your files. It uses a one-way HMAC of your user ID only to track daily upload counts — not what you uploaded.
- **Client-Side History**: Your list of uploaded files lives entirely in your browser's `localStorage`. Clearing your cache or switching browsers removes the list from your view, but the files remain live on the server until they expire.
- **Forward Secrecy**: Each file gets a unique random encryption key. Compromising the master key only affects files encrypted after that point.
- **Ephemeral Keys**: If the `ENCRYPTION_KEY` is rotated or lost, all existing data becomes permanently unreadable — by design.

---

## Architecture

```
sharesecure/
├── db/                              # Database schemas
│   ├── schema.sql                   # Files and upload logs
│   └── auth_schema.sql              # Users table
├── docs/                            # Policy documents
│   ├── SECURITY.md
│   └── TERMS_AND_CONDITIONS.md
├── public/                          # Static frontend
│   ├── index.html / app.js          # Upload & dashboard
│   ├── viewer.html / viewer.js      # Secure viewer (PDF.js + screenshot protection)
│   ├── style.css / viewer.css       # UI styles
│   └── ...                          # Terms, security, error pages
├── server/                          # Express.js backend (self-hosted)
│   ├── index.js                     # Server entry, cleanup scheduler
│   ├── db.js                        # SQLite / better-sqlite3 config
│   ├── utils.js                     # AES-256-GCM crypto, metadata stripping
│   └── routes/
│       ├── files.js                 # Upload, download, reshare, delete, send
│       └── auth.js                  # Register, login
├── functions/                       # Cloudflare Pages Functions (serverless)
│   ├── api/                         # Edge-ready API mirrors
│   └── _turso.js                    # Turso/libSQL edge connector
├── .env.example                     # Config template
└── wrangler.toml.example            # Cloudflare deployment config
```

---

## Self-Hosting

Run your own private ShareSecure instance. You own the data, you control the encryption key.

### Prerequisites

- **Node.js 18+**
- **Git**

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/ishaanman7898/ShareSecure.git
   cd ShareSecure
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Start the server** (auto-generates `.env` with a secure encryption key on first run):
   ```bash
   npm start
   ```
   The app is available at `http://localhost:3000`.

   To use a custom key, run `npm run generate-key`, then paste the output into `.env` before starting.

### Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `ENCRYPTION_KEY` | auto-generated | 64-char hex key for AES-256-GCM. Rotate with care — files encrypted under the old key become unreadable. |
| `PORT` | `3000` | HTTP port. |
| `BASE_URL` | `http://localhost:PORT` | Public-facing URL used in share links. Set this to your domain in production. |
| `USE_LOCAL_TUNNEL` | `true` | Auto-start a public localtunnel for easy testing. Set `false` in production. |

---

## Deployment Options

### 1. Cloudflare Pages (Serverless Edge)

Zero-maintenance, global availability.

- **DB**: Use [Turso](https://turso.tech) for edge-compatible SQLite.
- **Setup**: Connect your GitHub fork to Cloudflare Pages.
- **Env vars**: Set `TURSO_URL`, `TURSO_TOKEN`, `ENCRYPTION_KEY`, `TOKEN_SECRET`, and `BASE_URL` in the Pages dashboard.
- **Schema**: Import `db/schema.sql` into your Turso database.

### 2. Traditional VPS (Nginx / Caddy)

Recommended for high-performance private instances.

```
# Example Nginx reverse proxy
server {
    listen 443 ssl;
    server_name share.example.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

- Set `USE_LOCAL_TUNNEL=false` in `.env`.
- Set `BASE_URL=https://share.example.com`.
- Use **systemd** or **PM2** to keep the process alive.

---

## API Reference

### Authentication
| Endpoint | Method | Description |
|---|---|---|
| `/api/auth/register` | POST | Create a pseudonymous account. Body: `{ username, access_code }` |
| `/api/auth/login` | POST | Start a session. Returns `{ token }` |
| `/api/auth/user/files` | GET | Get daily upload count for the authenticated user. |

### File Operations
| Endpoint | Method | Description |
|---|---|---|
| `/api/upload` | POST | Upload a PDF/DOCX (max 10 MB, multipart form). Fields: `file`, `expires_hours` (1/60 – 720), `allow_download` (0/1), `display_name` (optional). |
| `/api/info/:shortId` | GET | Retrieve metadata (filename, size, expiry) without file content. |
| `/api/raw/:shortId` | GET | Stream decrypted file bytes (used by the viewer). |
| `/api/download/:shortId` | GET | Force-download with original filename (only if `allow_download=1`). |
| `/api/reshare/:shortId` | POST | Generate a new, fully independent share link. |
| `/api/delete/:shortId` | POST | Immediately destroy the file and all related links. Body: `{ deleteToken }` |
| `/api/send/:shortId` | POST | Send a file to another registered user's inbox (anonymous sender). |
| `/api/inbox` | GET | Retrieve files sent to the authenticated user. |

---

## Security Deep Dive

### AES-256-GCM with Forward Secrecy

Each upload gets a unique 32-byte random key:

1. A random per-file key is generated.
2. The file is compressed (zlib DEFLATE) then encrypted with this key.
3. The per-file key is itself encrypted ("wrapped") with the master `ENCRYPTION_KEY` using HKDF.
4. Only the wrapped key is stored in the database — the raw file key never persists.

Compromising any single file's key does not expose others. Rotating the master key protects future uploads without affecting existing ones (until they expire).

### Magic Byte Validation

File extensions and MIME headers are ignored entirely:

- **PDFs**: Must start with `%PDF` (bytes `25 50 44 46`).
- **DOCX**: Must be a valid ZIP containing `word/document.xml`.

This prevents uploading malicious scripts disguised as documents.

### Metadata Stripping

Before storage, every document is scrubbed of identifying metadata:

- **PDF**: XMP blobs, Info dict fields (Author, Creator, Producer, CreationDate), and all string/hex metadata values are zeroed or removed.
- **DOCX**: `docProps/core.xml` (author, company, revision) and `docProps/app.xml` are replaced with empty equivalents. All ZIP entry timestamps are zeroed.

### Privacy Quantization

- **Upload time**: Rounded to the nearest hour boundary (reduces temporal fingerprinting).
- **File size**: Padded to the nearest 100 KB boundary (hides exact file size).
- **User tags**: Rate-limit tracking uses `HMAC-SHA256(userId, derivedKey)` — the raw user ID is never stored anywhere.

---

## Troubleshooting

| Issue | Solution |
|---|---|
| **File not found (404)** | The file may have expired and been automatically deleted. Expiry is enforced server-side. |
| **Decryption failed** | The `ENCRYPTION_KEY` has changed since the file was uploaded. Keys cannot be recovered. |
| **Upload limit reached (429)** | Wait 24 hours, or use a different authenticated session. |
| **ENCRYPTION_KEY not set** | Run `npm run generate-key` and paste the result into `.env`. |
| **Dashboard shows no files** | The file list is stored in `localStorage`. It is device- and browser-specific. Clearing browser data removes the list (files still exist on the server). |
| **Share link only works on my machine** | Your `BASE_URL` is set to `localhost`. Update it in `.env` to your LAN IP or public domain. |

---

## Legal

ShareSecure is provided "as is" without warranty. Operators are not liable for user-generated content. See [Terms & Conditions](/terms) for full details.

---

## License

[MIT](LICENSE) © 2024 Ishaan
