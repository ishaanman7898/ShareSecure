'use strict';
// MCP (Model Context Protocol) endpoint for the desktop app and self-hosted
// installs, so assistants like Claude Code and Codex can share files.
//
// The owner creates a personal token in the account menu; only its SHA-256 is
// kept. Because the server runs on the same computer as the assistant,
// share_file reads the file straight from its path, but only for requests made
// on this machine: nothing arriving through the public tunnel can read files.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { db } = require('./db');
const settings = require('./settings');
const { decryptString, getEncKey } = require('./utils');
const { purgeLink } = require('./purge');
const { storeFile } = require('./routes/files');

const router = express.Router();
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BYTES = 10 * 1024 * 1024;
const VERSION = require('../package.json').version;

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// ── personal token ───────────────────────────────────────────────────────────
function tokenStatus() {
  return { hasToken: Boolean(settings.get('mcpTokenHash')), createdAt: settings.get('mcpTokenCreatedAt') || null };
}

function createToken() {
  const token = 'ss_' + crypto.randomBytes(27).toString('base64url');
  settings.set('mcpTokenHash', sha256(token));
  settings.set('mcpTokenCreatedAt', new Date().toISOString());
  return token;
}

function revokeToken() {
  settings.set('mcpTokenHash', null);
  settings.set('mcpTokenCreatedAt', null);
}

function tokenOk(header) {
  const token = String(header || '').replace(/^Bearer\s+/i, '');
  const stored = settings.get('mcpTokenHash');
  if (!stored || !token.startsWith('ss_')) return false;
  const a = Buffer.from(sha256(token)), b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Requests through the public tunnel carry the tunnel's host name.
function fromThisComputer(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const addr = String(req.socket.remoteAddress || '');
  const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  return loopback && ['localhost', '127.0.0.1', '::1'].includes(host);
}

const baseUrl = () => process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

// ── tools ────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'share_file',
    description: 'Share a file from this computer through ShareSecure and get a private link that expires. Supports PDF, DOCX, PNG and JPG up to 10 MB. The link works for other people while ShareSecure is running.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file on this computer.' },
        expires_hours: { type: 'number', description: 'Hours until the link stops working, 1 to 240. Default 24.' },
        allow_download: { type: 'boolean', description: 'Let people who open the link download the file. Default false (view only).' },
        name: { type: 'string', description: 'Name shown to people who open the link. Defaults to the file name.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_shares',
    description: 'List files shared from this ShareSecure that are still live, with their links and time left.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'delete_share',
    description: 'Delete a shared file now, so its link stops working. Use the id from list_shares or share_file.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The share id.' } }, required: ['id'] },
  },
];

function callTool(name, args, req) {
  if (name === 'share_file') {
    if (!fromThisComputer(req)) return { error: 'This ShareSecure runs on the user’s own computer, so files can only be shared by path from there. Ask them to upload it in the ShareSecure app, then call list_shares to get the link.' };
    const filePath = path.resolve(String(args.path || ''));
    let stat;
    try { stat = fs.statSync(filePath); } catch { return { error: `No file at ${filePath}` }; }
    if (!stat.isFile()) return { error: `${filePath} isn't a file.` };
    if (stat.size > MAX_BYTES) return { error: 'That file is over 10 MB.' };

    const buffer = fs.readFileSync(filePath);
    const stored = storeFile(
      { buffer, originalname: path.basename(filePath), size: buffer.length },
      {
        expires_hours: String(Math.min(Math.max(Number(args.expires_hours) || 24, 1), 240)),
        allow_download: args.allow_download ? '1' : '0',
        allow_annotations: '0',
        display_name: args.name ? String(args.name) : '',
      }
    );
    if (stored.error) return { error: stored.error };
    return {
      text: [
        `Shared ${path.basename(filePath)}.`,
        `Link: ${baseUrl()}/r/${stored.shortId}`,
        `Expires: ${stored.expires_at}`,
        `Id: ${stored.shortId}`,
      ].join('\n'),
    };
  }

  if (name === 'list_shares') {
    const rows = db.prepare(`
      SELECT short_id, original_filename, expires_at FROM files
      WHERE is_active = 1 AND inbox_status IS NULL AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY uploaded_at DESC LIMIT 50
    `).all(new Date().toISOString());
    if (!rows.length) return { text: 'No live shares.' };
    const key = getEncKey();
    return {
      text: rows.map(r => {
        let fname = r.original_filename;
        try { fname = decryptString(r.original_filename, key); } catch {}
        return `- ${fname} — ${baseUrl()}/r/${r.short_id} (id ${r.short_id}, expires ${r.expires_at})`;
      }).join('\n'),
    };
  }

  if (name === 'delete_share') {
    const id = String(args.id || '');
    const file = db.prepare('SELECT short_id, cluster_id FROM files WHERE short_id = ?').get(id);
    if (!file) return { error: `No share with id ${id}.` };
    purgeLink(file);
    return { text: `Deleted ${id}. Its link, and every link shared from it, no longer work.` };
  }

  return { error: `Unknown tool ${name}` };
}

function handleMessage(msg, req) {
  const { id, method, params = {} } = msg || {};
  if (id === undefined || id === null) return null; // notification
  const reply = result => ({ jsonrpc: '2.0', id, result });

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'sharesecure', version: VERSION },
        instructions: 'ShareSecure shares files through private links that expire. Use share_file with a file path, then give the user the link.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      try {
        const out = callTool(params.name, params.arguments || {}, req);
        return reply(out.error
          ? { content: [{ type: 'text', text: out.error }], isError: true }
          : { content: [{ type: 'text', text: out.text }] });
      } catch (err) {
        return reply({ content: [{ type: 'text', text: `Something went wrong: ${err.message}` }], isError: true });
      }
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// pathToken: apps like Claude and ChatGPT only take a URL when adding a
// connector, so their connector URL carries the token (/connect/<token>).
function handle(req, res, pathToken = null) {
  if (req.method !== 'POST') {
    return res.status(405).set('Allow', 'POST').send('ShareSecure MCP endpoint. Connect with an MCP client using POST.');
  }
  if (!tokenOk(pathToken ? `Bearer ${pathToken}` : req.headers.authorization)) {
    return res.status(401).set('WWW-Authenticate', 'Bearer').json({
      jsonrpc: '2.0', id: null,
      error: { code: -32001, message: 'Missing or invalid ShareSecure token. Create one in the account menu under Connect an AI assistant.' },
    });
  }
  const body = req.body;
  const out = Array.isArray(body) ? body.map(m => handleMessage(m, req)).filter(Boolean) : handleMessage(body, req);
  if (!out || (Array.isArray(out) && !out.length)) return res.status(202).end();
  res.json(out);
}

router.all('/', express.json({ limit: '1mb' }), (req, res) => handle(req, res));

// /connect/<token>: the connector URL for apps that only accept a URL
const connectRouter = express.Router();
connectRouter.all('/:token', express.json({ limit: '1mb' }), (req, res) => handle(req, res, req.params.token));

module.exports = { router, connectRouter, tokenStatus, createToken, revokeToken };
