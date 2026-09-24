# Security

## Reporting a problem

Please don't open a public issue for security problems. Email **ishaanmanoor1@gmail.com** with what's affected, how to reproduce it, and what someone could do with it.

## How files are protected

- Files, their names and notes are encrypted with AES-256-GCM. Each file has its own key, derived from a server master key.
- Links expire after 1 hour to 10 days. Expired files are erased.
- Uploads from the browser an account was created in carry a zero-knowledge proof of membership, so the file isn't linked to the account. See [ZK-INTEGRATION.md](ZK-INTEGRATION.md).
- The self-hosted server checks file types by their contents, not their names, and strips author and editing metadata from PDF and DOCX files.
- Pages send `noindex`, `no-store` and `frame-ancestors 'none'`, and there are no analytics or third-party scripts.

## Limitations

- Encryption isn't end-to-end: whoever holds the master key can decrypt files while they exist. Self-host for sensitive files.
- Anyone with a link can open the file until it expires.
- The hosting provider and your network can see your IP address. Use Tor or a VPN if that matters.

The same information for users is at [/security](https://sharesecure-du8.pages.dev/security) and [/privacy](https://sharesecure-du8.pages.dev/privacy).
