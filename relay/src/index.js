// ShareSecure relay: links to a ShareSecure that runs on someone's own
// computer (the desktop app, or a self-hosted copy).
//
// That computer can't be reached from the internet, so it keeps one WebSocket
// open to this relay (GET /connect/<id>) and proves it holds the private key
// its id is made from. Requests for its links (/c/<id>/…) go down that socket
// as messages; the answers come back up it in pieces, at the pace the person
// downloading reads them. People opening a link only ever talk to the relay,
// never to the computer, so its address stays private.
//
// Files are locked end to end before they're stored, with the key in the link
// after "#", which browsers never send: the relay only ever carries locked
// bytes, and the computer refuses to send anything else through it. Nothing
// is kept here: no log, no addresses, no files.
import { DurableObject } from 'cloudflare:workers';

const ID = '[A-Za-z0-9_-]{22}';
const ROUTE = new RegExp(`^/(connect|c)/(${ID})(/.*)?$`);
const MAX_BODY = 900 * 1024;      // what a viewer or an assistant sends is small
const ANSWER_WITHIN = 30 * 1000;  // for the computer to start answering
// what passes between the person opening a link and the computer, and nothing else
const REQUEST_HEADERS = ['content-type', 'authorization', 'accept', 'range', 'x-delete-token', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const RESPONSE_HEADERS = ['content-type', 'content-length', 'content-disposition', 'content-range', 'accept-ranges', 'mcp-session-id'];
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': REQUEST_HEADERS.join(', '),
  'Access-Control-Expose-Headers': RESPONSE_HEADERS.join(', '),
  'Access-Control-Max-Age': '600',
};
const SAFE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" };

const text = (message, status) => new Response(message, { status, headers: { ...CORS, ...SAFE, 'Content-Type': 'text/plain; charset=utf-8' } });
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const match = new URL(request.url).pathname.match(ROUTE);
    if (!match) return text('ShareSecure relay', 404);
    return env.COMPUTER.get(env.COMPUTER.idFromName(match[2])).fetch(request);
  },
};

// The id is the first 16 bytes of the SHA-256 of the computer's public key, so
// only the holder of that key can take it.
async function provesId(id, nonce, hello) {
  try {
    const raw = fromB64url(String(hello.key || ''));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
    if (b64url(digest.subarray(0, 16)) !== id) return false;
    const key = await crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromB64url(String(hello.sig || '')),
      new TextEncoder().encode(`sharesecure relay ${id} ${nonce}`));
  } catch { return false; }
}

// One per computer: its socket, and the requests waiting on it.
export class Computer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.waiting = new Map();   // request id → { head, piece, end, fail }
    this.nextId = 1;
    // keeps the socket open without waking this up
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const [, kind, id, rest = '/'] = url.pathname.match(ROUTE);
    if (kind === 'connect') return this.connect(request, id);
    return this.forward(request, rest + url.search);
  }

  connect(request, id) {
    if (request.headers.get('Upgrade') !== 'websocket') return text('Expected a WebSocket', 426);
    const [client, server] = Object.values(new WebSocketPair());
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(32)));
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, nonce, ok: false });
    server.send(JSON.stringify({ t: 'challenge', nonce }));
    return new Response(null, { status: 101, webSocket: client });
  }

  live() {
    return this.ctx.getWebSockets().find(ws => ws.deserializeAttachment()?.ok);
  }

  async forward(request, path) {
    const ws = this.live();
    if (!ws) return text('The computer this link is on isn’t online right now. Links to a computer work while it’s on.', 503);
    if (!['GET', 'POST', 'DELETE'].includes(request.method)) return text('Not allowed', 405);
    let body = null;
    if (request.method !== 'GET') {
      body = await request.text();
      if (body.length > MAX_BODY) return text('Too large', 413);
    }
    const headers = {};
    for (const name of REQUEST_HEADERS) if (request.headers.has(name)) headers[name] = request.headers.get(name);

    const rid = this.nextId;
    this.nextId = this.nextId >= 0xffffffff ? 1 : this.nextId + 1;
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.waiting.delete(rid); };
      const timer = setTimeout(() => { done(); resolve(text('The computer didn’t answer in time.', 504)); }, ANSWER_WITHIN);
      this.waiting.set(rid, {
        head: m => {
          clearTimeout(timer);
          const out = new Headers({ ...CORS, ...SAFE });
          for (const name of RESPONSE_HEADERS) if (m.headers?.[name]) out.set(name, String(m.headers[name]));
          resolve(new Response(readable, { status: Number(m.status) || 502, headers: out }));
        },
        // each piece is acknowledged once the reader has taken it, so a slow
        // download slows the computer down instead of filling memory here
        piece: bytes => writer.write(bytes).then(() => this.ack(ws, rid), () => {}),
        end: () => { done(); writer.close().catch(() => {}); },
        fail: () => { done(); writer.abort().catch(() => {}); resolve(text('The computer couldn’t answer.', 502)); },
      });
      ws.send(JSON.stringify({ t: 'req', id: rid, method: request.method, path, headers, body }));
    });
  }

  ack(ws, rid) {
    try { ws.send(JSON.stringify({ t: 'ack', id: rid })); } catch {}
  }

  async webSocketMessage(ws, message) {
    const state = ws.deserializeAttachment() || {};
    if (typeof message !== 'string') {
      // a piece of an answer: [4-byte request id][bytes]
      if (!state.ok) return ws.close(1008, 'Not signed in');
      const bytes = new Uint8Array(message);
      if (bytes.length < 4) return;
      const rid = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
      this.waiting.get(rid)?.piece(bytes.slice(4));
      return;
    }
    let m;
    try { m = JSON.parse(message); } catch { return; }
    if (!state.ok) {
      if (m.t !== 'hello') return;
      if (!(await provesId(state.id, state.nonce, m))) return ws.close(1008, 'Wrong key');
      // the newest connection from the computer wins
      for (const other of this.ctx.getWebSockets()) if (other !== ws) { try { other.close(1000, 'Replaced'); } catch {} }
      ws.serializeAttachment({ ...state, ok: true });
      ws.send(JSON.stringify({ t: 'ready' }));
      return;
    }
    const waiting = this.waiting.get(m.id);
    if (!waiting) return;
    if (m.t === 'head') waiting.head(m);
    else if (m.t === 'end') waiting.end();
    else if (m.t === 'error') waiting.fail();
  }

  webSocketClose(ws) { this.dropped(ws); }
  webSocketError(ws) { this.dropped(ws); }

  dropped(ws) {
    if (!ws.deserializeAttachment()?.ok || this.live()) return;
    for (const waiting of [...this.waiting.values()]) waiting.fail();
  }
}
