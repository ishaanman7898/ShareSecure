// MCP (Model Context Protocol) server for the hosted site, so assistants like
// Claude Code and Codex can share files for the signed-in user.
//
// Auth is a personal token the user creates in the account menu; only its
// SHA-256 is stored. Assistants can't paste megabytes of base64, so share_file
// returns a one-time upload command (curl -F file=@path) that the assistant runs
// in its own shell; the upload's response contains the link. Uploads go through
// the normal upload endpoint, so the 5-a-day limit and encryption all apply.

import { getAuthClient, getFilesClient, getUserTag, signToken, sha256, getEncKey, decryptStr, migrateOnce } from './_turso.js';
import { onRequestPost as uploadHandler } from './api/upload.js';
import { onRequestPost as sendHandler } from './api/send/[shortId].js';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const TICKET_TTL_MS = 10 * 60 * 1000;
const ALLOWED = /\.(pdf|docx|png|jpe?g)$/i;

function randomToken(bytes = 30) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => chars[b % chars.length]).join('');
}

async function ensureTables(env) {
  await migrateOnce('mcp', getAuthClient(env), [
    `CREATE TABLE IF NOT EXISTS api_tokens (
       user_id    INTEGER PRIMARY KEY,
       token_hash TEXT UNIQUE NOT NULL,
       created_at TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS mcp_tickets (
       ticket_hash TEXT PRIMARY KEY,
       user_id     INTEGER NOT NULL,
       options     TEXT NOT NULL,
       expires_at  TEXT NOT NULL
     )`,
  ]);
}

// ── personal tokens ──────────────────────────────────────────────────────────
export async function tokenStatus(userId, env) {
  await ensureTables(env);
  const row = (await getAuthClient(env).execute({ sql: 'SELECT created_at FROM api_tokens WHERE user_id = ?', args: [userId] })).rows[0];
  return { hasToken: Boolean(row), createdAt: row?.created_at || null };
}

// Creating a token replaces the old one, so a leaked token can be cut off.
export async function createToken(userId, env) {
  await ensureTables(env);
  const token = 'ss_' + randomToken(36);
  await getAuthClient(env).execute({
    sql: 'INSERT OR REPLACE INTO api_tokens (user_id, token_hash, created_at) VALUES (?, ?, ?)',
    args: [userId, await sha256(token), new Date().toISOString()]
  });
  return token;
}

export async function revokeToken(userId, env) {
  await ensureTables(env);
  await getAuthClient(env).execute({ sql: 'DELETE FROM api_tokens WHERE user_id = ?', args: [userId] });
}

// "Bearer ss_…" → { userId, username } or null
async function userForToken(header, env) {
  const token = (header || '').replace(/^Bearer\s+/i, '');
  if (!token.startsWith('ss_')) return null;
  await ensureTables(env);
  const db = getAuthClient(env);
  const row = (await db.execute({ sql: 'SELECT user_id FROM api_tokens WHERE token_hash = ?', args: [await sha256(token)] })).rows[0];
  if (!row) return null;
  const user = (await db.execute({ sql: 'SELECT id, username FROM users WHERE id = ?', args: [row.user_id] })).rows[0];
  return user ? { userId: Number(user.id), username: user.username } : null;
}

// A normal session token for the user, so MCP calls reuse the regular endpoints.
async function sessionHeader(user, env) {
  const token = await signToken({ username: user.username, userId: user.userId, iat: Math.floor(Date.now() / 1000) }, env);
  return `Bearer ${token}`;
}

// ── uploads ──────────────────────────────────────────────────────────────────
// Hand a regular endpoint a new request; waitUntil must stay bound to the real context.
function withRequest(context, request, params = {}) {
  return { request, env: context.env, params, waitUntil: p => context.waitUntil(p) };
}

async function upload(user, file, opts, context) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('expires_hours', String(opts.expires_hours));
  fd.append('allow_download', opts.allow_download ? '1' : '0');
  fd.append('allow_annotations', '0');
  if (opts.name) fd.append('display_name', opts.name);
  const request = new Request(new URL('/api/upload', context.request.url), {
    method: 'POST',
    headers: { Authorization: await sessionHeader(user, context.env) },
    body: fd,
  });
  const res = await uploadHandler(withRequest(context, request));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: data.error || `Upload failed (${res.status})` };

  const result = { url: data.shortUrl, name: opts.name || data.filename, expires_at: data.expiresAt, id: data.shortId };
  // each recipient gets their own copy as a request they accept or decline
  const recipients = toRecipients(opts.send_to);
  if (recipients.length) {
    const auth = await sessionHeader(user, context.env);
    result.sent_to = [];
    result.not_sent = [];
    for (const username of recipients) {
      const sendReq = new Request(new URL(`/api/send/${data.shortId}`, context.request.url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ targetUsername: username }),
      });
      const sent = await (await sendHandler(withRequest(context, sendReq, { shortId: data.shortId }))).json().catch(() => ({}));
      if (sent.sent) result.sent_to.push(username);
      else result.not_sent.push({ username, reason: sent.error === 'User not found' ? 'No user with that name' : (sent.error || 'Couldn’t send it') });
    }
  }
  return result;
}

// "alice, bob", "@alice bob" or ["alice", "bob"] → ["alice", "bob"], at most 20
function toRecipients(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/);
  return [...new Set(list.map(u => String(u).trim().replace(/^@/, '')).filter(Boolean))].slice(0, 20);
}

// POST /api/mcp/upload/:ticket (multipart, field "file"): the command share_file hands out.
export async function redeemTicket(ticket, context) {
  const { env, request } = context;
  await ensureTables(env);
  const db = getAuthClient(env);
  const hash = await sha256(ticket);
  const row = (await db.execute({ sql: 'SELECT user_id, options, expires_at FROM mcp_tickets WHERE ticket_hash = ?', args: [hash] })).rows[0];
  if (row) await db.execute({ sql: 'DELETE FROM mcp_tickets WHERE ticket_hash = ?', args: [hash] });
  if (!row || new Date(row.expires_at) < new Date()) {
    return Response.json({ error: 'This upload command has expired or was already used. Ask for a new one.' }, { status: 410 });
  }
  const user = (await db.execute({ sql: 'SELECT id, username FROM users WHERE id = ?', args: [row.user_id] })).rows[0];
  if (!user) return Response.json({ error: 'Account not found' }, { status: 404 });

  let form;
  try { form = await request.formData(); } catch { return Response.json({ error: 'Send the file as multipart form data in a field named "file".' }, { status: 400 }); }
  const file = form.get('file');
  if (!file || typeof file === 'string') return Response.json({ error: 'No file in the "file" field.' }, { status: 400 });
  if (!ALLOWED.test(file.name || '')) return Response.json({ error: 'Only PDF, DOCX, PNG and JPG files can be shared.' }, { status: 415 });

  const result = await upload({ userId: Number(user.id), username: user.username }, file, JSON.parse(row.options), context);
  if (result.error) return Response.json(result, { status: 400 });
  return Response.json(result);
}

// ── tools ────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'share_file',
    description: 'Share a file from this computer through ShareSecure and get a private link that expires. Returns a one-time upload command: run it in a shell and its output contains the link. Supports PDF, DOCX, PNG and JPG up to 10 MB. Counts toward the 5 uploads a day limit.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file on this computer.' },
        expires_hours: { type: 'number', description: 'Hours until the link stops working, 1 to 240. Default 24.' },
        allow_download: { type: 'boolean', description: 'Let people who open the link download the file. Default false (view only).' },
        name: { type: 'string', description: 'Name shown to people who open the link. Defaults to the file name.' },
        send_to: { type: 'array', items: { type: 'string' }, description: 'ShareSecure usernames to send the file to, e.g. ["alice", "bob"]. Each gets their own copy to accept or decline. Up to 20.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_shares',
    description: 'List files shared from this ShareSecure account that are still live, with their links and time left. Private uploads made in the browser the account was created in are not listed.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'delete_share',
    description: 'Delete a shared file now, so its link stops working. Use the id from list_shares or share_file.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The share id.' } }, required: ['id'] },
  },
];

const shellQuote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

async function callTool(name, args, user, context) {
  const { env, request } = context;
  if (name === 'share_file') {
    const path = String(args.path || '');
    if (!path) return { error: 'path is required' };
    if (!ALLOWED.test(path)) return { error: 'Only PDF, DOCX, PNG and JPG files can be shared.' };
    const opts = {
      expires_hours: Math.min(Math.max(Number(args.expires_hours) || 24, 1), 240),
      allow_download: Boolean(args.allow_download),
      name: args.name ? String(args.name).slice(0, 200) : null,
      send_to: toRecipients(args.send_to),
    };
    const ticket = randomToken(32);
    await getAuthClient(env).execute({
      sql: 'INSERT INTO mcp_tickets (ticket_hash, user_id, options, expires_at) VALUES (?, ?, ?, ?)',
      args: [await sha256(ticket), user.userId, JSON.stringify(opts), new Date(Date.now() + TICKET_TTL_MS).toISOString()]
    });
    const url = new URL(`/api/mcp/upload/${ticket}`, request.url).href;
    return {
      text: [
        `Run this command to upload ${path} (it works once, within 10 minutes):`,
        '',
        `curl -fsS -F ${shellQuote('file=@' + path)} ${url}`,
        '',
        `It prints JSON: "url" is the share link and "expires_at" is when it stops working.${opts.send_to.length ? ` "sent_to" lists who it was sent to (${opts.send_to.join(', ')}), and "not_sent" lists anyone it couldn't reach and why.` : ''}`,
        'On Windows PowerShell, use curl.exe instead of curl.',
      ].join('\n'),
    };
  }

  if (name === 'list_shares') {
    const tag = await getUserTag(user.userId, env);
    const rows = (await getFilesClient(env).execute({
      sql: `SELECT short_id, original_filename, expires_at FROM files
            WHERE is_active = 1 AND (user_tag = ? OR (user_tag IS NULL AND user_id = ?))
              AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            ORDER BY uploaded_at DESC LIMIT 50`,
      args: [tag, user.userId]
    })).rows;
    if (!rows.length) return { text: 'No live shares.' };
    const key = await getEncKey(env);
    const base = new URL(request.url).origin;
    const lines = await Promise.all(rows.map(async r => {
      let fname = r.original_filename;
      try { fname = await decryptStr(r.original_filename, key, env, r.short_id); } catch {}
      return `- ${fname} — ${base}/r/${r.short_id} (id ${r.short_id}, expires ${r.expires_at})`;
    }));
    return { text: lines.join('\n') };
  }

  if (name === 'delete_share') {
    const id = String(args.id || '');
    const tag = await getUserTag(user.userId, env);
    const { rowsAffected } = await getFilesClient(env).execute({
      sql: 'DELETE FROM files WHERE short_id = ? AND (user_tag = ? OR (user_tag IS NULL AND user_id = ?))',
      args: [id, tag, user.userId]
    });
    return rowsAffected ? { text: `Deleted ${id}. Its link no longer works.` } : { error: `No share with id ${id} on this account.` };
  }

  return { error: `Unknown tool ${name}` };
}

// ── JSON-RPC over Streamable HTTP ────────────────────────────────────────────
async function handleMessage(msg, user, context) {
  const { id, method, params = {} } = msg || {};
  if (id === undefined || id === null) return null; // notification: nothing to answer
  const reply = result => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'sharesecure', version: '1.9.1' },
        instructions: 'ShareSecure shares files through private links that expire. Use share_file to share a file from this computer, then give the user the link.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      try {
        const out = await callTool(params.name, params.arguments || {}, user, context);
        return reply(out.error
          ? { content: [{ type: 'text', text: out.error }], isError: true }
          : { content: [{ type: 'text', text: out.text }] });
      } catch (err) {
        return reply({ content: [{ type: 'text', text: `Something went wrong: ${err.message}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

export async function handleMcp(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return new Response('ShareSecure MCP endpoint. Connect with an MCP client using POST.', { status: 405, headers: { Allow: 'POST' } });
  }
  const user = await userForToken(request.headers.get('Authorization'), env);
  if (!user) {
    return Response.json(
      { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Missing or invalid ShareSecure token. Create one in the account menu under Connect an AI assistant.' } },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } }
    );
  }
  let body;
  try { body = await request.json(); } catch {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400 });
  }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(m => handleMessage(m, user, context)))).filter(Boolean);
    return out.length ? Response.json(out) : new Response(null, { status: 202 });
  }
  const out = await handleMessage(body, user, context);
  return out ? Response.json(out) : new Response(null, { status: 202 });
}
