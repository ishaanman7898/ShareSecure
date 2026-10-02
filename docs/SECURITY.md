# Security

## Reporting a problem

Please don't open a public issue for security problems. Email **ishaanmanoor1@gmail.com** with what's affected, how to reproduce it, and what someone could do with it.

## How files are protected

**End-to-end encryption** (on by default on the website and for AI assistants)

- Your browser encrypts the file, its name and type, any note and any drawings with AES-256-GCM before uploading. The key is only in the link, after `#k=`, which browsers never send to a server. ShareSecure stores files it can't read.
- Files are padded to standard sizes (1 KB, 2 KB, 4 KB … 8 MB, 10 MB), so the server only learns roughly how big a file is.
- A link can also need a **passcode**. Then the link holds only half the key, and the passcode (stretched with 600,000 rounds of PBKDF2) is the other half. Anyone who only has the link can't open the file.
- Files sent to a username have their key sealed to that person's public key (ECDH P-256 + HKDF + AES-GCM). Only their browser can open it.
- Files shared by an assistant are sealed by the server, which then forgets the key.
- Code: [`public/sealed.js`](../public/sealed.js).

**Sign-in never sends your password** (based on [OPAQUE, RFC 9807](https://www.rfc-editor.org/rfc/rfc9807); [`public/opaque.js`](../public/opaque.js) lists where it differs)

- Your browser blinds the password before anything is sent. The server keeps a record it can check sign-ins against, but it never sees the password, can't learn it from the record, and can't test guesses against a stolen database without its own secret.
- Signing in also produces an export key that only your browser has. It locks your account's private key, which the server stores without being able to use.
- Older accounts send their password one last time when they next sign in, switch over, and the password hash is deleted.
- Deleting your account takes a fresh proof of the password, made the same way.
- New passwords need at least 10 characters and can't be one of the most common ones.

**Uploads and sends that can't be tied to you** (Privacy Pass-style tokens, [`public/blindrsa.js`](../public/blindrsa.js))

- While you're signed in, your browser picks up a few tokens a day. The server signs them blinded ([RFC 9474](https://www.rfc-editor.org/rfc/rfc9474) blind RSA), so it never sees the token it signed.
- End-to-end uploads and sends spend a token instead of your sign-in. The server can check the token is real and unspent, but it can't tell which account it gave it to. The daily limits (5 uploads, 60 sends) still hold.
- Tokens are picked up a while before they're used, so timing doesn't link them either.
- Your list of shares is kept on the server sealed to your own key (padded to 4 KB steps), so "Your shares" still works on every device.

**Nobody can swap someone's key unnoticed**

- Every account has a **security code** (account menu → Security code): 30 digits from its public key. Compare codes with the people you send to.
- Your browser remembers each person's key the first time you send to them. If the server ever hands out a different one, sending stops and you're told to compare codes.
- Accounts can't replace their key once it's set.

**Code the server can't change**

- Every script, pdf.js and mammoth included, is served from this site, and the Content-Security-Policy allows no others. mammoth is also pinned with an integrity hash.
- The desktop app, signed in to an account, runs the website's code from its own copy instead of downloading it, so a compromised server can't change the code that encrypts your files.

**Everything else**

- Links expire after 1 minute to 10 days. Expired files are erased.
- Files shared with end-to-end encryption turned off are still encrypted on the server, each with its own key.
- The self-hosted server checks file types by their contents and strips author and editing metadata from PDF and DOCX files.
- Pages send `noindex`, `no-store` and `frame-ancestors 'none'`. There are no analytics.
- Sessions are signed and expire after 30 days. Sign-in attempts are limited per username and per IP address, and IP addresses are only stored as a keyed hash.

## Tested by trying to break it

`npm test` includes attacks, each run against the real handlers with a throwaway database:

- **A stolen session** can't take over an older account (switching to the new sign-in needs the password), can't plant keys to receive someone's files (setting keys needs a sign-in from the last 10 minutes), and can't delete the account (that needs a fresh password proof).
- **Replayed or tampered sign-in proofs** are refused, and the password never appears in a request or the database.
- **Forged, reused or wrong-kind tokens** are refused, and the daily limits hold across tokens and signed-in uploads.
- **A malicious server** can't tag people with their own token key: the apps only accept the key pinned in their code, checked against the key itself.
- **Without the right key or passcode**, a stored file opens to nothing, and a box moved into another slot or changed in transit fails to open.
- **Crafted names** can't become HTML or script files, and **crafted paths** can't make the desktop app serve anything outside its own copy of the site.

## What's left

- **Anyone with the whole link** (and the passcode, if there is one) can open the file until it expires. For anything that matters, add a passcode, send it to a username, or turn on "Only people signed in".
- **The website itself is still served by the server.** In a browser, you trust the page you load. The desktop app doesn't have this problem.
- **The server knows who a file was sent to, and when.** It doesn't know who sent it.
- **Your IP address** is visible to the hosting provider and your network. Use Tor or a VPN if that matters.

## Removed

The experimental Unigroth zero-knowledge proofs are gone. The verifier spot-checked 32 of about 549 constraints and trusted a value the prover sent, so proofs could be forged without the secret, and each challenge was tied to a signed-in account. Privacy Pass-style tokens now do what it was meant to do, using a standard scheme (RFC 9474 blind RSA) that's checked against the RFC's own test vectors in `tests/`. The hash-to-curve step of sign-in is checked against RFC 9380's vectors the same way. These are this project's own implementations, not an audited library, so an outside review is still worth getting.

## Setting up the server

`TOKEN_ISSUER_KEY` (an RSA-2048 private key; make one with `npm run token-key`) turns on anonymous tokens. Without it, uploads and sends use the signed-in session instead. OPAQUE's keys come from `ENCRYPTION_KEY`, so they need nothing extra.

The same information for users is at [/security](https://sharesecure-du8.pages.dev/security) and [/privacy](https://sharesecure-du8.pages.dev/privacy).
