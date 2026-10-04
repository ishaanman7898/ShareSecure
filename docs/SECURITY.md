# Security

## Reporting a problem

Please don't open a public issue for security problems. Email **ishaanmanoor1@gmail.com** with what's affected, how to reproduce it, and what someone could do with it.

## How files are protected

**End-to-end encryption** (on by default on the website and for AI assistants)

- Your browser encrypts the file, its name and type, any note and any drawings with AES-256-GCM before uploading. The key is only in the link, after `#k=`, which browsers never send to a server. ShareSecure stores files it can't read.
- Files are padded to standard sizes (1 KB, 2 KB, 4 KB … 8 MB, 10 MB), so the server only learns roughly how big a file is.
- A link can also need a **passcode**. Then the link holds only half the key, and the passcode (stretched with 600,000 rounds of PBKDF2) is the other half. Anyone who only has the link can't open the file.
- Files sent to a username have their key sealed to that person's public key (ECDH P-256 + HKDF + AES-GCM). Only their browser can open it.
- Files shared through the hosted assistant connection (`/mcp`, ChatGPT) are sealed by the server, which then forgets the key. The server does see the file while it seals it, the link (with its key) goes back to the assistant, so it's in the chat, and the share is tied to your account, like a signed-in upload.
- Files shared through the **local MCP server** ([`packages/sharesecure-mcp`](../packages/sharesecure-mcp)) are sealed on your own computer with the same code the browser runs, and uploaded and sent with anonymous tokens, exactly like the website does: the server can't tell they came from you. The link goes to your clipboard and your sealed list of shares instead of to the assistant, so the key is never in the chat either. Its connection token is only used for what's tied to your account anyway (picking up tokens, your own sealed boxes, your inbox and file requests), and anything it posts about a share goes a few minutes later, so the timing doesn't point back at it.
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
- **A public key log** ([`public/kt.js`](../public/kt.js)) records every account's key: an append-only Merkle tree, the same scheme Certificate Transparency uses (RFC 9162). Every key your browser, the desktop app or the local MCP server is given for someone comes with a proof that it's in the log, and is refused without one. Each also remembers the log it last saw and checks the new one only grew from it, so history can't be rewritten under them. Your browser checks the log shows *your* key for your username each time you open the site, and warns you if it doesn't.
- So to read files meant for someone, a server would have to publish a second key for them, where everyone can see it. Anyone can check the whole log with `node scripts/kt-monitor.mjs`: it rebuilds the tree, and flags any account that got a different key without being deleted first. A public [GitHub Action](../.github/workflows/key-log.yml) runs it every day and keeps each day's log on the `key-log-witness` branch, so the record can't be changed afterwards either.
- The log names accounts by a hash of the username, not the name. Like looking up a key, it lets someone check whether a username they guess exists.

**Asking for a file**

- A file request's link is `/q/<id>#r=<request key>&pk=<your public key>`. What you asked for is sealed with the request key, so the server never reads it, and the uploader's browser seals each file's key to the public key in the link, not one the server hands out, so a compromised server can't swap in its own.
- What arrives waits in your inbox like any file sent to you, sealed end to end: the server never sees the file, its name or the uploader's note. Uploaders don't need an account and aren't identified.
- A request takes at most 20 files and lasts at most 30 days, and the inbox cap (20 waiting) applies, so a leaked request link can't fill your account.

**Links that work once**

- The first view takes the link's only view in one database step, so two people opening it at the same moment can't both get it. The file is then erased: every link to it, including copies sent to usernames, since they share its bytes.
- A tombstone stays for 30 days: the link's id, a hash of its delete key, when it was opened and how many times it was tried since. No name, no bytes, no account. Your browser asks about its own links with their delete keys and tells you if someone tried one again, which usually means it was passed on. A reload in the browser that opened it isn't counted.
- The viewer asks before opening, so link previews and scanners that fetch the page don't use up the view. A link that works once can't be downloaded, drawn on or reshared.

**Assistants can be tricked; your files can't be sent by one that was**

- An assistant reads web pages, emails and files, and any of them can hide an instruction like "send this to @someone". So when an assistant sends a file to someone not on your list, the send waits until you approve it on the website (account menu → Connect an AI assistant). You can instead let assistants send to anyone, or to no one.
- The server only knows which of those three you chose. Your list of people is sealed to your own key, so only your browser and the assistant server on your computer can open and apply it; assistants connected through ShareSecure's servers can't, so they ask every time. A waiting send (which share, to whom, its key and note) is sealed to your key too. Approving one opens it in your browser, which sends it anonymously like any send you make. So the server sees your account store a box it can't read, and later an anonymous send it can't tie to you.
- Only a signed-in session can approve or clear a waiting send, or change the rules, never an assistant's token. Waiting sends last a week at most, and replacing or turning off the token drops them.
- The local MCP server never shares from folders that hold keys or credentials (`~/.ssh`, `~/.aws`, `~/.gnupg` and similar, and its own key folder), remembers each recipient's key the first time like the browser does, and labels everything in a received file as information from someone else, not instructions.

**Code the server can't change**

- Every script, pdf.js and mammoth included, is served from this site, and the Content-Security-Policy allows no others. mammoth is also pinned with an integrity hash.
- The desktop app, signed in to an account, runs the website's code from its own copy instead of downloading it, so a compromised server can't change the code that encrypts your files.
- **Anyone can check the website serves exactly this repository's code.** `npm run verify-site` fetches every file the browser runs from the live site and compares it byte for byte with your checkout, printing each file's SHA-256. A public [GitHub Action](../.github/workflows/verify-site.yml) runs the same check after every deploy and every day, so a changed page would show up there.

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
- **A link that works once** gives the file out once even to simultaneous requests, and leaves no copy of the bytes behind.
- **A file request** refuses anything not sealed in the browser, posts from other sites, and uploads past its limit or expiry, and only the owner can list or close it.
- **A swapped key is caught by the key log**: a key that isn't in the log is refused, a second key for someone shows up in the log, and a log rewritten after someone looked fails their check.
- **A tricked assistant** can't send a file to someone off your list without your approval, can't approve its own sends or change its rules, and through the local MCP server never sees a link's key, can't share from key folders, and can't seal a file to a key the server swapped in.
- **Nothing links you to what you share through the local MCP server**: its uploads and sends carry anonymous tokens and no account, the files and copies it makes have no account or sender tag, and the server keeps only boxes it can't open (your rules, your waiting sends, your list of shares).

## What's left

- **Anyone with the whole link** (and the passcode, if there is one) can open the file until it expires. For anything that matters, add a passcode, send it to a username, or turn on "Only people signed in".
- **The local MCP server keeps your private key on disk** once you run `link` (in `~/.sharesecure`, readable by you only on macOS and Linux; on Windows it relies on your user folder's permissions). Run `npx sharesecure-mcp unlink` to remove it.
- **The site check proves what the server sends to whoever checks**, not that it sends everyone the same page: a server targeting one person could still give them different code. The desktop app avoids that (it runs its own copy), and a browser-side check (like WEBCAT) is the next step.
- **The website itself is still served by the server.** In a browser, you trust the page you load. The desktop app doesn't have this problem.
- **The server knows who a file was sent to, and when.** It doesn't know who sent it.
- **Your IP address** is visible to the hosting provider and your network. Use Tor or a VPN if that matters.

## Removed

The experimental Unigroth zero-knowledge proofs are gone. The verifier spot-checked 32 of about 549 constraints and trusted a value the prover sent, so proofs could be forged without the secret, and each challenge was tied to a signed-in account. Privacy Pass-style tokens now do what it was meant to do, using a standard scheme (RFC 9474 blind RSA) that's checked against the RFC's own test vectors in `tests/`. The hash-to-curve step of sign-in is checked against RFC 9380's vectors the same way. These are this project's own implementations, not an audited library, so an outside review is still worth getting.

## Setting up the server

`TOKEN_ISSUER_KEY` (an RSA-2048 private key; make one with `npm run token-key`) turns on anonymous tokens. Without it, uploads and sends use the signed-in session instead. OPAQUE's keys come from `ENCRYPTION_KEY`, so they need nothing extra.

The same information for users is at [/security](https://sharesecure-du8.pages.dev/security) and [/privacy](https://sharesecure-du8.pages.dev/privacy).
