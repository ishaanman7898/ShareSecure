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
| **AES-256-GCM encryption** | Every file is encrypted at rest with a unique per-file key derived via HKDF. |
| **Untraceable resharing** | Each share generates an independent link with no chain back to the original. |
| **Metadata Stripping** | Automatically removes author, creator, and timestamp metadata from PDF/DOCX files. |
| **Magic Byte Validation** | Content-based file type detection. Prevents spoofing via extensions or MIME headers. |
| **SHA-256 Integrity** | Every file access is verified against its upload-time HMAC-SHA256 hash. |
| **Auto-expiry** | Files self-destruct in 1 minute to 24 hours (configurable up to 72h). No backups. |
| **Screenshot Protection** | Content blanks when the window loses focus. Right-click and print are blocked. |
| **PDF Annotations** | Mark up PDFs with pen, highlighter, and text. Annotations are link-isolated. |
| **Pseudonymous Dashboard** | Upload history lives in `localStorage`. Server only tracks counts via HMAC tags. |
| **Rate Limiting** | Built-in 5-upload-per-day limit for authenticated users to prevent abuse. |

---

## Privacy Model

```
 You                      Friend A                  Friend B
   │                         │                         │
   │  upload document        │                         │
   │  receive link: /r/ABC   │                         │
   │                         │                         │
   │  send /r/ABC ─────────► │                         │
   │                         │  opens link             │
   │                         │  gets new link: /r/XYZ  │
   │                         │  (completely separate)  │
   │                         │                         │
   │                         │  send /r/XYZ ─────────► │
   │                         │                         │  opens link
   │                         │                         │  gets link: /r/QRS
   │                         │                         │  (totally independent)
   ▼                         ▼                         ▼
DB Row ABC               DB Row XYZ               DB Row QRS
[identical structure]    [identical structure]    [identical structure]

Even a full database leak cannot reconstruct who shared with whom.
All rows look identical — no timestamps, no parent references, no fingerprints.
```

### The "Zero-Knowledge" Philosophy
- **No User Association**: While you can create an account, the server never stores your username next to your files. Instead, it uses a one-way HMAC of your user ID to track rate limits without knowing *what* you uploaded.
- **Client-Side History**: Your list of uploaded files is stored entirely in your browser's `localStorage`. If you clear your cache or switch browsers, the history is gone.
- **Ephemeral Keys**: Encryption keys can be rotated. If the master key is lost, all data becomes unreadable—this is by design.

---

## Architecture

```
sharesecure/
├── db/                              # Database schemas & migrations
│   ├── schema.sql                   # Files and Upload logs
│   └── auth_schema.sql              # Users table
├── docs/                            # Detailed documentation
│   ├── SECURITY.md                  # Security policy & disclosure
│   └── TERMS_AND_CONDITIONS.md      # Full legal terms
├── public/                          # Static frontend assets
│   ├── index.html / app.js          # Upload & Dashboard logic
│   ├── viewer.html / viewer.js      # Encrypted viewer (PDF.js + Protection)
│   ├── style.css / viewer.css       # Modern glassmorphism UI
│   └── ...                          # Terms, Security, and Error pages
├── server/                          # Express.js backend
│   ├── index.js                     # Server entry & middleware
│   ├── db.js                        # SQLite/Better-SQLite3 configuration
│   ├── utils.js                     # Crypto, Compression, & Metadata stripping
│   └── routes/
│       ├── files.js                 # Upload, Download, Reshare, Delete
│       └── auth.js                  # Registration & Session management
├── functions/                       # Cloudflare Pages Functions (Serverless)
│   ├── api/                         # Edge-ready API mirrors
│   └── _turso.js                    # Turso/libSQL edge connector
├── .env.example                     # Template for secrets
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

3. **Generate your master encryption key:**
   ```bash
   npm run generate-key
   ```
   *Copy the `ENCRYPTION_KEY=...` line provided.*

4. **Configure environment:**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and paste your key. Ensure `BASE_URL` matches your intended access point.

5. **Start the server:**
   ```bash
   npm start
   ```
   The app will be available at `http://localhost:3000`.

---

## Deployment Options

### 1. Cloudflare Pages (Serverless Edge)
Perfect for zero-maintenance, global availability.
- **DB**: Use [Turso](https://turso.tech) for edge-compatible SQLite.
- **Setup**: Connect your GitHub fork to Cloudflare Pages.
- **Vars**: Set `TURSO_TOKEN`, `ENCRYPTION_KEY`, and `BASE_URL` in the Pages dashboard.
- **Schema**: Import `db/schema.sql` into your Turso database.

### 2. Traditional VPS (Nginx/Caddy)
Recommended for high-performance private instances.
- Use **Nginx** or **Caddy** as a reverse proxy.
- Set `USE_LOCAL_TUNNEL=false` in production.
- Use **systemd** to manage the process (see example in `docs/`).

---

## API Reference

### Authentication
- `POST /api/auth/register`: Create a pseudonymous account.
- `POST /api/auth/login`: Start a session and receive an auth token.
- `GET /api/auth/user/files`: Get the current user's daily upload usage.

### File Operations
- `POST /api/upload`: Upload a PDF/DOCX (max 10MB).
- `GET /api/info/:shortId`: Retrieve metadata (size, filename, expiry) without file content.
- `GET /api/raw/:shortId`: Stream decrypted/decompressed file bytes (viewer use).
- `GET /api/download/:shortId`: Force download (owner/permitted only).
- `POST /api/reshare/:shortId`: Create a new, independent link for an existing file.
- `POST /api/delete/:shortId`: Immediate destruction of a file cluster.

### Annotations
- `GET /api/annotations/:shortId`: Load encrypted PDF markup.
- `POST /api/annotations/:shortId`: Save new encrypted markup strokes.

---

## Security Deep Dive

### AES-256-GCM Encryption
Files are not just encrypted with a master key. We use **Forward Secrecy per file**:
1. A random 32-byte key is generated for every upload.
2. The file is compressed (zlib) then encrypted with this unique key.
3. The unique key is wrapped using the `ENCRYPTION_KEY` via HKDF.
4. Even if one file's key is compromised, others remain safe.

### Magic Byte Validation
We don't trust `.pdf` or `.docx` extensions. 
- **PDFs**: Checked for `%PDF` header.
- **DOCX**: Checked for ZIP structure AND the internal `word/document.xml` manifest.
This prevents attackers from uploading malicious scripts disguised as documents.

### Metadata Stripping
Before a document is stored, it is scrubbed:
- **PDF**: XMP metadata, Info dicts, and Creator tools are wiped.
- **DOCX**: `docProps/core.xml` and `docProps/app.xml` are sanitized.

---

## Troubleshooting

| Issue | Solution |
|---|---|
| **ENCRYPTION_KEY not set** | Run `npm run generate-key` and update your `.env`. |
| **Upload Limit Reached** | Wait 24h or use a different authenticated session. |
| **File Not Found (404)** | The file may have expired and been automatically deleted. |
| **Decryption Failed** | The `ENCRYPTION_KEY` has changed since the file was uploaded. |

---

## Legal

ShareSecure is provided "as is" without warranty. Operators are not liable for user-generated content. See [Terms & Conditions](/terms) for full details.

---

## License

[MIT](LICENSE) © 2024 Ishaan
