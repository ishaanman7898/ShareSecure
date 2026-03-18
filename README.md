# ShareSecure

![ShareSecure](./public/ShareSecure.png)

**Private, encrypted, ephemeral file sharing — built for people who care about privacy.**

Upload a PDF or Word document, get a short-lived encrypted link, share it. Every recipient gets their own unique, untraceable link. When the timer hits zero, the file is gone for good.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org)

---

## Features

| Feature | Details |
|---|---|
| **End-to-end privacy** | No IP logging, no cookies, no analytics. Zero user tracking. |
| **AES-256-GCM encryption** | Every file is encrypted at rest with a unique per-file key. |
| **Untraceable resharing** | Each share generates an independent link with no chain back to the original. |
| **SHA-256 integrity** | Every file access is verified against its upload-time hash. |
| **Magic byte validation** | File type is determined by binary signature — not filename or MIME header. Spoofing is impossible. |
| **Auto-expiry** | Files self-destruct in 1 minute to 24 hours. No backups. No archives. |
| **Screenshot protection** | Content blanks when the window loses focus. Right-click, print, and save-as are blocked. |
| **PDF annotations** | Mark up PDFs with pen, highlighter, text, and eraser. Annotations are isolated per-link. |
| **Client-side dashboard** | Upload history lives in `localStorage` — no server-side user→file association. |
| **Self-hostable** | Run your own private instance. You own the data and the keys. |

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

> **IP Notice:** Your IP address is visible to the server and any network infrastructure between you and it. ShareSecure does not log IPs in application code, but the underlying OS or hosting provider may retain connection-level logs outside the application's control. Use **Tor** or a trusted **VPN** if IP anonymity is required.

---

## Architecture

```
sharesecure/
├── db/                              # Database schemas (reference — server auto-creates tables)
│   ├── schema.sql                   # Files table
│   └── auth_schema.sql              # Users table
├── docs/                            # Documentation
│   └── SECURITY.md                  # Vulnerability reporting & security policy
├── public/                          # Static frontend (served at root)
│   ├── index.html / app.js          # Upload page
│   ├── viewer.html / viewer.js      # File viewer (PDF.js, annotations, screenshot protection)
│   ├── style.css / viewer.css       # Styles
│   ├── terms.html                   # Terms & Conditions
│   ├── security.html                # Security policy
│   ├── 404.html / expired.html      # Error pages
│   ├── download.html                # Self-host installer page
│   ├── install.sh / install.ps1     # One-line installer scripts
│   └── qrcode.min.js                # Client-side QR generation (no third-party calls)
├── server/                          # Express.js server (self-hosted mode)
│   ├── index.js                     # Entry point, middleware, cleanup
│   ├── db.js                        # SQLite setup & auto-migrations
│   ├── utils.js                     # AES-256-GCM encryption, compression, pseudonymous IDs
│   └── routes/
│       ├── files.js                 # Upload / download / delete / reshare
│       └── auth.js                  # Authentication
├── functions/                       # Cloudflare Pages Functions (serverless)
│   ├── _middleware.js               # Security headers
│   ├── _turso.js                    # Turso/libSQL connection helper
│   └── api/                         # Mirrors server/routes/ for the edge
├── .env.example                     # Environment variable template
├── wrangler.toml.example            # Cloudflare Pages config template (real file is gitignored)
└── package.json
```

---

## Self-Hosting

Run your own private ShareSecure instance. You own the data, you control the encryption key.

### Prerequisites

- **Node.js 18+** — [nodejs.org](https://nodejs.org)
- **Git** — [git-scm.com](https://git-scm.com)

---

### Step 1 — Clone & Install

```bash
git clone https://github.com/ishaanman7898/ShareSecure.git
cd ShareSecure
npm install
```

---

### Step 2 — Generate an Encryption Key

```bash
npm run generate-key
```

This prints a `ENCRYPTION_KEY=<64 hex chars>` line. Copy the entire thing.

Alternatives:
```bash
# Node.js (any platform)
node -e "console.log('ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"

# OpenSSL
openssl rand -hex 32   # then prefix: ENCRYPTION_KEY=<output>
```

---

### Step 3 — Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
PORT=3000
BASE_URL=http://localhost:3000

# Paste from Step 2
ENCRYPTION_KEY=your64hexcharskeyhere

# Set to false to disable the localtunnel public URL
USE_LOCAL_TUNNEL=true

# Optional: reserve a stable localtunnel subdomain
# TUNNEL_SUBDOMAIN=my-sharesecure
```

> **Important:** Keep `ENCRYPTION_KEY` backed up safely. Losing it makes all stored files permanently unreadable.

**First-run shortcut:** If you skip `.env` setup, the server auto-generates one on first start. Check the console and back up the printed key.

---

### Step 4 — Start

```bash
npm start
```

Opens on `http://localhost:3000`. If `USE_LOCAL_TUNNEL=true`, a public HTTPS URL is printed to the console — share it with anyone.

For development with auto-restart:
```bash
npm run dev
```

---

### Cloudflare Pages Deployment (Serverless)

For a zero-maintenance serverless deployment on Cloudflare's global edge:

**Requirements:**
- Free [Cloudflare](https://cloudflare.com) account
- Free [Turso](https://turso.tech) database (SQLite on the edge)

**Steps:**

1. Fork this repo to your GitHub account
2. Cloudflare → Pages → Create project → Connect your fork
3. Set build output directory to `public` (no build command)
4. Copy `wrangler.toml.example` to `wrangler.toml` and fill in your Turso org/region
5. In Pages → Settings → Environment Variables, add:
   - `TURSO_TOKEN` — your Turso auth token
   - `ENCRYPTION_KEY` — 64 hex chars
   - `BASE_URL` — your Pages URL (e.g. `https://sharesecure.pages.dev`)
6. Run the schema in your Turso database:
   ```bash
   turso db shell YOUR_DB_NAME < db/schema.sql
   ```
7. Deploy

> `wrangler.toml` is gitignored — your Turso credentials never enter version control.

---

### Production: Reverse Proxy

**Nginx:**
```nginx
server {
    listen 80;
    server_name sharesecure.yourdomain.com;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl;
    server_name sharesecure.yourdomain.com;
    ssl_certificate     /etc/letsencrypt/live/sharesecure.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sharesecure.yourdomain.com/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        client_max_body_size 12M;
    }
}
```

**Caddy (automatic HTTPS):**
```caddyfile
sharesecure.yourdomain.com {
    reverse_proxy localhost:3000
    request_body { max_size 12MB }
}
```

Set `BASE_URL=https://sharesecure.yourdomain.com` and `USE_LOCAL_TUNNEL=false` in `.env`.

---

### Run as a System Service (Linux)

```bash
sudo nano /etc/systemd/system/sharesecure.service
```

```ini
[Unit]
Description=ShareSecure
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/sharesecure
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sharesecure
sudo systemctl status sharesecure
```

---

### Environment Variables Reference

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `BASE_URL` | `http://localhost:3000` | Public-facing URL for generated links |
| `ENCRYPTION_KEY` | *(auto-generated)* | 64 hex chars — AES-256-GCM master key |
| `USE_LOCAL_TUNNEL` | `true` | Set `false` to disable localtunnel |
| `TUNNEL_SUBDOMAIN` | *(random)* | Fixed subdomain for localtunnel |
| `DATA_DIR` | `./data` | Directory for the SQLite DB and file blobs |
| `DB_PATH` | `<DATA_DIR>/sharesecure.db` | Override database path |

---

### Troubleshooting

| Problem | Fix |
|---|---|
| `ENCRYPTION_KEY not set` warning | Run `npm run generate-key`, add the output to `.env` |
| Port already in use | Set `PORT=3001` in `.env` |
| localtunnel not starting | Set `USE_LOCAL_TUNNEL=false` in `.env` |
| `Cannot find module` on startup | Run `npm install` |

---

## API Reference

### `POST /api/upload`
Upload a file. Returns a short URL, delete token, and expiry.

**Body:** `multipart/form-data`
- `file` — PDF or DOCX, max 10 MB
- `expires_hours` — expiry in hours (min 1 min, max 24 h)
- `allow_annotations` — `1` to enable annotations
- `allow_download` — `1` to enable download button
- `display_name` — optional custom display name

**Response:**
```json
{
  "shortId": "ABC12345",
  "shortUrl": "https://example.com/r/ABC12345",
  "filename": "document.pdf",
  "size": 245760,
  "expiresAt": "2024-01-01T13:00:00.000Z",
  "deleteToken": "x9Kp2mQ7..."
}
```

### `GET /api/info/:shortId`
File metadata (no file content).

### `GET /api/raw/:shortId`
Raw file bytes for viewer rendering. Returns `application/octet-stream`.

### `POST /api/reshare/:shortId`
Generate a new untraceable link pointing to the same content.

### `POST /api/delete/:shortId`
Delete a file. Body: `{ "deleteToken": "..." }`. Cascades to the entire share cluster.

### `GET|POST /api/annotations/:shortId`
Load or save PDF annotation strokes. Annotations are encrypted and link-isolated.

---

## Security

- AES-256-GCM encryption at rest with per-file key wrapping
- SHA-256 integrity verification on every file access
- Magic byte + ZIP manifest validation (DOCX must contain `word/document.xml`)
- No IP logging, no referrer headers, no caching, no iframe embedding
- Pseudonymous rate limiting via HMAC-derived tags (no raw user IDs in `upload_log`)
- Client-side dashboard — no server-side user→file association

See [Security Policy](docs/SECURITY.md) for vulnerability disclosure and full details.

---

## Legal

By using ShareSecure, you agree to the [Terms & Conditions](/terms). The operator bears **zero liability** for content uploaded, shared, stored, or transmitted by users. You are solely responsible for all content you upload and share.

See [Terms & Conditions](/terms) for the full disclaimer.

---

## License

[MIT](LICENSE)
