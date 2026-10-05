// What the three MCP servers have in common: the website's (functions/_mcp.js),
// the self-hosted one (server/mcp.js) and the local package
// (packages/sharesecure-mcp). Turning what an assistant hands over into a file,
// what to say when something fails, and the tool fields they all take.
import { magicOf, BINARY_EXT } from './filetypes.js';

export const MAX_BYTES = 10 * 1024 * 1024;
export const INLINE_MAX = 2 * 1024 * 1024;   // content_base64, decoded
export const CHUNK_SIZE = 512 * 1024;        // upload_chunk, decoded
export const TEXT_MAX = 200000;              // share_text, characters

// ── what assistants hand over ────────────────────────────────────────────────

// just the name: no folders, no characters file systems choke on
export const cleanName = name => String(name || '').split(/[\\/]/).pop().replace(/[\x00-\x1F\x7F<>:"|?*]/g, '').trim().slice(0, 150);

// "alice, bob", "@alice bob" or ["alice", "bob"] → ["alice", "bob"], at most 20
export const toRecipients = value => [...new Set((Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/))
  .map(u => String(u).trim().replace(/^@/, '')).filter(Boolean))].slice(0, 20);

const looksLikeHtml = bytes => /^\s*<(!doctype html|html|head|body)\b/i.test(new TextDecoder().decode(bytes.subarray(0, 512)));

// A name that matches what the bytes are ("chart" + PNG bytes → "chart.png");
// anything else is offered as text, which the upload then checks.
// → { name, text } or { error } when the name says PDF (say) but the bytes aren't.
export function nameForBytes(bytes, filename, fallback = 'file') {
  let name = cleanName(filename) || fallback;
  const magic = magicOf(bytes);
  if (magic) {
    const ok = magic.ext === 'jpg' ? /\.jpe?g$/i : new RegExp(`\\.${magic.ext}$`, 'i');
    if (!ok.test(name)) name = `${name.replace(/\.(pdf|docx|png|jpe?g|txt|md|markdown|csv)$/i, '')}.${magic.ext}`;
    return { name, text: false };
  }
  const binary = BINARY_EXT.exec(name);
  if (binary) {
    const kind = binary[1].toUpperCase();
    return {
      error: looksLikeHtml(bytes)
        ? `That isn’t a real ${kind}: it’s a web page (often a preview or sign-in page). Use the file’s direct download link, or its actual bytes.`
        : `That isn’t a real ${kind}: its contents don’t match the name. ShareSecure can share PDF, DOCX, PNG, JPG and text.`
    };
  }
  if (!/\.[a-z0-9]{1,10}$/i.test(name)) name += '.txt';
  return { name, text: true };
}

// Text an assistant wrote → { text, name } (.md, .txt or .csv) or { error }
const TEXT_FORMATS = { markdown: '.md', plain: '.txt', csv: '.csv' };
export function writtenText(args) {
  // only tab, newlines and form feed survive of the control characters
  const text = String(args.text ?? '').replace(/[\x00-\x08\x0B\x0E-\x1F\x7F]/g, '');
  if (!text.trim()) return { error: 'text is empty. Pass the full content to share.' };
  if (text.length > TEXT_MAX) return { error: 'text is over 200,000 characters. Split it into parts and share each one.' };
  // a title isn't a path, so "Q3 / Q4" keeps both halves
  const title = cleanName(String(args.title || '').replace(/[\\/]/g, '-')).replace(/\.(md|markdown|txt|csv)$/i, '') || 'Shared text';
  return { text, name: title + (TEXT_FORMATS[args.format] || TEXT_FORMATS.markdown) };
}

// Base64 from a tool call → { bytes } or { error }. Size and characters are
// checked before decoding; a data: prefix, whitespace and url-safe base64 are fine.
export function decodeBase64(input, maxBytes) {
  const raw = String(input || '');
  const maxChars = Math.ceil(maxBytes / 3) * 4;
  const tooBig = { error: `That’s over ${maxBytes >= 1024 * 1024 ? `${maxBytes / 1024 / 1024} MB` : `${maxBytes / 1024} KB`} once decoded.` };
  if (raw.length > maxChars * 2 + 256) return tooBig;
  const s = raw.replace(/^data:[^,]{0,200},/, '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (!s) return { error: 'The base64 is empty.' };
  if (s.length > maxChars) return tooBig;
  if (!/^[A-Za-z0-9+/]+$/.test(s) || s.length % 4 === 1) return { error: 'That isn’t valid base64.' };
  let bytes;
  try { bytes = base64ToBytes(s + '='.repeat((4 - s.length % 4) % 4)); } catch { return { error: 'That isn’t valid base64.' }; }
  if (bytes.length > maxBytes) return tooBig;
  return { bytes };
}

// the runtime's own decoder when there is one, else atob a piece at a time
function base64ToBytes(b64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const out = new Uint8Array(b64.length / 4 * 3 - pad);
  let o = 0;
  for (let i = 0; i < b64.length; i += 32768) {
    const bin = atob(b64.slice(i, i + 32768));
    for (let j = 0; j < bin.length; j++) out[o++] = bin.charCodeAt(j);
  }
  return out;
}

// ── when something goes wrong ────────────────────────────────────────────────
// A share is made before it's sent to anyone, so an error after that point
// must never read as "nothing happened": the assistant would share it again.

// the send step failed after the share was made → what a share result says instead
export const sendFailed = (list, err) => ({
  sent_to: [], waiting_for_approval: [],
  not_sent: toRecipients(list).map(username => ({ username, reason: `ShareSecure hit an error sending it (${String(err?.message || err || 'unknown').slice(0, 120)})` })),
});

// added to a share result that has a share but didn't reach everyone
export const retryLine = how => `The share itself was made, so don’t share the file again. To retry the people it didn’t reach, call send_share with ${how}.`;

// for an error nobody planned for, which might have come after a share was made
export const TOOL_FAILED = 'Something went wrong. Before trying again, call list_shares: if it was shared anyway, use that share instead of making another.';

// one line every server's instructions carry
export const NO_DUPLICATES = '- If a share tool fails or times out, call list_shares before trying again: it may have been shared anyway, and sharing again makes a second copy.';

// ── tool fields and schemas ──────────────────────────────────────────────────

export const FIELDS = {
  expires_hours: { type: 'number', description: 'Hours until the link stops working, 1 to 240. Default 24.' },
  allow_download: { type: 'boolean', description: 'Let people who open the link download the file. Default false (view only).' },
  require_account: { type: 'boolean', description: 'Only people signed in to ShareSecure can open the link. Default false (anyone with the link).' },
  name: { type: 'string', description: 'Name shown to people who open the link. Defaults to the file name.' },
  note: { type: 'string', maxLength: 140, description: 'Short note shown to the people it’s sent to. Up to 140 characters.' },
  burn_after_reading: { type: 'boolean', description: 'The link works once: the file is erased as soon as anyone opens it, and the user is told if someone tries the link again. Default false.' },
};

// send_to is described per server, since what happens to a send differs
export const sendTo = description => ({ type: 'array', items: { type: 'string' }, maxItems: 20, description });

export const SHARING = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
export const UPLOADING = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
export const READING = { readOnlyHint: true, openWorldHint: false };
export const DELETING = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

export const textInput = common => ({
  type: 'object',
  required: ['text', 'title'],
  properties: {
    text: { type: 'string', maxLength: TEXT_MAX, description: 'The full content to share. Up to 200,000 characters.' },
    title: { type: 'string', description: 'Title, used as the file name, e.g. "Q3 summary".' },
    format: { type: 'string', enum: ['markdown', 'plain', 'csv'], description: 'markdown (.md, the default), plain (.txt) or csv (.csv).' },
    ...common,
  },
});

// begin_upload, upload_chunk and finish_upload: a file of up to 10 MB in pieces
export const chunkTools = (common, finishOutput) => [
  {
    name: 'begin_upload',
    title: 'Start a chunked upload',
    description: 'Start uploading a file of up to 10 MB in chunks, for clients that can compute base64 in code. Every chunk you pass costs output tokens (about 1 per 3 base64 characters), so don’t copy a large file out by hand. Returns upload_id and chunk_size; then call upload_chunk for index 0, 1, 2… and finally finish_upload. Uploads expire after 30 minutes, and at most 3 can be open at once.',
    inputSchema: {
      type: 'object',
      required: ['filename', 'size'],
      properties: {
        filename: { type: 'string', description: 'The file’s name with its extension, e.g. "report.pdf".' },
        size: { type: 'integer', minimum: 1, maximum: MAX_BYTES, description: 'The file’s size in bytes.' },
        sha256: { type: 'string', description: 'Optional SHA-256 of the whole file in hex, checked at the end.' },
        ...common,
      },
    },
    annotations: UPLOADING,
  },
  {
    name: 'upload_chunk',
    title: 'Send one chunk',
    description: 'Send one chunk of a chunked upload: the bytes from index × chunk_size, as base64, at most 512 KB once decoded. Send them in order from 0; resending the last one is safe.',
    inputSchema: {
      type: 'object',
      required: ['upload_id', 'index', 'data_base64'],
      properties: {
        upload_id: { type: 'string', description: 'From begin_upload.' },
        index: { type: 'integer', minimum: 0, description: 'Which chunk this is, from 0.' },
        data_base64: { type: 'string', description: 'The chunk’s bytes as base64.' },
        sha256: { type: 'string', description: 'Optional SHA-256 of this chunk in hex, to catch copying mistakes.' },
      },
    },
    annotations: UPLOADING,
  },
  {
    name: 'finish_upload',
    title: 'Finish a chunked upload',
    description: 'Finish a chunked upload once every chunk is in. Creates the link, and sends it to the send_to given to begin_upload.',
    inputSchema: { type: 'object', required: ['upload_id'], properties: { upload_id: { type: 'string', description: 'From begin_upload.' } } },
    ...(finishOutput ? { outputSchema: finishOutput } : {}),
    annotations: SHARING,
  },
];

export const deleteTool = description => ({
  name: 'delete_share',
  title: 'Delete a share',
  description,
  inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string', description: 'The share id.' } } },
  annotations: DELETING,
});

export const answerTool = {
  name: 'answer_request',
  title: 'Accept or decline a file sent to the user',
  description: 'Accept or decline a file someone sent to this account (an id from list_inbox with status pending). Only do this when the user asks. Declining erases the file.',
  inputSchema: {
    type: 'object',
    required: ['id', 'action'],
    properties: {
      id: { type: 'string', description: 'The request’s id from list_inbox.' },
      action: { type: 'string', enum: ['accept', 'decline'] },
    },
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
};

export const requestTool = description => ({
  name: 'request_file',
  title: 'Ask someone for a file',
  description,
  inputSchema: {
    type: 'object',
    required: ['label'],
    properties: {
      label: { type: 'string', maxLength: 300, description: 'What the user is asking for, shown to the person sending it, e.g. "Your signed lease".' },
      hours: { type: 'number', description: 'How long the link takes files, 1 to 720 hours. Default 72.' },
      max_files: { type: 'integer', minimum: 1, maximum: 20, description: 'How many files it takes. Default 5.' },
    },
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
});

// the app icon, for clients that show one next to the server (MCP 2025-11-25)
export const serverIcons = origin => [{ src: `${origin}/app-icon.png`, mimeType: 'image/png', sizes: ['256x256'] }];
