// Local adversarial tests: real Pages handlers and SQL, synthetic users/files.
// No request is allowed to reach the network or a production database.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sharesecure-audit-'));
fs.writeFileSync(path.join(temp, 'package.json'), '{"type":"module","version":"0.0.0-test"}');
fs.cpSync(path.join(root, 'functions'), path.join(temp, 'functions'), { recursive: true });
// the API shares a few modules with the browser
fs.mkdirSync(path.join(temp, 'public'));
for (const f of ['sealed.js', 'filetypes.js', 'opaque.js', 'p256.js', 'blindrsa.js']) fs.copyFileSync(path.join(root, 'public', f), path.join(temp, 'public', f));
// Cloudflare's bundler reads package.json on its own; Node needs to be told it's JSON
for (const f of ['_mcp.js']) {
  const p = path.join(temp, 'functions', f);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/from '\.\.\/package\.json';/, "from '../package.json' with { type: 'json' };"));
}
const load = file => import(pathToFileURL(path.join(temp, 'functions', file)).href);
const sealedLib = () => import(pathToFileURL(path.join(temp, 'public', 'sealed.js')).href);
const publicLib = file => import(pathToFileURL(path.join(temp, 'public', file)).href);
const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(path.join(root, 'db/schema.sql'), 'utf8'));
db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, access_code TEXT)');
db.exec("INSERT INTO users (id, username, access_code) VALUES (1, 'alice', 'test'), (2, 'bob', 'test'), (3, 'mallory', 'test')");
// a throwaway RSA key for the anonymous-token tests
const issuerKey = require('node:crypto').generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const env = { TURSO_URL: 'https://audit.invalid', TURSO_TOKEN: 'test-only', TOKEN_SECRET: 'test-only-signing-secret', TAG_SECRET: 'test-only-tag-secret', ENCRYPTION_KEY: '42'.repeat(32), TOKEN_ISSUER_KEY: issuerKey };
const realFetch = global.fetch;
global.fetch = async (url, options) => {
  assert.equal(String(url), 'https://audit.invalid/v2/pipeline', 'Unexpected network request blocked');
  const stmt = JSON.parse(options.body).requests[0].stmt;
  const args = stmt.args.map(a => a.type === 'null' ? null : a.type === 'text' ? a.value : Number(a.value));
  try {
    const query = db.prepare(stmt.sql);
    const rows = query.all(...args);
    const cols = query.columns().map(c => ({ name: c.name }));
    const typed = v => v === null ? { type: 'null' } : { type: typeof v === 'number' ? 'integer' : 'text', value: String(v) };
    return Response.json({ results: [{ type: 'ok', response: { result: { cols, rows: rows.map(r => cols.map(c => typed(r[c.name]))), affected_row_count: db.prepare('SELECT changes() n').get().n } } }] });
  } catch (error) {
    return Response.json({ results: [{ type: 'error', error: { message: error.message } }] });
  }
};
let api, mcp, uploadHandler, sendHandler, inboxHandler, rawHandler, infoHandler, reshareHandler, keysApi, sealed;
const tokens = {};
// each test starts with a fresh daily upload limit
const freshDay = () => db.exec("UPDATE files SET uploaded_at = '2000-01-01 00:00:00'");
const keyPairs = {};   // test users' end-to-end key pairs (alice and bob have one, mallory doesn't)
let rpcId = 0;
function context(url, { user = 'alice', method = 'POST', body, headers = {}, params = {} } = {}) {
  const request = new Request('https://sharesecure.test' + url, { method, headers: { ...(user ? { Authorization: 'Bearer ' + tokens[user] } : {}), ...headers }, ...(body === undefined ? {} : { body }) });
  return { env, request, params, waitUntil: promise => promise.catch(() => {}) };
}
async function rpc(token, name, args = {}) {
  const ctx = context('/mcp', { user: null, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
  return (await (await mcp.handleMcp(ctx)).json()).result;
}
async function upload(name = 'report.txt', text = 'Synthetic audit document', user = 'alice') {
  const form = new FormData(); form.set('file', new File([text], name)); form.set('expires_hours', '24'); form.set('allow_download', '1');
  const response = await uploadHandler(context('/api/upload', { user, body: form }));
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function send(id, recipient, ownerKey, user = 'alice') {
  return sendHandler(context('/api/send/' + id, { user, params: { shortId: id }, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetUsername: recipient, deleteToken: ownerKey }) }));
}
before(async () => {
  api = await load('_turso.js'); mcp = await load('_mcp.js');
  uploadHandler = (await load('api/upload.js')).onRequestPost;
  sendHandler = (await load('api/send/[shortId].js')).onRequestPost;
  inboxHandler = (await load('api/inbox/[shortId].js')).onRequestPost;
  rawHandler = (await load('api/raw/[shortId].js')).onRequestGet;
  infoHandler = (await load('api/info/[shortId].js')).onRequestGet;
  reshareHandler = (await load('api/reshare/[shortId].js')).onRequestPost;
  keysApi = await load('api/keys/index.js');
  sealed = await sealedLib();
  for (const [i, username] of ['alice', 'bob', 'mallory'].entries()) tokens[username] = await api.signToken({ userId: i + 1, username }, env);
  for (const username of ['alice', 'bob']) {
    keyPairs[username] = await sealed.makeKeyPair();
    const res = await keysApi.onRequestPost(context('/api/keys', { user: username, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_key: keyPairs[username].publicKey, private_key_box: await sealed.lockPrivateKey(keyPairs[username].privateKey, sealed.newFileKey()) }) }));
    assert.equal(res.status, 200, await res.clone().text());
  }
});
after(() => {
  global.fetch = realFetch; db.close();
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
  assert(path.basename(temp).startsWith('sharesecure-audit-'));
  fs.rmSync(temp, { recursive: true, force: true });
});

test('username send: ownership, acceptance, recipient-only bytes/metadata, no public reshare', async () => {
  const share = await upload();
  assert.equal((await send(share.shortId, 'bob', null, 'mallory')).status, 403);
  assert.equal((await send(share.shortId, '@BOB', share.deleteToken)).status, 200);
  const copy = db.prepare("SELECT * FROM files WHERE inbox_status = 'pending'").get();
  assert(copy); assert.equal(copy.require_account, 1);
  const view = user => context('/api/raw/' + copy.short_id, { user, method: 'GET', params: { shortId: copy.short_id } });
  assert.equal((await rawHandler(view('bob'))).status, 404);
  const decision = user => context('/api/inbox/' + copy.short_id, { user, params: { shortId: copy.short_id }, headers: { 'Content-Type': 'application/json' }, body: '{"action":"accept"}' });
  assert.equal((await inboxHandler(decision('mallory'))).status, 404);
  assert.equal((await inboxHandler(decision('bob'))).status, 200);
  assert.equal((await rawHandler(view(null))).status, 401);
  assert.equal((await rawHandler(view('mallory'))).status, 403);
  assert.equal((await infoHandler(view('mallory'))).status, 403);
  assert.equal(await (await rawHandler(view('bob'))).text(), 'Synthetic audit document');
  assert.equal((await reshareHandler(view('bob'))).status, 403);
  // Legacy recipient copies must be protected even if require_account was 0.
  db.prepare('UPDATE files SET require_account = 0 WHERE short_id = ?').run(copy.short_id);
  assert.equal((await rawHandler(view('mallory'))).status, 403);
  // The separately created share link still works without a recipient account.
  assert.equal((await rawHandler(context('/api/raw/' + share.shortId, { user: null, method: 'GET', params: { shortId: share.shortId } }))).status, 200);
});

test('MCP generated text is shared end to end and delivered without manual user steps', async () => {
  freshDay();
  const token = await mcp.createToken(1, env);
  const out = await rpc(token, 'share_text', { title: 'Agent report', text: 'Generated by a test agent', note: 'for bob', send_to: ['bob', 'mallory'] });
  assert(!out.isError, JSON.stringify(out));
  assert.match(out.content[0].text, /Sent to: bob/);
  // mallory has no key yet, so she can't get a private copy, and is told why
  assert.match(out.content[0].text, /Not sent: mallory \(They haven’t signed in/);
  const data = out.structuredContent;
  assert.equal(data.private, true);
  assert.match(data.url, /^https:\/\/sharesecure.test\/r\/[A-Za-z0-9]+#k=[A-Za-z0-9_-]{43}$/);

  // nothing the server stored can be read without the key in the link
  const row = db.prepare('SELECT * FROM files WHERE short_id = ?').get(data.id);
  const stored = JSON.stringify(db.prepare('SELECT * FROM files').all());
  assert(!stored.includes('Agent report') && !stored.includes('for bob'));
  assert(!stored.includes(Buffer.from('Generated by a test agent').toString('base64').slice(0, 20)));
  assert.equal(row.e2e, 1);
  const key = sealed.keyFromLink(data.url);
  const raw = await rawHandler(context('/api/raw/' + data.id, { user: null, method: 'GET', params: { shortId: data.id } }));
  assert.equal(new TextDecoder().decode(await sealed.unlockFile(key, new Uint8Array(await raw.arrayBuffer()))), 'Generated by a test agent');

  // alice can rebuild the link from her own sealed copy of the key
  assert.deepEqual(await sealed.openKey(keyPairs.alice.privateKey, row.owner_key), key);
  // bob opens his copy with his private key; the note is sealed too
  const inbox = await (await (await load('api/inbox/index.js')).onRequestGet(context('/api/inbox', { user: 'bob', method: 'GET' }))).json();
  const mine = inbox.files.find(f => f.e2e && f.inbox_key);
  const bobKey = await sealed.openKey(keyPairs.bob.privateKey, mine.inbox_key);
  assert.equal((await sealed.unlockMeta(bobKey, mine.original_filename)).name, 'Agent report.md');
  assert.equal(await sealed.unlockText(bobKey, mine.note, 'note'), 'for bob');
  await assert.rejects(sealed.openKey(keyPairs.alice.privateKey, mine.inbox_key));
});

test('MCP send_share needs the whole link for a private share, and checks its key', async () => {
  freshDay();
  const token = await mcp.createToken(1, env);
  const made = (await rpc(token, 'share_text', { title: 'Later', text: 'Send me later' })).structuredContent;
  const noKey = await rpc(token, 'send_share', { id: made.id, send_to: ['bob'] });
  assert(noKey.isError); assert.match(noKey.content[0].text, /part after #/);
  const wrong = await rpc(token, 'send_share', { link: made.url.replace(/#k=.*/, '#k=' + 'A'.repeat(43)), send_to: ['bob'] });
  assert(wrong.isError); assert.match(wrong.content[0].text, /doesn’t open/);
  const ok = await rpc(token, 'send_share', { link: made.url, send_to: ['bob'] });
  assert(!ok.isError, JSON.stringify(ok)); assert.deepEqual(ok.structuredContent.sent_to, ['bob']);
  // list_shares can't show a private share's key or name, because the server has neither
  const list = await rpc(token, 'list_shares');
  const listed = list.structuredContent.shares.find(s => s.id === made.id);
  assert.equal(listed.private, true); assert.equal(listed.name, null); assert(!listed.url.includes('#'));
  // and private: false still makes a normal share
  const open = (await rpc(token, 'share_text', { title: 'Open', text: 'Readable', private: false })).structuredContent;
  assert.equal(open.private, false); assert(!open.url.includes('#'));
});

test('MCP generated binary: agent receives command, uploads exact bytes, polls receipt; replay is denied', async () => {
  freshDay();
  const token = await mcp.createToken(1, env);
  const out = await rpc(token, 'share_file', { path: '/mnt/data/generated.pdf', send_to: ['bob'] });
  assert(!out.isError, JSON.stringify(out));
  const text = out.content[0].text;
  assert.doesNotMatch(text, /\/drop\//);
  const url = text.match(/https:\/\/sharesecure.test\/api\/mcp\/upload\/([A-Za-z0-9]+)/);
  assert(url, text);
  const ticketId = text.match(/ticket_id "([A-Za-z0-9]+)"/)[1];
  const bytes = '%PDF-1.4\n% synthetic audit fixture\n%%EOF';
  const form = new FormData();form.set('file', new File([bytes], 'generated.pdf'));
  const redeemed = await mcp.redeemTicket(url[1], context('/api/mcp/upload/' + url[1], { user: null, body: form }));
  assert.equal(redeemed.status, 200, await redeemed.clone().text());
  const data = await redeemed.json();assert.deepEqual(data.sent_to, ['bob']);
  const response = await rawHandler(context('/api/raw/' + data.id, { user: null, method: 'GET', params: { shortId: data.id } }));
  const opened = await sealed.unlockFile(sealed.keyFromLink(data.url), new Uint8Array(await response.arrayBuffer()));
  assert.equal(new TextDecoder().decode(opened), bytes);
  const status = await rpc(token, 'upload_status', { ticket_id: ticketId });assert.match(status.content[0].text, /Upload complete/);
  // the kept result never includes the link's key
  assert(!status.content[0].text.includes('#k='));
  assert.equal((await mcp.redeemTicket(url[1], context('/api/mcp/upload/' + url[1], { user: null, body: form }))).status, 410);
});

test('revoking an MCP token also revokes its pending upload tickets', async () => {
  const token = await mcp.createToken(3, env);
  const out = await rpc(token, 'share_file', { path: '/mnt/data/revoked.pdf' });
  const ticket = out.content[0].text.match(/\/api\/mcp\/upload\/([A-Za-z0-9]+)/)[1];
  await mcp.revokeToken(3, env);
  const form = new FormData();form.set('file',new File(['%PDF-1.4'], 'revoked.pdf'));
  assert.equal((await mcp.redeemTicket(ticket,context('/api/mcp/upload/' + ticket,{user:null,body:form}))).status,410);
  assert.equal(await mcp.userForToken('Bearer ' + token,env),null);
});

test('MCP refuses cross-origin calls and oversized bodies', async () => {
  const token = await mcp.createToken(3,env);
  const badOrigin = context('/mcp',{user:null,headers:{Origin:'https://attacker.invalid',Authorization:'Bearer '+token},body:'{}'});
  assert.equal((await mcp.handleMcp(badOrigin)).status,403);
  const huge = context('/mcp',{user:null,headers:{Authorization:'Bearer '+token},body:' '.repeat(4*1024*1024+1)});
  assert.equal((await mcp.handleMcp(huge)).status,413);
});

test('MCP refuses private URL literals and unsafe schemes before networking',async()=>{
  for(const url of ['http://example.com/file','https://127.0.0.1/file','https://[::1]/file','https://localhost/file','https://service.internal/file','https://example.com:8443/file','https://user:password@example.com/file']) {
    assert((await mcp.fetchFile(url,context('/mcp'))).error,url);
  }
});

test('branches: deleting a reshared link removes its onward links, never the original', async () => {
  freshDay();
  const deleteHandler = (await load('api/delete/[shortId].js')).onRequestPost;
  const call = (handler, id, init = {}) => handler(context('/api/x/' + id, { user: null, params: { shortId: id }, headers: { 'Content-Type': 'application/json' }, ...init }));
  const alive = async id => (await infoHandler(context('/api/info/' + id, { user: null, method: 'GET', params: { shortId: id } }))).status === 200;
  const a = await upload('tree.txt', 'Branch audit');
  const b = await (await call(reshareHandler, a.shortId, { body: '{}' })).json();   // B opens A's link
  const c = await (await call(reshareHandler, b.shortId, { body: '{}' })).json();   // C opens B's link
  const d = await (await call(reshareHandler, a.shortId, { body: '{}' })).json();   // D opens A's link
  // untraceable: nothing in B's or C's row names the link it came from
  for (const [row, parents] of [[b, [a]], [c, [a, b]]]) {
    const stored = JSON.stringify(db.prepare('SELECT * FROM files WHERE short_id = ?').get(row.shortId));
    for (const p of parents) assert(!stored.includes(p.shortId), `${row.shortId}'s row mentions ${p.shortId}`);
  }
  const del = await call(deleteHandler, b.shortId, { body: JSON.stringify({ deleteToken: b.deleteToken }) });
  assert.equal(del.status, 200, await del.clone().text());
  assert.deepEqual([await alive(a.shortId), await alive(b.shortId), await alive(c.shortId), await alive(d.shortId)], [true, false, false, true]);
  // D's view still reads the original's bytes
  assert.equal(await (await rawHandler(context('/api/raw/' + d.shortId, { user: null, method: 'GET', params: { shortId: d.shortId } }))).text(), 'Branch audit');
  // deleting the original removes every link
  await call(deleteHandler, a.shortId, { body: JSON.stringify({ deleteToken: a.deleteToken }) });
  assert.deepEqual([await alive(a.shortId), await alive(d.shortId)], [false, false]);

  // a copy sent to someone is a branch too: the sender deleting withdraws it
  const e = await upload('sent.txt', 'Sent audit');
  assert.equal((await send(e.shortId, 'bob', e.deleteToken)).status, 200);
  const copy = db.prepare("SELECT short_id FROM files WHERE inbox_status = 'pending' ORDER BY rowid DESC").get();
  assert(!JSON.stringify(db.prepare('SELECT * FROM files WHERE short_id = ?').get(copy.short_id)).includes(e.shortId));
  await call(deleteHandler, e.shortId, { body: JSON.stringify({ deleteToken: e.deleteToken }) });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM files WHERE short_id = ?').get(copy.short_id).n, 0);
});

test('sealed boxes: right key opens, anything else fails', async () => {
  const key = sealed.newFileKey();
  const box = await sealed.lock(key, new TextEncoder().encode('secret'), 'file');
  assert.equal(new TextDecoder().decode(await sealed.unlock(key, box, 'file')), 'secret');
  await assert.rejects(sealed.unlock(sealed.newFileKey(), box, 'file'));    // wrong key
  await assert.rejects(sealed.unlock(key, box, 'meta'));                    // box moved to another slot
  const tampered = box.slice(); tampered[tampered.length - 1] ^= 1;
  await assert.rejects(sealed.unlock(key, tampered, 'file'));               // changed on the way
  // a locked private key only opens with its password
  const exportKey = sealed.newFileKey();
  const locked = await sealed.lockPrivateKey(keyPairs.bob.privateKey, exportKey);
  await assert.rejects(sealed.unlockPrivateKey(locked, sealed.newFileKey()));
  const bobAgain = await sealed.unlockPrivateKey(locked, exportKey);
  assert.deepEqual(await sealed.openKey(bobAgain, await sealed.sealKey(keyPairs.bob.publicKey, key)), key);
  // two seals of the same key share nothing that links them
  const [s1, s2] = [await sealed.sealKey(keyPairs.bob.publicKey, key), await sealed.sealKey(keyPairs.bob.publicKey, key)];
  assert.notEqual(s1.slice(4, 40), s2.slice(4, 40));
  // keys in links
  const link = sealed.linkWithKey('https://x.test/r/abc', key);
  assert.deepEqual(sealed.keyFromLink(link), key);
  assert.equal(sealed.keyFromLink('https://x.test/r/abc'), null);
});

test('keys: set once per account, public halves can be looked up', async () => {
  const again = await keysApi.onRequestPost(context('/api/keys', { user: 'bob', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ public_key: keyPairs.alice.publicKey, private_key_box: 'e2e:AAAA' }) }));
  assert.equal(again.status, 409);   // nobody can swap in their own key to receive bob's files
  const bad = await keysApi.onRequestPost(context('/api/keys', { user: 'mallory', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ public_key: 'not-a-key', private_key_box: 'e2e:AAAA' }) }));
  assert.equal(bad.status, 400);
  const look = await (await keysApi.onRequestGet(context('/api/keys?username=BOB', { user: 'mallory', method: 'GET' }))).json();
  assert.equal(look.publicKey, keyPairs.bob.publicKey);
  // looking up someone's public key needs no sign-in (so it can't say who's about to send)
  assert.equal((await keysApi.onRequestGet(context('/api/keys?username=bob', { user: null, method: 'GET' }))).status, 200);
  assert.equal((await keysApi.onRequestGet(context('/api/keys', { user: null, method: 'GET' }))).status, 401);
});

test('browser end-to-end upload: server stores and passes on only sealed data', async () => {
  freshDay();
  // what public/app.js does before uploading
  const key = sealed.newFileKey();
  const plain = new TextEncoder().encode('%PDF-1.4\n% e2e fixture\n%%EOF');
  const form = new FormData();
  form.set('file', new File([await sealed.lockFile(key, plain)], 'sealed.bin'));
  form.set('e2e', '1'); form.set('expires_hours', '24'); form.set('allow_annotations', '1');
  form.set('meta', await sealed.lockMeta(key, { name: 'Contract.pdf', type: 'application/pdf' }));
  form.set('owner_key', await sealed.sealKey(keyPairs.alice.publicKey, key));
  const res = await uploadHandler(context('/api/upload', { body: form }));
  assert.equal(res.status, 200, await res.clone().text());
  const share = await res.json();
  assert.equal(share.size, sealed.paddedSize(plain.length));   // only the padded size is visible

  const view = (id, user = null) => context('/api/x/' + id, { user, method: 'GET', params: { shortId: id } });
  const info = await (await infoHandler(view(share.shortId))).json();
  assert.equal(info.e2e, true); assert.equal(info.mimeType, null);
  assert.equal((await sealed.unlockMeta(key, info.filename)).name, 'Contract.pdf');
  const raw = await rawHandler(view(share.shortId));
  assert.equal(raw.headers.get('Content-Type'), 'application/octet-stream');
  assert.deepEqual(await sealed.unlockFile(key, new Uint8Array(await raw.arrayBuffer())), plain);
  assert(!JSON.stringify(db.prepare('SELECT * FROM files WHERE short_id = ?').get(share.shortId)).includes('Contract'));

  // a reshare keeps working with the same key
  const re = await (await reshareHandler(context('/api/reshare/' + share.shortId, { user: null, params: { shortId: share.shortId }, body: '{}' }))).json();
  assert.equal(re.e2e, true);
  assert.equal((await sealed.unlockMeta(key, (await (await infoHandler(view(re.shortId))).json()).filename)).name, 'Contract.pdf');

  // sending it needs the key sealed to the recipient; the server can't make that itself
  const sendBody = extra => context('/api/send/' + share.shortId, { params: { shortId: share.shortId }, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetUsername: 'bob', deleteToken: share.deleteToken, ...extra }) });
  assert.equal((await sendHandler(sendBody({}))).status, 400);
  assert.equal((await sendHandler(sendBody({ sealed_key: await sealed.sealKey(keyPairs.bob.publicKey, key) }))).status, 200);

  // drawings on it are sealed too: plain strokes are refused
  const annotations = (await load('api/annotations/[shortId].js'));
  const draw = body => annotations.onRequestPost(context('/api/annotations/' + share.shortId, { user: null, params: { shortId: share.shortId },
    headers: { 'Content-Type': 'application/json', 'X-Delete-Token': share.deleteToken }, body: JSON.stringify(body) }));
  assert.equal((await draw({ annotations: [] })).status, 400);
  const drawing = await sealed.lockText(key, '[{"page":1}]', 'drawing');
  assert.equal((await draw({ sealed: drawing })).status, 200);
  const back = await (await annotations.onRequestGet(context('/api/annotations/' + share.shortId, { user: null, method: 'GET', params: { shortId: share.shortId },
    headers: { 'X-Delete-Token': share.deleteToken } }))).json();
  assert.equal(await sealed.unlockText(key, back.sealed, 'drawing'), '[{"page":1}]');

  // an upload that claims to be sealed but isn't is refused
  const fake = new FormData();
  fake.set('file', new File(['hello'], 'x.bin')); fake.set('e2e', '1'); fake.set('meta', 'plain name');
  assert.equal((await uploadHandler(context('/api/upload', { body: fake }))).status, 400);
});

// ── sign-in where the server never sees the password (OPAQUE) ────────────────
// The browser's code (public/opaque.js) talks to the real handlers.
async function authPost() {
  const routes = {
    '/api/auth/register/start': (await load('api/auth/register/start.js')).onRequestPost,
    '/api/auth/register/finish': (await load('api/auth/register/finish.js')).onRequestPost,
    '/api/auth/login/start': (await load('api/auth/login/start.js')).onRequestPost,
    '/api/auth/login/finish': (await load('api/auth/login/finish.js')).onRequestPost,
    '/api/auth/login': (await load('api/auth/login.js')).onRequestPost,
    '/api/auth/upgrade/start': (await load('api/auth/upgrade/start.js')).onRequestPost,
    '/api/auth/upgrade/finish': (await load('api/auth/upgrade/finish.js')).onRequestPost,
    '/api/auth/delete-account': (await load('api/auth/delete-account.js')).onRequestPost,
  };
  const seen = [];   // every request body, to check the password never goes out
  const post = async (url, body, headers = {}) => {
    seen.push(JSON.stringify(body));
    const res = await routes[url](context(url, { user: null, headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9', ...headers }, body: JSON.stringify(body) }));
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  return { post, seen };
}

const newKeys = async exportKey => {
  const pair = await sealed.makeKeyPair();
  return { public_key: pair.publicKey, private_key_box: await sealed.lockPrivateKey(pair.privateKey, exportKey) };
};

test('OPAQUE: new accounts sign in without the password ever reaching the server', async () => {
  const opaque = await publicLib('opaque.js');
  const { post, seen } = await authPost();
  const password = 'correct horse battery staple';
  await opaque.register(post, 'carol', password, newKeys);
  const row = db.prepare("SELECT * FROM users WHERE username = 'carol'").get();
  assert.equal(row.access_code, 'opaque');
  assert(row.opaque_record && row.public_key);

  const signedIn = await opaque.signIn(post, 'Carol', password);
  assert.equal((await api.verifyToken('Bearer ' + signedIn.token, env)).username, 'carol');
  // the export key from signing in opens the private key the browser locked at sign-up
  await sealed.unlockPrivateKey(signedIn.privateKeyBox, signedIn.exportKey);
  // the password is in nothing that was sent or stored
  assert(!seen.some(body => body.includes(password)));
  assert(!JSON.stringify(db.prepare('SELECT * FROM users').all()).includes(password));

  await assert.rejects(opaque.signIn(post, 'carol', 'wrong password!!'), /Wrong username or password/);
  // a proof works once
  const proven = await opaque.prove(post, 'carol', password);
  assert.equal((await post('/api/auth/login/finish', proven.proof)).status, 200);
  assert.equal((await post('/api/auth/login/finish', proven.proof)).status, 401);
  // a tampered proof is refused
  const other = await opaque.prove(post, 'carol', password);
  assert.equal((await post('/api/auth/login/finish', { ...other.proof, client_mac: sealed.toB64url(sealed.newFileKey()) })).status, 401);
  // a name that's taken can't be registered again, in any capitalisation
  await assert.rejects(opaque.register(post, 'CAROL', 'another password'), /already exists/);
});

test('OPAQUE: older password accounts switch once, then never send the password again', async () => {
  const opaque = await publicLib('opaque.js');
  const { post } = await authPost();
  db.prepare('INSERT INTO users (username, access_code) VALUES (?, ?)').run('dave', await api.hashAccessCode('old-pass-123', env));
  const first = await opaque.signIn(post, 'dave', 'old-pass-123', newKeys);
  assert(first.token && first.privateKeyBox);
  await sealed.unlockPrivateKey(first.privateKeyBox, first.exportKey);
  assert.equal(db.prepare("SELECT access_code FROM users WHERE username = 'dave'").get().access_code, 'opaque');
  // the old way is closed for this account now
  const old = await post('/api/auth/login', { username: 'dave', access_code: 'old-pass-123' });
  assert.equal(old.status, 401); assert.equal(old.data.code, 'opaque_only');
  // deleting the account takes a fresh proof, not the password, and only the
  // account's own proof
  const carol = await opaque.prove(post, 'carol', 'correct horse battery staple');
  assert.equal((await post('/api/auth/delete-account', carol.proof, { Authorization: 'Bearer ' + first.token })).status, 403);
  const proven = await opaque.prove(post, 'dave', 'old-pass-123');
  const del = await post('/api/auth/delete-account', proven.proof, { Authorization: 'Bearer ' + first.token });
  assert.equal(del.status, 200, JSON.stringify(del.data));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE username = 'dave'").get().n, 0);
});

// ── anonymous tokens (blind RSA) ─────────────────────────────────────────────
test('blind RSA matches the RFC 9474 test vector', async () => {
  const brsa = await publicLib('blindrsa.js');
  const tokens = await load('_tokens.js');
  const hex = s => Uint8Array.from(Buffer.from(s, 'hex'));
  const big = s => BigInt('0x' + s);
  const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'rfc9474-vector.json'), 'utf8'));
  const [p, q, n, e, d] = [v.p, v.q, v.n, v.e, v.d].map(big);
  const b64 = x => Buffer.from(brsa.intToBytes(x, Math.ceil(x.toString(16).length / 2))).toString('base64url');
  const key = await brsa.issuerKey({ n: b64(n), e: b64(e) });
  const msg = hex(v.msg);
  assert.deepEqual(await brsa.emsaPssEncode(msg, key.bits, hex(v.salt)), hex(v.encoded_msg));
  const { blinded, inv } = await brsa.blind(key, msg, { salt: hex(v.salt), r: brsa.invMod(big(v.inv), n) });
  assert.deepEqual(blinded, hex(v.blinded_msg));
  const server = { n, e, p, q, dp: d % (p - 1n), dq: d % (q - 1n), qi: brsa.invMod(q, p), size: key.size };
  const blindSig = tokens.blindSign(server, blinded);
  assert.deepEqual(blindSig, hex(v.blind_sig));
  assert.deepEqual(await brsa.finalize(key, msg, blindSig, inv), hex(v.sig));
});

test('tokens: anonymous uploads and sends, each token once, within the daily limit', async () => {
  freshDay();
  const brsa = await publicLib('blindrsa.js');
  const tokensApi = await load('api/tokens.js');
  const info = await (await tokensApi.onRequestGet(context('/api/tokens', { user: 'bob', method: 'GET' }))).json();
  assert.equal(info.available, true);
  const key = await brsa.issuerKey(info.publicKey);
  const getToken = async kind => {
    const nonce = sealed.newFileKey();
    const msg = brsa.tokenMessage(kind, info.day, info.keyId, nonce);
    const { blinded, inv } = await brsa.blind(key, msg);
    const res = await tokensApi.onRequestPost(context('/api/tokens', { user: 'bob', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, blinded: sealed.toB64url(blinded) }) }));
    if (res.status !== 200) return { status: res.status };
    const sig = await brsa.finalize(key, msg, sealed.fromB64url((await res.json()).signature), inv);
    return `${kind}.${info.day}.${sealed.toB64url(nonce)}.${sealed.toB64url(sig)}`;
  };

  // an upload with a token and no sign-in: the row says nothing about bob
  const fileKey = sealed.newFileKey();
  const sealedForm = async () => {
    const form = new FormData();
    form.set('file', new File([await sealed.lockFile(fileKey, new TextEncoder().encode('anonymous file'))], 'sealed.bin'));
    form.set('e2e', '1'); form.set('expires_hours', '24');
    form.set('meta', await sealed.lockMeta(fileKey, { name: 'anon.txt', type: 'text/plain' }));
    return form;
  };
  const token = await getToken('upload');
  const up = await uploadHandler(context('/api/upload', { user: null, headers: { 'X-ShareSecure-Token': token }, body: await sealedForm() }));
  assert.equal(up.status, 200, await up.clone().text());
  const share = await up.json();
  assert.equal(share.anonymous, true);
  const row = db.prepare('SELECT user_tag, user_id FROM files WHERE short_id = ?').get(share.shortId);
  assert.equal(row.user_tag, null); assert.equal(row.user_id, null);
  // spent tokens and made-up tokens don't work
  assert.equal((await uploadHandler(context('/api/upload', { user: null, headers: { 'X-ShareSecure-Token': token }, body: await sealedForm() }))).status, 401);
  const forged = token.replace(/\.[^.]+$/, '.' + sealed.toB64url(new Uint8Array(256)));
  assert.equal((await uploadHandler(context('/api/upload', { user: null, headers: { 'X-ShareSecure-Token': forged }, body: await sealedForm() }))).status, 401);
  // an upload token can't be spent as a send token
  const send = headers => sendHandler(context('/api/send/' + share.shortId, { user: null, params: { shortId: share.shortId }, headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ targetUsername: 'alice', deleteToken: share.deleteToken, sealed_key: 'e2e:AAAA' }) }));
  assert.equal((await send({ 'X-ShareSecure-Token': await getToken('upload') })).status, 401);
  // a send token sends it without saying who sent it
  const sent = await send({ 'X-ShareSecure-Token': await getToken('send') });
  assert.equal(sent.status, 200, await sent.clone().text());
  assert.equal(db.prepare("SELECT sender_tag FROM files WHERE inbox_status = 'pending' ORDER BY rowid DESC").get().sender_tag, null);

  // five uploads a day in all: two upload tokens so far, then three more, then no more
  assert.equal(typeof await getToken('upload'), 'string');
  assert.equal(typeof await getToken('upload'), 'string');
  assert.equal(typeof await getToken('upload'), 'string');
  assert.equal((await getToken('upload')).status, 429);
  // and the signed-in way counts the tokens too
  const form = new FormData(); form.set('file', new File(['x'], 'x.txt')); form.set('expires_hours', '1');
  assert.equal((await uploadHandler(context('/api/upload', { user: 'bob', body: form }))).status, 429);
});

test('vault, padding, passcodes and security codes', async () => {
  const vaultApi = await load('api/vault.js');
  const put = await vaultApi.onRequestPut(context('/api/vault', { user: 'bob', method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vault: 'e2e:sealed-list' }) }));
  assert.equal(put.status, 200);
  assert.equal((await (await vaultApi.onRequestGet(context('/api/vault', { user: 'bob', method: 'GET' }))).json()).vault, 'e2e:sealed-list');
  assert.equal((await (await vaultApi.onRequestGet(context('/api/vault', { user: 'alice', method: 'GET' }))).json()).vault, null);
  assert.equal((await vaultApi.onRequestPut(context('/api/vault', { user: 'bob', method: 'PUT', body: JSON.stringify({ vault: 'plain' }) }))).status, 400);

  // sizes only show which bucket a file is in
  assert.equal(sealed.paddedSize(1), 1024);
  assert.equal(sealed.paddedSize(1021), 2048);
  assert.equal(sealed.paddedSize(5 * 1024 * 1024), 8 * 1024 * 1024);
  const key = sealed.newFileKey();
  const box = await sealed.lockFile(key, new Uint8Array(3000).fill(7));
  assert.equal(box.length, 4096 + sealed.BOX_OVERHEAD);
  assert.deepEqual(await sealed.unlockFile(key, box), new Uint8Array(3000).fill(7));

  // a passcode changes the key; the right passcode gives the same key again
  const salt = sealed.newPasscodeSalt();
  const a = await sealed.passcodeKey(key, 'tulip', salt);
  assert.deepEqual(await sealed.passcodeKey(key, 'tulip', salt), a);
  assert.notDeepEqual(await sealed.passcodeKey(key, 'tulips', salt), a);
  assert.notDeepEqual(a, key);
  // security codes are 6 groups of 5 digits, the same for the same key
  assert.match(await sealed.fingerprint(keyPairs.bob.publicKey), /^(\d{5} ){5}\d{5}$/);
  assert.equal(await sealed.fingerprint(keyPairs.bob.publicKey), await sealed.fingerprint(keyPairs.bob.publicKey));
  assert.notEqual(await sealed.fingerprint(keyPairs.bob.publicKey), await sealed.fingerprint(keyPairs.alice.publicKey));
});

test('hash-to-curve matches the RFC 9380 test vectors (P256_XMD:SHA-256_SSWU_RO_)', async () => {
  const p256 = await publicLib('p256.js');
  const dst = 'QUUX-V01-CS02-with-P256_XMD:SHA-256_SSWU_RO_';
  const vectors = [
    ['', '2c15230b26dbc6fc9a37051158c95b79656e17a1a920b11394ca91c44247d3e4', '8a7a74985cc5c776cdfe4b1f19884970453912e9d31528c060be9ab5c43e8415'],
    ['abc', '0bb8b87485551aa43ed54f009230450b492fead5f1cc91658775dac4a3388a0f', '5c41b3d0731a27a7b14bc0bf0ccded2d8751f83493404c84a88e71ffd424212e'],
  ];
  for (const [msg, x, y] of vectors) {
    const P = await p256.hashToCurve(msg, dst);
    assert.equal(P.x.toString(16).padStart(64, '0'), x);
    assert.equal(P.y.toString(16).padStart(64, '0'), y);
  }
  // and the curve maths agrees with WebCrypto's ECDH
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const d = p256.bytesToBig(Buffer.from((await crypto.subtle.exportKey('jwk', pair.privateKey)).d, 'base64url'));
  const H = await p256.hashToCurve('x', 'test');
  const pub = await crypto.subtle.importKey('raw', p256.encodePoint(H), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, pair.privateKey, 256));
  assert.equal(p256.bytesToBig(shared), p256.multiply(H, d).x);
});
