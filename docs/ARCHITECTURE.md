# How ShareSecure is built

A map of the whole project: what runs where, how a file travels, where each
feature lives, and the rules the code follows. Read this before changing
anything big. Security details are in [SECURITY.md](SECURITY.md), signing in
[SIGNING.md](SIGNING.md).

## The one rule

**Privacy first, unlinkable.** Nobody, ShareSecure's own servers included,
should be able to read a file or link who sent it, where from, and to whom.
Every feature is shaped by that:

- Files are encrypted in the browser by default; the key lives in the link
  after `#`, which browsers never send to a server.
- Uploads and sends spend anonymous tokens instead of the sign-in, so the
  server can enforce limits without knowing whose upload it is.
- Notifications, logs and lists never name a file or a person unless they
  have to.
- No third-party scripts or fonts (fonts are in `public/fonts/`), no analytics. pdf.js and
  mammoth are vendored in `public/vendor/`.

If a change would let the server (or the relay, or Cloudflare) learn more,
it needs a very good reason.

## Three editions, one browser app

| Edition | Backend | Database | Where files live |
|---|---|---|---|
| **Website** (`sharesecure-du8.pages.dev`) | Cloudflare Pages Functions (`functions/`) | Turso (libSQL over HTTP) | Turso rows, encrypted |
| **Desktop app** (Electron, `desktop/`) | Express server (`server/`) in its own process | SQLite (better-sqlite3) | the user's app-data folder, encrypted |
| **Self-hosted** (install script / Docker) | same Express server | same SQLite | same |

`public/` is the browser app for **all three**. It works out which edition
it's in by calling `GET /api/mode`: only the Express server answers
(`selfHostMode: true`), the website 404s. In the code, `selfHostMode` (in
`public/app.js`) means "desktop or self-hosted". The desktop app is
recognised by `window.shareSecureDesktop` (from `desktop/preload.js`) and by
`ShareSecureDesktop/<version>` in the user agent (CSS class `is-desktop`).

Shared modules in `public/` run in the browser, on Cloudflare **and** in Node
20+ (the Express server and the MCP package `import()` them), so they use only
WebCrypto and no dependencies:

| Module | What it is |
|---|---|
| `sealed.js` | End-to-end encryption: file keys, padding, `lockFile`/`unlockFile`, `lockMeta`, sealing keys to public keys (ECDH P-256), passcodes, links (`linkWithKey`, `readLink`) |
| `opaque.js` | Password sign-in where the server never sees the password (OPAQUE-3DH, RFC 9807). Its export key unlocks the account's private key |
| `blindrsa.js`, `tokens.js` | Anonymous tokens (blind RSA, RFC 9474) and the browser's wallet of them |
| `kt.js` | The public key log (Merkle tree, like Certificate Transparency) |
| `keys.js` | Your keys in this browser (IndexedDB `sharesecure` / store `keys` / key `me`), contacts and their key changes |
| `filetypes.js` | Which files are accepted, from their bytes |
| `zip.js` | Minimal ZIP: detect Office files, open bundles, pack folders |
| `mcp-common.js` | What the three MCP servers share |
| `protect.js` | Watermark and screenshot deterrents in the viewer |
| `vault.js` | "Your shares", sealed to your own key on the server (website) |

## Directory map

```
public/        the browser app (all editions) + shared crypto/format modules
  index.html     home: upload form, Your shares, inbox, Settings (/#settings), every dialog
  app.js         everything on index.html (~2900 lines, sectioned by "// ── … ──" headers)
  viewer.html/js the file viewer at /r/<id> (pdf, images, docx, text, media, ZIPs, annotations)
  signin.*       sign in / sign up (website) and owner setup/sign-in (desktop)
  request.*      a file request's upload page /q/<id>
  drop.*         an assistant's upload page /drop/<ticket>
  expired.html, burned.html, 404.html   where gone links land ("Back to home")
  changelog.html every release, newest first (the latest has class "latest")
functions/     website API (Cloudflare Pages Functions). _*.js are shared helpers
  _middleware.js CSP and headers for every response
  _turso.js      DB client over fetch, sessions, encryption helpers, link rules
  _auth.js       OPAQUE server side + rate limits
  _tokens.js     anonymous token issuing/spending, and DAILY: the one set of daily limits (everything is free, no plans)
  _kt.js         key log storage
  _mcp.js        the website's MCP server (/mcp)
  _requests.js   file requests;  _burn.js links that work once
  _agent.js      what an assistant may send without asking
  api/…          one file per endpoint group
  l/[[path]].js  /l/<computer>/r/<id>: serves the viewer for links to a desktop app
server/        Express server for desktop + self-hosted
  index.js       app setup, /api/mode, /r/:id, cleanup sweep, relay start
  db.js          SQLite schema + migrations; data dir per OS
  routes/files.js   upload, info, raw, download, reshare, delete, annotations
  routes/cloud.js   the linked website account: send to usernames, inbox sync
  routes/inbox.js   files sent to the owner
  routes/auth.js    the single owner account
  relay.js       this computer's end of the relay
  mcp.js         local MCP server
  purge.js       erasing expired/deleted files (shred + secure_delete)
  events.js      expired/opened/received events for desktop notifications
  updater.js, launcher.js   self-hosted self-update
  settings.js    settings.json next to the DB (secrets encrypted)
desktop/       Electron
  main.js        windows, tray, updates, notifications, saved sign-in
  server-process.js  the Express server, forked as its own process (outlives the app)
  preload.js     window.shareSecureDesktop: updates, protection, notifications, signIn, convert
  convert.js     converting a file before it's shared (FFmpeg + HEIC), on this computer only
relay/         Cloudflare Worker + Durable Object that carries desktop links
packages/sharesecure-mcp/   local stdio MCP server (npm package)
scripts/       verify-site.mjs (live site == this repo), kt-monitor.mjs (audit key log)
tests/         node:test suites: hosted-security (website), self-hosted,
               desktop-send (the desktop's sends against the website's handlers)
db/            reference schemas (the code creates tables itself)
docs/          this file, SECURITY.md, SIGNING.md
```

## How a share travels

### Website, always end to end

1. `app.js` `buildUploadForm()`: detect type from bytes, make a random file
   key (`newFileKey`), optional passcode (`passcodeKey`), `lockFile` (padded)
   and `lockMeta` (name, type, watermark/discourage). Seal the key to your own
   public key (`owner_key`) so it shows in Your shares on other devices.
2. Upload to `/api/upload`, spending an anonymous upload token
   (`X-ShareSecure-Token`), never the sign-in: `anonToken()` in tokens.js
   tops the wallet up first if it's empty. Deletes send only the delete key.
3. The link is `https://<site>/r/<id>#k=<key>`. `#f=<key>` is a full key (sent
   copies, never need the passcode).
4. The viewer (`viewer.js`) reads the key from `location.hash`, fetches
   `/api/info/<id>` and `/api/raw/<id>`, and decrypts in the browser.
5. Someone who isn't the owner gets a fresh link of their own first
   (`/api/reshare`), so each person's link can be revoked (a branch).
   Deleting a link deletes its branch; deleting the original deletes all.

### Desktop / self-hosted

- Every share is locked end to end in the page (there's no toggle): the
  relay must only ever carry locked bytes.
- `server/routes/files.js` `storeFile()` stores the locked box, compressed
  and encrypted again with a per-file key wrapped by `ENCRYPTION_KEY`.
- Expiry can be anything from a minute to "never" (`expires_hours=never` →
  `expires_at = NULL`; `NULL` means never everywhere in the server).
- The page asks `/api/mode` for `publicUrl` and builds links as
  `https://<site>/l/<computerId>/r/<id>#k=<key>` (`shareUrl()` in app.js).

### The relay (links to a desktop app)

```
phone ──> sharesecure-du8.pages.dev/l/<computer>/r/<id>   (viewer.html, from the website)
   viewer JS ──> sharesecure-relay.ishman.workers.dev/c/<computer>/api/...
                     │  (Durable Object holds one WebSocket per computer)
                     ▼
              desktop server/relay.js ──> http://127.0.0.1:<port>/api/... (X-ShareSecure-Relay: 1)
```

- The computer's id is a hash of its own P-256 key (`relay.identity()`,
  kept in settings.json); it proves it holds the key when it connects.
- `relay.js` `ALLOWED` lists the only paths that may come through (viewer
  calls + MCP). `files.js` refuses non-e2e rows for relayed requests.
- The viewer knows it's a relay link from the `/l/<computer>/` path prefix
  (`api()` and `pagePrefix` in viewer.js). The website's CSP for `/l/` pages
  allows `connect-src` to the relay.
- The relay is deployed by hand: `npx wrangler deploy --config relay/wrangler.toml`
  (that file is local and gitignored). Pushing to main does **not** deploy it.

### Sending to a username

- Website: the file key is sealed to the recipient's public key (checked
  against the key log, `kt.js`) in the browser, sent with an anonymous send
  token. It lands in their inbox as a request to accept or decline.
- Desktop: the page hands the key to the local server (`file_key`), which
  uploads a copy to the website with the linked account and seals it there
  (`routes/cloud.js` `sendToCloud`). That copy lives at most 10 days.

### File requests, burn-after-reading

- **File requests** (`_requests.js`, `request.js`): `/q/<id>#r=<request key>&pk=<public key>`.
  The uploader's browser seals to the public key in the link.
- **Burn** (`_burn.js`): website only; the first open erases the file and a
  tombstone remembers later tries so the owner can be warned.

## The desktop app

- `desktop/main.js` starts `server-process.js` with the Electron binary as
  Node (`ELECTRON_RUN_AS_NODE`), detached, on a fixed port (port.json, so the
  page's localStorage origin stays the same). It **outlives the app**: links
  keep working after quitting until the last one expires, then it exits.
- The window loads `http://localhost:<port>`. Share links opened inside the
  app are mapped back to localhost (`inApp()`); other URLs open in the browser.
- IPC with the server process (`process.send`): `stop`, `live?`,
  `reset-password`, and from the server `notify` events.
- **Notifications** (`server/events.js` → server-process → `main.js`
  `notifyFromServer`): expired, opened (via relay), received, updates.
  Preferences and one-time flags in `notifications.json` in userData.
  Only while the app runs (the bare server process can't show any).
- **Linked account**: signing in to the desktop app auto-creates/links a
  website account with the same username and password (`/api/cloud/auto`),
  unless the user chose another or unlinked. The token, username and the
  account's private key are kept encrypted in settings.json.
- **Only this computer**: main.js starts the server with `HOST=127.0.0.1`, so
  it listens on loopback only (links arrive through the relay), and
  `server/index.js` then refuses any Host but localhost or `relay.sharesecure`
  (DNS rebinding). Electron's permissions are limited to clipboard writes,
  fullscreen and notifications, and windows only ever show the app's own
  pages or its update page.
- **Converting** (`desktop/convert.js`): picking a file ShareSecure can't take
  (HEIC, MKV, FLAC, TIFF…) or one that's too big offers to convert it first;
  any other image, video or audio file gets an optional "Convert it first?".
  FFmpeg (`ffmpeg-static`) and `heic-convert` run in the main process, with
  metadata stripped. They're `optionalDependencies`, so self-hosted installs
  (`--omit=optional`) skip the 80 MB binary. `scripts/ffmpeg-arch.cjs`
  (afterPack) swaps in the right FFmpeg when a build targets another
  processor (Intel Macs); add a pinned sha256 there for any new one.
- Data folder: `%APPDATA%\ShareSecure` (dev runs use `ShareSecure-dev`).
  Server log: `server.log` there.

## Releasing

When the user says **"push"**, do the whole release:

1. Run `npm test` (every suite must pass).
2. Bump `package.json` (`npm version X.Y.Z --no-git-tag-version`): minor for
   features, patch for fixes.
3. Add a `<section class="release latest">` entry at the top of
   `public/changelog.html` and remove `latest` + the badge from the previous one.
4. Commit (one-line message, no AI attribution), push `main`, push tag
   `vX.Y.Z`, `gh release create vX.Y.Z --title vX.Y.Z --notes "…"`.
5. Pushing `main` deploys the website (Cloudflare Pages git integration).
   The tag builds desktop installers (`.github/workflows/desktop.yml`) and
   attaches them; installed apps auto-update from the latest release.
6. If `relay/` changed, deploy it by hand (see above).

`verify-site` (CI on every push) checks the live site serves exactly this
repo's `public/`, so never hand-edit production.

## Testing and running

```bash
npm test                 # all suites; tests/*.test.cjs
npm start                # Express server on :3000 (from a copy without .git! see below)
npm run desktop          # dev Electron (data in ShareSecure-dev)
```

Gotchas:

- Don't run the self-hosted server from the repo itself on a real data dir:
  its updater treats a git checkout as an install. Use a copy or tests.
- better-sqlite3 has to be rebuilt for Electron (`npm run desktop` does it,
  `postdesktop` rebuilds it back for Node). Electron is pinned to 43.
- Windows builds need `ELECTRON_BUILDER_7Z_FILTER=BCJ` (the user's PC is
  Windows on ARM64; the installer is x64+arm64 in one).
- Cloudflare Functions get ~10 ms CPU per request: no per-byte JS loops in
  `functions/`.
- On Windows, `import()` of an absolute path needs `pathToFileURL(...).href`.

## Code style

- Comments say **why**, in plain sentences, at the top of each module and
  above anything non-obvious. Match the density of the file you're in.
- UI copy is short, plain, second person, with curly quotes and apostrophes
  (’ “ ”). No jargon in the UI ("locked", not "AES-GCM").
- No frameworks, no build step for `public/`. ES modules in the browser,
  CommonJS in `server/` and `desktop/`.
- New server tables/columns go through the existing migration helpers
  (`migrateOnce` on the website, `db.js` on the server).
