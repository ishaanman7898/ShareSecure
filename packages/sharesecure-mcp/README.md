# sharesecure-mcp

A local [MCP](https://modelcontextprotocol.io) server for [ShareSecure](https://sharesecure-du8.pages.dev). Your assistant (Claude Code, Codex, Cursor, any MCP client) shares, sends and receives files, and the encryption happens on your computer:

- **The server only gets sealed boxes.** Files, names, notes and keys are encrypted here with the same code the website runs (AES-256-GCM, keys sealed with ECDH P-256). ShareSecure's `/api/agent` endpoints refuse anything that isn't.
- **The assistant never sees a key.** A share's link holds its key, so it goes to your clipboard and to *Your shares* on the website, not into the chat. An assistant tricked by something it read can make a share, but can't hand anyone the link.
- **Sends to someone new wait for you.** The first time an assistant sends to a person, it waits on the website until you approve it.
- **Swapped keys are caught.** Each person's key is remembered the first time, like the website does. If the server ever hands out a different one, nothing is sent.

## Set up

You need Node.js 20 or later and a connection token: on the ShareSecure website, open the account menu → **Connect an AI assistant** → **Create a connection token**.

```bash
# Claude Code
claude mcp add sharesecure-local --env SHARESECURE_TOKEN=ss_your_token -- npx -y sharesecure-mcp
```

For other clients, run `npx -y sharesecure-mcp` as a stdio server with `SHARESECURE_TOKEN` in its environment.

Then, once, in a terminal:

```bash
npx -y sharesecure-mcp link
```

It asks for your username and password, signs in without sending the password (OPAQUE), and keeps your account's private key in `~/.sharesecure`, readable by you only. That lets your assistant open files people send you and resend your shares. Sharing works without it.

| Command | |
|---|---|
| `npx sharesecure-mcp link` | Put your account's key on this computer |
| `npx sharesecure-mcp unlink` | Take it off again |
| `npx sharesecure-mcp status` | Which account this computer is linked to, and its security code |
| `npx sharesecure-mcp trust <username>` | Accept someone's new security code, after checking it with them |

## Tools

| Tool | |
|---|---|
| `share_file` | Share a file by path (PDF, DOCX, PNG, JPG, UTF-8 .txt/.md/.csv; up to 10 MB). Never from `~/.ssh`, `~/.aws`, `~/.gnupg` and other key folders. |
| `share_text` | Share text the assistant wrote as .md, .txt or .csv. |
| `send_share` | Send a live share to usernames by id. The key is opened and resealed here. |
| `list_shares`, `delete_share` | Your live shares. |
| `list_inbox` | Files people sent you, decrypted here. |
| `answer_request` | Accept or decline one. |
| `open_inbox_file` | Decrypt an accepted file and save it (to `Downloads/ShareSecure` by default); `include_text` returns a text file's contents too. |
| `security_code` | Your security code, and someone else's. |

Everything that came from someone else is labelled as information, not instructions.

## Settings

| Variable | |
|---|---|
| `SHARESECURE_TOKEN` | Your connection token. Required to run the server. |
| `SHARESECURE_URL` | The ShareSecure site. Default `https://sharesecure-du8.pages.dev`. |
| `SHARESECURE_LINKS` | `clipboard` (default) or `show`, to give links to the assistant. |
| `SHARESECURE_HOME` | Where the key and contacts are kept. Default `~/.sharesecure`. |

## Working on it

The encryption code is copied from the website's `public/` folder into `lib/` before publishing. From the repository, run `npm run vendor` here first. Tests live in the repository's `tests/` and run with `npm test` at its root.
