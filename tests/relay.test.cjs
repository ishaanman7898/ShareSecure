'use strict';
// The relay (relay/src/index.js, a Cloudflare Worker with a Durable Object per
// computer) and this computer's end of it (server/relay.js). Anyone holding a
// link knows its computer's id, so none of them may tie that computer up.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sharesecure-relay-'));
process.env.DATA_DIR = path.join(temp, 'data');
process.env.ENCRYPTION_KEY = '42'.repeat(32);
process.env.SHARESECURE_RELAY = 'https://relay.test';
after(() => {
  // the relay client's settings open the server's database
  const dbFile = path.join(root, 'server', 'db.js');
  if (require.cache[dbFile]) require(dbFile).db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

const tick = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, what) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await sleep(10);
  }
  assert.fail(`timed out waiting for ${what}`);
}

// ── the parts of the Workers runtime the relay uses ──────────────────────────
class FakeSocket {
  constructor() { this.sent = []; this.readyState = 1; this.attachment = null; this.closed = null; }
  send(data) { if (this.readyState !== 1) throw new Error('closed'); this.sent.push(data); }
  close(code, reason) { if (this.readyState > 1) return; this.readyState = 2; this.closed = { code, reason }; }
  serializeAttachment(value) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return this.attachment; }
  messages() { return this.sent.filter(m => typeof m === 'string').map(m => JSON.parse(m)); }
}
globalThis.WebSocketPair = class { constructor() { this[0] = new FakeSocket(); this[1] = new FakeSocket(); } };
globalThis.WebSocketRequestResponsePair = class { constructor(request, response) { Object.assign(this, { request, response }); } };
// a Worker answers a WebSocket with status 101, which Node's Response won't take
const NodeResponse = Response;
globalThis.Response = class extends NodeResponse {
  constructor(body, init = {}) {
    super(body, init.status === 101 ? { ...init, status: 200 } : init);
    if (init.status === 101) Object.defineProperty(this, 'status', { value: 101 });
    this.webSocket = init.webSocket || null;
  }
};

function fakeState() {
  const sockets = [];
  let alarm = null;
  return {
    sockets,
    acceptWebSocket: ws => sockets.push(ws),
    // a closing socket is still listed until it has closed, as in the runtime
    getWebSockets: () => sockets.filter(ws => ws.readyState < 3),
    setWebSocketAutoResponse() {},
    storage: { getAlarm: async () => alarm, setAlarm: async at => { alarm = at; } },
    get alarm() { return alarm; },
  };
}

let loaded = null;
async function loadRelay() {
  if (loaded) return loaded;
  const source = fs.readFileSync(path.join(root, 'relay', 'src', 'index.js'), 'utf8')
    .replace("import { DurableObject } from 'cloudflare:workers';", 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }');
  assert(!source.includes('cloudflare:workers'));
  const file = path.join(temp, 'relay-worker.mjs');
  fs.writeFileSync(file, source);
  loaded = await import(pathToFileURL(file).href);
  return loaded;
}

// a computer: its key, and the id the relay knows it by
const subtle = globalThis.crypto.subtle;
const b64url = bytes => Buffer.from(bytes).toString('base64url');
async function makeComputer() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const id = b64url(new Uint8Array(await subtle.digest('SHA-256', raw)).subarray(0, 16));
  const sign = async nonce => b64url(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey,
    new TextEncoder().encode(`sharesecure relay ${id} ${nonce}`))));
  return { id, raw, sign };
}

const at = (kind, id, rest = '') => `https://relay.test/${kind}/${id}${rest}`;
async function open(room, id) {
  const res = await room.fetch(new Request(at('connect', id), { headers: { Upgrade: 'websocket' } }));
  assert.equal(res.status, 101);
  return room.ctx.sockets.at(-1);   // the relay's end of it
}
const helloFor = async (computer, ws) => JSON.stringify({ t: 'hello', key: b64url(computer.raw), sig: await computer.sign(ws.messages()[0].nonce) });
async function signIn(room, computer) {
  const ws = await open(room, computer.id);
  await room.webSocketMessage(ws, await helloFor(computer, ws));
  assert.equal(ws.messages().at(-1).t, 'ready');
  return ws;
}

test('attack: sockets that never prove they’re the computer can’t pile up, or keep it out', async () => {
  const { Computer } = await loadRelay();
  const computer = await makeComputer();
  const room = new Computer(fakeState(), {});
  // anyone with a link knows the id: ten sockets of theirs at once
  const theirs = [];
  for (let i = 0; i < 10; i++) theirs.push(await open(room, computer.id));
  const trying = theirs.filter(ws => ws.readyState === 1);
  assert.equal(trying.length, 4, 'only a few may try at once');
  assert.deepEqual(trying, theirs.slice(-4), 'the oldest gave way');
  assert(room.ctx.alarm, 'an alarm is set to close the slow ones');
  // the computer still gets in, and every other socket is closed
  const mine = await signIn(room, computer);
  assert.equal(room.live(), mine);
  assert(theirs.every(ws => ws.readyState > 1));
});

test('attack: a socket that says anything but a timely hello is closed, and so is one that says nothing', async () => {
  const { Computer } = await loadRelay();
  const computer = await makeComputer();
  const room = new Computer(fakeState(), {});
  const chatty = await open(room, computer.id);
  await room.webSocketMessage(chatty, JSON.stringify({ t: 'head', id: 1, status: 200 }));
  assert.equal(chatty.closed?.code, 1008);
  const binary = await open(room, computer.id);
  await room.webSocketMessage(binary, new Uint8Array([0, 0, 0, 1, 9]).buffer);
  assert.equal(binary.closed?.code, 1008);
  // a hello with the right key, but too late
  const late = await open(room, computer.id);
  late.attachment.at -= 11 * 1000;
  await room.webSocketMessage(late, await helloFor(computer, late));
  assert.equal(late.closed?.code, 1008);
  assert.equal(room.live(), undefined);
  // one that never says a thing is closed when the alarm goes off
  const silent = await open(room, computer.id);
  silent.attachment.at -= 11 * 1000;
  await room.alarm();
  assert.equal(silent.closed?.code, 1008);
});

test('attack: one visitor can’t hold every answer a computer gives, and others are still served', async () => {
  const { Computer } = await loadRelay();
  const computer = await makeComputer();
  const room = new Computer(fakeState(), {});
  const ws = await signIn(room, computer);
  const ask = visitor => room.fetch(new Request(at('c', computer.id, '/api/info/abcd'), { headers: { 'x-relay-visitor': visitor } }));
  const waiting = [];
  for (let i = 0; i < 16; i++) waiting.push(ask('one'));
  await tick();
  const turnedAway = await ask('one');
  assert.equal(turnedAway.status, 503, 'a 17th from the same visitor waits its turn');
  assert(turnedAway.headers.get('retry-after'));
  for (const visitor of ['two', 'three', 'four']) for (let i = 0; i < 16; i++) waiting.push(ask(visitor));
  await tick();
  assert.equal((await ask('five')).status, 503, 'and no more than 64 at once in all');
  // all the others reached the computer; once it answers, their places are free
  const asked = ws.messages().filter(m => m.t === 'req');
  assert.equal(asked.length, 64);
  for (const m of asked) await room.webSocketMessage(ws, JSON.stringify({ t: 'error', id: m.id }));
  for (const res of await Promise.all(waiting)) assert.equal(res.status, 502);
  assert.equal(room.waiting.size, 0);
});

test('attack: the relay counts visitors without using their address, and turns big bodies away unread', async () => {
  const { default: worker, Computer } = await loadRelay();
  const id = 'A'.repeat(22);
  const reached = [];
  const keys = [];
  let allowance = 2;
  const env = {
    COMPUTER: { idFromName: name => name, get: () => ({ fetch: async request => { reached.push(request); return new Response('ok'); } }) },
    REQUESTS: { limit: async ({ key }) => { keys.push(key); return { success: keys.length <= allowance }; } },
    CONNECTS: { limit: async () => ({ success: true }) },
  };
  const from = (address, init = {}) => new Request(at('c', id, '/api/info/abcd'), {
    ...init,
    headers: { 'cf-connecting-ip': address, 'x-relay-visitor': 'spoofed', ...init.headers },
  });

  assert.equal((await worker.fetch(from('203.0.113.9'), env)).status, 200);
  const passed = reached[0].headers.get('x-relay-visitor');
  assert.notEqual(passed, 'spoofed', 'a visitor can’t say who they are');
  assert(!passed.includes('203.0.113') && !keys[0].includes('203.0.113'), 'the address itself is never used');
  assert.equal(keys[0], `${id} ${passed}`, 'an allowance per visitor and computer');
  await worker.fetch(from('198.51.100.7'), env);
  assert.notEqual(keys[1], keys[0], 'someone else has their own');
  const limited = await worker.fetch(from('203.0.113.9'), env);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(reached.length, 2);

  // a body that says it's too big never reaches the computer…
  allowance = Infinity;
  const big = await worker.fetch(from('203.0.113.9', { method: 'POST', body: 'x', headers: { 'content-length': String(901 * 1024) } }), env);
  assert.equal(big.status, 413);
  assert.equal(reached.length, 2);
  // …and one that doesn't say is read only as far as the limit
  const computer = await makeComputer();
  const room = new Computer(fakeState(), {});
  const ws = await signIn(room, computer);
  let pulled = 0;
  const endless = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(100 * 1024)); } });
  const res = await room.fetch(new Request(at('c', computer.id, '/mcp'), { method: 'POST', body: endless, duplex: 'half' }));
  assert.equal(res.status, 413);
  assert(pulled < 20, 'it stopped reading');
  assert.equal(room.waiting.size, 0);
  assert(!ws.messages().some(m => m.t === 'req'), 'nothing went to the computer');
});

test('a download whose reader leaves is called off, and its place freed', async () => {
  const { Computer } = await loadRelay();
  const computer = await makeComputer();
  const room = new Computer(fakeState(), {});
  const ws = await signIn(room, computer);
  const answer = room.fetch(new Request(at('c', computer.id, '/api/raw/abcd')));
  await tick();
  const req = ws.messages().find(m => m.t === 'req');
  await room.webSocketMessage(ws, JSON.stringify({ t: 'head', id: req.id, status: 200, headers: { 'content-type': 'application/octet-stream' } }));
  const res = await answer;
  assert.equal(res.status, 200);
  await res.body.cancel();
  const piece = new Uint8Array(12);
  new DataView(piece.buffer).setUint32(0, req.id);
  await room.webSocketMessage(ws, piece.buffer);
  await until(() => ws.messages().some(m => m.t === 'cancel' && m.id === req.id), 'the computer to be told');
  assert.equal(room.waiting.size, 0);
});

test('a download the relay calls off stops on this computer too', async () => {
  // a file that never ends, so only being called off stops it
  let closedHere = false;
  const local = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    const chunk = Buffer.alloc(64 * 1024, 7);
    const pump = () => { while (!res.destroyed && res.write(chunk)); };
    res.on('drain', pump);
    res.on('close', () => { closedHere = true; });
    pump();
  });
  await new Promise(resolve => local.listen(0, '127.0.0.1', resolve));

  const sockets = [];
  globalThis.WebSocket = class extends EventTarget {
    constructor(address) {
      super();
      this.address = address;
      this.readyState = 1;
      this.sent = [];
      sockets.push(this);
      setImmediate(() => this.dispatchEvent(new Event('open')));
    }
    send(data) { this.sent.push(data); }
    close() { this.readyState = 3; }
    receive(m) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m) })); }
  };
  const said = ws => ws.sent.filter(m => typeof m === 'string' && m.startsWith('{')).map(m => JSON.parse(m));
  const pieces = ws => ws.sent.filter(m => typeof m !== 'string');

  const client = require(path.join(root, 'server', 'relay.js'));
  try {
    client.start(local.address().port);
    await until(() => sockets.length === 1, 'the connection');
    const ws = sockets[0];
    assert.equal(ws.address, `wss://relay.test/connect/${client.identity().id}`);
    ws.receive({ t: 'challenge', nonce: 'n' });
    assert.equal(said(ws).at(-1).t, 'hello');
    ws.receive({ t: 'ready' });
    ws.receive({ t: 'req', id: 7, method: 'GET', path: '/api/raw/abcd', headers: {}, body: null });
    await until(() => pieces(ws).length === 8, 'the first pieces');
    await sleep(50);
    assert.equal(pieces(ws).length, 8, 'then it waits for the reader');
    ws.receive({ t: 'cancel', id: 7 });
    await until(() => closedHere, 'the file to be closed here');
    const sentBefore = ws.sent.length;
    await sleep(50);
    assert.equal(ws.sent.length, sentBefore, 'nothing more is sent');
    assert(!said(ws).some(m => m.t === 'end'));
  } finally {
    // no more connections after this one closes
    globalThis.WebSocket = class { constructor() { throw new Error('gone'); } };
    for (const ws of sockets) ws.dispatchEvent(new Event('close'));
    local.close();
  }
});
