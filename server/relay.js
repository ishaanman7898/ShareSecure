'use strict';
// This computer's end of ShareSecure's relay (relay/src/index.js), which is
// how links to a ShareSecure on your own computer reach it from anywhere.
//
// The server opens one WebSocket out to the relay (nothing has to be opened on
// the router) and proves it holds this computer's key, whose hash is the id in
// its links: https://<website>/l/<id>/r/<share>#k=<key>. People opening a link
// only ever talk to the relay, so they never learn this computer's address.
//
// The relay passes requests down the socket; they're answered here by asking
// this server itself, then sent back in pieces. Only what a viewer (or an
// assistant, at /mcp) needs is answered, and only shares locked end to end
// (routes/files.js refuses the rest), so the relay only ever carries locked
// bytes: the key is in the link after "#", which never leaves the browser.
const crypto = require('crypto');
const http = require('http');
const settings = require('./settings');
const { encryptString, decryptString, getEncKey } = require('./utils');
const events = require('./events');

const RELAY = (process.env.SHARESECURE_RELAY || 'https://sharesecure-relay.ishman.workers.dev').replace(/\/+$/, '');
const WEBSITE = (process.env.SHARESECURE_CLOUD || 'https://sharesecure-du8.pages.dev').replace(/\/+$/, '');
const PIECE = 256 * 1024;   // bytes per message, under the relay's 1 MB limit
const IN_FLIGHT = 8;        // pieces sent before the relay says the reader took one
const MAX_WAIT = 60 * 1000;

// What may come through: a viewer's calls, and an assistant's connection.
const ALLOWED = [
  ['GET', /^\/api\/info\/[A-Za-z0-9_-]{4,64}$/],
  ['GET', /^\/api\/raw\/[A-Za-z0-9_-]{4,64}$/],
  ['GET', /^\/api\/download\/[A-Za-z0-9_-]{4,64}$/],
  ['POST', /^\/api\/reshare\/[A-Za-z0-9_-]{4,64}$/],
  ['GET', /^\/api\/annotations\/[A-Za-z0-9_-]{4,64}$/],
  ['POST', /^\/api\/annotations\/[A-Za-z0-9_-]{4,64}$/],
  ['POST', /^\/api\/delete\/[A-Za-z0-9_-]{4,64}$/],
  ['GET', /^\/connect\/[A-Za-z0-9_-]{8,128}$/],
  ['POST', /^\/connect\/[A-Za-z0-9_-]{8,128}$/],
  ['GET', /^\/mcp$/], ['POST', /^\/mcp$/], ['DELETE', /^\/mcp$/],
];
const allowed = (method, path) => ALLOWED.some(([m, re]) => m === method && re.test(path.split('?')[0]));
const PASS_BACK = ['content-type', 'content-length', 'content-disposition', 'content-range', 'accept-ranges', 'mcp-session-id'];

const b64url = buf => Buffer.from(buf).toString('base64url');

// ── this computer's key and id ───────────────────────────────────────────────
// Made once and kept (encrypted) in settings.json, so links keep their address
// across restarts.
function identity() {
  let stored = null;
  try { stored = settings.get('relayKey') && JSON.parse(decryptString(settings.get('relayKey'), getEncKey())); } catch {}
  if (!stored) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    stored = {
      privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
      publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    };
    settings.set('relayKey', encryptString(JSON.stringify(stored), getEncKey()));
  }
  const privateKey = crypto.createPrivateKey({ key: Buffer.from(stored.privateKey, 'base64url'), format: 'der', type: 'pkcs8' });
  const publicKey = crypto.createPublicKey({ key: Buffer.from(stored.publicKey, 'base64url'), format: 'der', type: 'spki' });
  // the raw 65-byte point, as the relay imports it
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const id = b64url(crypto.createHash('sha256').update(raw).digest().subarray(0, 16));
  return { id, raw, privateKey };
}

// The address links are made with: the website's /l/<id>, which shows the
// viewer and points it at the relay.
const publicBase = id => `${WEBSITE}/l/${id}`;
const relayBase = id => `${RELAY}/c/${id}`;

// ── answering ────────────────────────────────────────────────────────────────
function ask(port, m) {
  return new Promise((resolve, reject) => {
    const headers = { ...m.headers, host: 'relay.sharesecure', 'x-sharesecure-relay': '1' };
    if (m.body != null) headers['content-length'] = Buffer.byteLength(m.body);
    const req = http.request({ host: '127.0.0.1', port, method: m.method, path: m.path, headers }, resolve);
    req.on('error', reject);
    req.setTimeout(MAX_WAIT, () => req.destroy(new Error('timed out')));
    if (m.body != null) req.write(m.body);
    req.end();
  });
}

function start(port) {
  if (typeof WebSocket !== 'function') {
    console.warn('  [relay] This version of Node has no WebSocket, so links only work on this computer. Use Node 22 or newer.');
    return;
  }
  const me = identity();
  process.env.BASE_URL = publicBase(me.id);
  process.env.SHARESECURE_RELAY_BASE = relayBase(me.id);
  let wait = 1000;
  let announced = false;

  const connect = () => {
    let ws;
    try { ws = new WebSocket(`${RELAY.replace(/^http/, 'ws')}/connect/${me.id}`); } catch { return retry(); }
    ws.binaryType = 'arraybuffer';
    const credits = new Map();   // request id → { free, wake }
    let ping = null;
    let closed = false;

    const send = data => { if (ws.readyState === 1) ws.send(data); };
    const json = obj => send(JSON.stringify(obj));

    async function answer(m) {
      if (!allowed(m.method, m.path)) return json({ t: 'head', id: m.id, status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } }), send(frame(m.id, Buffer.from('Not found'))), json({ t: 'end', id: m.id });
      let res;
      try { res = await ask(port, m); } catch { return json({ t: 'error', id: m.id }); }
      const headers = {};
      for (const name of PASS_BACK) if (res.headers[name]) headers[name] = res.headers[name];
      json({ t: 'head', id: m.id, status: res.statusCode, headers });
      // someone, somewhere else, opening (or saving) one of your links
      if (res.statusCode === 200 && m.method === 'GET' && /^\/api\/(raw|download)\//.test(m.path)) events.emit('opened', {});
      const credit = { free: IN_FLIGHT, wake: null };
      credits.set(m.id, credit);
      try {
        for await (const chunk of res) {
          for (let at = 0; at < chunk.length; at += PIECE) {
            while (credit.free <= 0 && !closed) await new Promise(r => { credit.wake = r; });
            if (closed) return;
            credit.free--;
            send(frame(m.id, chunk.subarray(at, at + PIECE)));
          }
        }
        json({ t: 'end', id: m.id });
      } catch {
        json({ t: 'error', id: m.id });
      } finally {
        credits.delete(m.id);
      }
    }

    ws.addEventListener('open', () => {
      // keeps the connection from going idle; the relay answers without waking
      ping = setInterval(() => send('ping'), 25 * 1000);
    });
    ws.addEventListener('message', event => {
      if (typeof event.data !== 'string' || event.data === 'pong') return;
      let m;
      try { m = JSON.parse(event.data); } catch { return; }
      if (m.t === 'challenge') {
        const sig = crypto.sign('sha256', Buffer.from(`sharesecure relay ${me.id} ${m.nonce}`), { key: me.privateKey, dsaEncoding: 'ieee-p1363' });
        json({ t: 'hello', key: b64url(me.raw), sig: b64url(sig) });
      } else if (m.t === 'ready') {
        wait = 1000;
        if (!announced) console.log(`  Public links →  ${publicBase(me.id)}/r/…  (through ShareSecure's relay; this computer's address stays private)`);
        else console.log('  [relay] Connected again.');
        announced = true;
      } else if (m.t === 'req') {
        answer(m);
      } else if (m.t === 'ack') {
        const credit = credits.get(m.id);
        if (credit) { credit.free++; credit.wake?.(); credit.wake = null; }
      }
    });
    const lost = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      for (const credit of credits.values()) credit.wake?.();
      retry();
    };
    ws.addEventListener('close', lost);
    ws.addEventListener('error', lost);
  };

  const retry = () => {
    const t = setTimeout(connect, wait);
    t.unref?.();
    wait = Math.min(wait * 2, MAX_WAIT);
  };

  connect();
}

function frame(id, bytes) {
  const out = Buffer.allocUnsafe(4 + bytes.length);
  out.writeUInt32BE(id >>> 0, 0);
  bytes.copy(out, 4);
  return out;
}

module.exports = { start, identity, publicBase, relayBase, allowed };
