# Security

## Reporting a problem

Please don't open a public issue for security problems. Email **ishaanmanoor1@gmail.com** with what's affected, how to reproduce it, and what someone could do with it.

## How files are protected

- Files, their names and notes are encrypted with AES-256-GCM. Each file has its own key, derived from a server master key.
- Links expire after 1 hour to 10 days. Expired files are erased.
- Uploads from the browser an account was created in use a proof instead of the session token, and the stored file row has no account link. The server still learns which account is uploading while it checks the proof (the challenge is issued to an account, and the proof carries that account's commitment). See [Known limitations](#known-limitations) and [ZK-INTEGRATION.md](ZK-INTEGRATION.md).
- The self-hosted server checks file types by their contents, not their names, and strips author and editing metadata from PDF and DOCX files.
- Pages send `noindex`, `no-store` and a Content-Security-Policy that only runs the site's own scripts, plus pdf.js and mammoth from jsDelivr for the viewer. There are no analytics.
- On the hosted site, session tokens are signed and expire after 30 days. Access codes are stored as salted PBKDF2-SHA256 hashes, and repeated failed sign-ins are slowed down.

## Known limitations

- **Encryption happens on the server, not end-to-end.** Files are encrypted inside the hosted server after they arrive. The hosting provider (Cloudflare), and anyone who holds `ENCRYPTION_KEY` or the other server secrets, can read files, their names and notes while they exist. They can also see who sends a file to whom: sending to a username goes through the server signed in, and the server links the sender's link to the recipient. Self-host for sensitive files.
- **The Unigroth proofs are experimental and currently don't hide who uploads.** They aren't sound or unlinkable today:
  - The verifier only re-checks 32 consecutive constraints out of about 549, and trusts an `aggregatedCheck` value the prover supplies. A proof-of-concept forged 10 out of 10 proofs this way, without the secret.
  - Each challenge is issued to a signed-in account and stored with it, and the proof carries that account's commitment, so the server knows which account is uploading.
  - The commitment hash can be worked backwards to a small set of candidate secrets.

  In practice a forged proof gains nothing, because a challenge can only be used by the account it was issued to. But the feature does not currently provide anonymity, and it shouldn't be relied on for that.
- The viewer loads pdf.js and mammoth from jsDelivr. mammoth is pinned with an integrity hash; pdf.js is loaded as a module and isn't yet.
- Anyone with a link can open the file until it expires.
- The hosting provider and your network can see your IP address. Use Tor or a VPN if that matters.

## Planned

- End-to-end encryption in the browser: the file is encrypted before upload and the key goes in the part of the link after `#`, which browsers never send to a server.
- Sealed sends: files sent to a username are encrypted to the recipient's public key, so the server can't read them or see who sent them.
- Replacing Unigroth with an audited anonymous-credential scheme, or removing it.
- Serving pdf.js and mammoth from this site instead of a CDN.

## Fixed in this release

- Session tokens can no longer be made up when `TOKEN_SECRET` isn't set. Sign-in now refuses to work instead, and the old unsigned token format is no longer accepted.
- Session tokens expire 30 days after they're issued. Older tokens without an expiry stop working 30 days after they were issued.
- Access codes are hashed with PBKDF2-SHA256 and a random salt per account (10,000 iterations by default to fit the free plan's CPU limit; raise it with PBKDF2_ITER, up to 100,000). Older unsalted SHA-256 hashes are upgraded the next time the person signs in.
- Sign-in is limited to 10 failed attempts per username and per IP address every 15 minutes. IP addresses are stored only as a keyed hash.
- Sign-in errors no longer include internal error details.
- New usernames are 3 to 32 letters, numbers, dots, dashes or underscores, and names that differ only by capitalisation count as the same name.
- Word documents are cleaned before they're shown: only basic formatting, `http`, `https` and `mailto` links, and embedded images are kept. A document can no longer run script through a `javascript:` link.
- Pages send a full Content-Security-Policy instead of only `frame-ancestors`.
- Annotations can only be read and saved by the owner of the link, who proves it with the link's delete token. Saved strokes are checked against a strict format and size limit, and expired links can't be annotated.
- Delete tokens are compared in constant time.
- Plain text, Markdown and CSV files are shown as plain text, never as HTML.

The same information for users is at [/security](https://sharesecure-du8.pages.dev/security) and [/privacy](https://sharesecure-du8.pages.dev/privacy).
