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
//
// Anyone with a link knows its computer's id, so nobody may tie that computer
// up: a new socket has seconds to prove it's the computer (and only a few may
// try at once), each visitor gets a fair share of the requests and of the
// answers in progress, and a body that's too big is turned away unread.
import { DurableObject } from 'cloudflare:workers';

const ID = '[A-Za-z0-9_-]{22}';
const ROUTE = new RegExp(`^/(connect|c)/(${ID})(/.*)?$`);
const MAX_BODY = 900 * 1024;      // what a viewer or an assistant sends is small
const ANSWER_WITHIN = 30 * 1000;  // for the computer to start answering
const IDLE_WITHIN = 60 * 1000;    // for the next piece of an answer to be taken
const HELLO_WITHIN = 10 * 1000;   // for a new socket to prove it's the computer
const MAX_PENDING = 4;            // sockets still trying to, per computer (the oldest gives way)
const MAX_WAITING = 64;           // answers in progress, per computer
const MAX_PER_VISITOR = 16;       // of those, for one visitor
// who's asking, as the Worker worked it out (a one-way hash of their address);
// set here for the Durable Object, never passed on to the computer
const VISITOR = 'x-relay-visitor';
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

const text = (message, status, extra = {}) => new Response(message, { status, headers: { ...CORS, ...SAFE, 'Content-Type': 'text/plain; charset=utf-8', ...extra } });
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

// A visitor, for counting only: their address can't be read back from it, and
// it's never stored. Rate limits are kept by Cloudflare for a minute at most.
async function visitorOf(request) {
  const address = request.headers.get('cf-connecting-ip') || '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`sharesecure relay visitor ${address}`));
  return b64url(new Uint8Array(digest).subarray(0, 12));
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const match = new URL(request.url).pathname.match(ROUTE);
    if (!match) return text('ShareSecure relay', 404);
    const [, kind, id] = match;
    // Each visitor has their own allowance for each computer, so a busy
    // network, or an assistant service many people use, never uses up anyone
    // else's, and nobody can flood one computer.
    const visitor = await visitorOf(request);
    const limiter = kind === 'connect' ? env.CONNECTS : env.REQUESTS;
    if (limiter && !(await limiter.limit({ key: `${id} ${visitor}` })).success) {
      return text('Too many requests. Try again in a minute.', 429, { 'Retry-After': '60' });
    }
    if (Number(request.headers.get('content-length')) > MAX_BODY) return text('Too large', 413);
    const headers = new Headers(request.headers);
    headers.set(VISITOR, visitor);
    return env.COMPUTER.get(env.COMPUTER.idFromName(id)).fetch(new Request(request, { headers }));
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

// A body as text, read no further than `max` bytes. → the text, or null if it's bigger
async function readText(request, max) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.byteLength;
  }
  return new TextDecoder().decode(all);
}

const tell = (ws, message) => { try { ws.send(JSON.stringify(message)); } catch {} };
const drop = (ws, reason) => { try { ws.close(1008, reason); } catch {} };

// One per computer: its socket, and the requests waiting on it.
export class Computer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.waiting = new Map();   // request id → { visitor, head, piece, end, fail }
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

  async connect(request, id) {
    if (request.headers.get('Upgrade') !== 'websocket') return text('Expected a WebSocket', 426);
    this.sweep(MAX_PENDING - 1);
    const [client, server] = Object.values(new WebSocketPair());
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(32)));
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, nonce, ok: false, at: Date.now() });
    server.send(JSON.stringify({ t: 'challenge', nonce }));
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + HELLO_WITHIN + 1000);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Sockets that haven't proved they're the computer are closed once they've
  // had HELLO_WITHIN, and then the oldest of the rest, down to `keep`. The
  // computer answers its challenge straight away, so it's never the one that
  // waited longest. → the ones left, oldest first
  sweep(keep = MAX_PENDING) {
    const now = Date.now();
    const trying = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState > 1) continue;   // already closing
      const state = ws.deserializeAttachment();
      if (!state?.ok) trying.push({ ws, at: state?.at || 0 });
    }
    trying.sort((a, b) => a.at - b.at);
    const left = [];
    for (const one of trying) {
      if (now - one.at >= HELLO_WITHIN) drop(one.ws, 'Too slow');
      else left.push(one);
    }
    while (left.length > Math.max(keep, 0)) drop(left.shift().ws, 'Too many tries');
    return left;
  }

  // (a second late, so the oldest is sure to be past its time when it goes off)
  async alarm() {
    const left = this.sweep();
    if (left.length) await this.ctx.storage.setAlarm(left[0].at + HELLO_WITHIN + 1000);
  }

  live() {
    return this.ctx.getWebSockets().find(ws => ws.readyState <= 1 && ws.deserializeAttachment()?.ok);
  }

  answersFor(visitor) {
    let n = 0;
    for (const waiting of this.waiting.values()) if (waiting.visitor === visitor) n++;
    return n;
  }

  async forward(request, path) {
    if (!this.live()) return text('The computer this link is on isn’t online right now. Links to a computer work while it’s on.', 503);
    if (!['GET', 'POST', 'DELETE'].includes(request.method)) return text('Not allowed', 405);
    const visitor = request.headers.get(VISITOR) || '';
    if (this.waiting.size >= MAX_WAITING || this.answersFor(visitor) >= MAX_PER_VISITOR) {
      return text('This computer is busy right now. Try again in a moment.', 503, { 'Retry-After': '5' });
    }
    // the place is kept while the body comes in
    const rid = this.nextId;
    this.nextId = this.nextId >= 0xffffffff ? 1 : this.nextId + 1;
    const entry = { visitor, done: false };
    this.waiting.set(rid, entry);
    let body = null;
    if (request.method !== 'GET') {
      body = await readText(request, MAX_BODY).catch(() => null);
      if (body == null) {
        this.waiting.delete(rid);
        return text('Too large', 413);
      }
    }
    const ws = this.live();
    if (!ws) {
      this.waiting.delete(rid);
      return text('The computer this link is on isn’t online right now. Links to a computer work while it’s on.', 503);
    }
    const headers = {};
    for (const name of REQUEST_HEADERS) if (request.headers.has(name)) headers[name] = request.headers.get(name);

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    return new Promise(resolve => {
      let timer = null;
      const finish = () => {
        entry.done = true;
        clearTimeout(timer);
        if (this.waiting.get(rid) === entry) this.waiting.delete(rid);
      };
      // The reader left, stopped reading, or the computer never answered:
      // free the place, and tell the computer to stop sending.
      const callOff = response => {
        if (entry.done) return;
        finish();
        tell(ws, { t: 'cancel', id: rid });
        writer.abort().catch(() => {});
        resolve(response);   // does nothing once the answer has started
      };
      const wait = ms => {
        if (entry.done) return;
        clearTimeout(timer);
        timer = setTimeout(() => callOff(text('The computer didn’t answer in time.', 504)), ms);
      };
      Object.assign(entry, {
        head: m => {
          wait(IDLE_WITHIN);
          const out = new Headers({ ...CORS, ...SAFE });
          for (const name of RESPONSE_HEADERS) if (m.headers?.[name]) out.set(name, String(m.headers[name]));
          resolve(new Response(readable, { status: Number(m.status) || 502, headers: out }));
        },
        // each piece is acknowledged once the reader has taken it, so a slow
        // download slows the computer down instead of filling memory here
        piece: bytes => writer.write(bytes).then(() => {
          if (entry.done) return;
          wait(IDLE_WITHIN);
          tell(ws, { t: 'ack', id: rid });
        }, () => callOff(text('Gone', 502))),
        end: () => { finish(); writer.close().catch(() => {}); },
        fail: () => { finish(); writer.abort().catch(() => {}); resolve(text('The computer couldn’t answer.', 502)); },
      });
      wait(ANSWER_WITHIN);
      tell(ws, { t: 'req', id: rid, method: request.method, path, headers, body });
    });
  }

  async webSocketMessage(ws, message) {
    const state = ws.deserializeAttachment() || {};
    if (!state.ok) {
      // until it has proved its key, a socket may say one thing, once, in time: hello
      let m = null;
      if (typeof message === 'string') { try { m = JSON.parse(message); } catch {} }
      if (m?.t !== 'hello' || Date.now() - (state.at || 0) > HELLO_WITHIN) return drop(ws, 'Not signed in');
      if (!(await provesId(state.id, state.nonce, m))) return drop(ws, 'Wrong key');
      // the newest connection from the computer wins
      for (const other of this.ctx.getWebSockets()) if (other !== ws) { try { other.close(1000, 'Replaced'); } catch {} }
      ws.serializeAttachment({ ...state, ok: true });
      ws.send(JSON.stringify({ t: 'ready' }));
      return;
    }
    if (typeof message !== 'string') {
      // a piece of an answer: [4-byte request id][bytes]
      const bytes = new Uint8Array(message);
      if (bytes.length < 4) return;
      const rid = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
      this.waiting.get(rid)?.piece?.(bytes.slice(4));
      return;
    }
    let m;
    try { m = JSON.parse(message); } catch { return; }
    const waiting = this.waiting.get(m.id);
    if (!waiting?.head) return;
    if (m.t === 'head') waiting.head(m);
    else if (m.t === 'end') waiting.end();
    else if (m.t === 'error') waiting.fail();
  }

  webSocketClose(ws) { this.dropped(ws); }
  webSocketError(ws) { this.dropped(ws); }

  dropped(ws) {
    if (!ws.deserializeAttachment()?.ok || this.live()) return;
    for (const waiting of [...this.waiting.values()]) waiting.fail?.();
  }
}
