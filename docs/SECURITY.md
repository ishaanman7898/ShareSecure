# Security Policy

> For the full interactive security policy, see [/security](../public/security.html) in the app.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email **ishaanmanoor1@gmail.com** with:
- Description of the vulnerability and affected component
- Steps to reproduce (if applicable)
- Potential impact — what could an attacker achieve?
- Suggested fix (optional but appreciated)

We aim to acknowledge all reports within 48 hours.

## Implemented Security Features

- **AES-256-GCM encryption at rest** — every file is encrypted with a unique per-file key
- **Per-file key wrapping** — ephemeral key encrypted under the master key; compromise of one file does not compromise others
- **Magic byte + ZIP manifest validation** — file type determined by binary signature, not filename or MIME header
- **SHA-256 integrity hashing** — verified on every file access
- **No IP logging** — forwarding headers stripped before reaching any route handler
- **Pseudonymous rate limiting** — HMAC-derived tags; database leak alone cannot link rate records to accounts
- **Client-side dashboard** — no server-side user→file association
- **Ephemeral storage** — files auto-delete from 1 minute to 24 hours; no backups or archives

## Known Limitations

- **IP address visibility:** The application does not log IPs, but the OS, web server, or hosting provider may retain connection-level logs. Use Tor or a VPN if IP anonymity is required.
- **Encryption key co-location:** The master key lives in `.env` alongside the application. For maximum security, inject it via environment variables or a secrets manager (AWS KMS, Cloudflare Secrets, etc.) rather than co-locating it with the database.
- **Screenshot protection is browser-level only:** OS-level screenshot tools (Snipping Tool, macOS screenshot) cannot be blocked by browser APIs.

## Supported Versions

Security updates are provided for the latest release only. See [github.com/ishaanman7898/ShareSecure/releases](https://github.com/ishaanman7898/ShareSecure/releases) for the current version.

## Best Practices for Users

- Use the shortest expiry that meets your needs
- Access over Tor or a VPN if IP anonymity is required
- Do not use this service as the sole copy of important files
- Keep authentication access codes unique and secure

## Best Practices for Self-Hosters

- Always set `ENCRYPTION_KEY` — without it, files are stored unencrypted on disk
- Inject `ENCRYPTION_KEY` via environment variables or a secrets manager
- Serve only over HTTPS
- Restrict filesystem access to the `data/` directory
- Keep Node.js and all dependencies updated
