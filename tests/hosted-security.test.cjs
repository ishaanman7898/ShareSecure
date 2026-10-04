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
for (const f of ['sealed.js', 'filetypes.js', 'opaque.js', 'p256.js', 'blindrsa.js', 'tokens.js']) fs.copyFileSync(path.join(root, 'public', f), path.join(temp, 'public', f));
// Cloudflare's bundler reads package.json on its own; Node needs to be told it's JSON
for (const f of ['_mcp.js']) {
  const p = path.join(temp, 'functions', f);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/from '\.\.\/package\.json';/, "from '../package.json' with { type: 'json' };"));
}
// the local MCP package, with the website's encryption code beside it as npm ships it
fs.cpSync(path.join(root, 'packages', 'sharesecure-mcp', 'src'), path.join(temp, 'pkg', 'src'), { recursive: true });
fs.mkdirSync(path.join(temp, 'pkg', 'lib'));
for (const f of ['sealed.js', 'opaque.js', 'p256.js', 'filetypes.js']) fs.copyFileSync(path.join(root, 'public', f), path.join(temp, 'pkg', 'lib', f));
fs.writeFileSync(path.join(temp, 'pkg', 'package.json'), '{"type":"module"}');
const pkgLib = file => import(pathToFileURL(path.join(temp, 'pkg', 'src', file)).href);
const load = file => import(pathToFileURL(path.join(temp, 'functions', file)).href);
const sealedLib = () => import(pathToFileURL(path.join(temp, 'public', 'sealed.js')).href);
const publicLib = file => import(pathToFileURL(path.join(temp, 'public', file)).href);
const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(path.join(root, 'db/schema.sql'), 'utf8'));
db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, access_code TEXT)');
db.exec("INSERT INTO users (id, username, access_code) VALUES (1, 'alice', 'test'), (2, 'bob', 'test'), (3, 'mallory', 'test'), (4, 'zoe', 'test')");
// a throwaway RSA key for the anonymous-token tests
const issuerKey = require('node:crypto').generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const env = { TURSO_URL: 'https://audit.invalid', TURSO_TOKEN: 'test-only', TOKEN_SECRET: 'test-only-signing-secret', TAG_SECRET: 'test-only-tag-secret', ENCRYPTION_KEY: '42'.repeat(32), TOKEN_ISSUER_KEY: issuerKey };
const realFetch = global.fetch;
const sqlFailures = [];   // { match: RegExp, times: n } makes matching statements fail
global.fetch = async (url, options) => {
  assert.equal(String(url), 'https://audit.invalid/v2/pipeline', 'Unexpected network request blocked');
  const stmt = JSON.parse(options.body).requests[0].stmt;
  const failure = sqlFailures.find(f => f.times > 0 && f.match.test(stmt.sql));
  if (failure) { failure.times--; return Response.json({ results: [{ type: 'error', error: { message: 'synthetic outage' } }] }); }
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
let api, mcp, agent, agentApi, assistantApi, requestsApi, uploadHandler, sendHandler, inboxHandler, rawHandler, infoHandler, reshareHandler, keysApi, sealed;
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
  api = await load('_turso.js'); mcp = await load('_mcp.js'); agent = await load('_agent.js');
  agentApi = (await load('api/agent/[[path]].js')).onRequest;
  assistantApi = await load('api/auth/assistant.js');
  requestsApi = (await load('api/requests/[[path]].js')).onRequest;
  uploadHandler = (await load('api/upload.js')).onRequestPost;
  sendHandler = (await load('api/send/[shortId].js')).onRequestPost;
  inboxHandler = (await load('api/inbox/[shortId].js')).onRequestPost;
  rawHandler = (await load('api/raw/[shortId].js')).onRequestGet;
  infoHandler = (await load('api/info/[shortId].js')).onRequestGet;
  reshareHandler = (await load('api/reshare/[shortId].js')).onRequestPost;
  keysApi = await load('api/keys/index.js');
  sealed = await sealedLib();
  for (const [i, username] of ['alice', 'bob', 'mallory', 'zoe'].entries()) tokens[username] = await api.signToken({ userId: i + 1, username }, env);
  for (const username of ['alice', 'bob', 'zoe']) {
    keyPairs[username] = await sealed.makeKeyPair();
    const res = await keysApi.onRequestPost(context('/api/keys', { user: username, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_key: keyPairs[username].publicKey, private_key_box: await sealed.lockPrivateKey(keyPairs[username].privateKey, sealed.newFileKey()) }) }));
    assert.equal(res.status, 200, await res.clone().text());
  }
  // alice has approved her assistants sending to bob; zoe is new to them
  await agent.setAgentRules(1, env, { mode: 'approve', allowed: ['bob'] });
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

// ── trying to break in ───────────────────────────────────────────────────────
// Each test plays an attacker with something partial (a stolen session, a link
// without its key, a forged token, a crafted path) and checks it gets nowhere.

test('attack: a stolen session cannot take over an older account', async () => {
  const opaque = await publicLib('opaque.js');
  const { post } = await authPost();
  db.prepare('INSERT INTO users (username, access_code) VALUES (?, ?)').run('erin', await api.hashAccessCode('erins-real-pass', env));
  const erin = db.prepare("SELECT id FROM users WHERE username = 'erin'").get().id;
  const stolen = { Authorization: 'Bearer ' + await api.signToken({ userId: erin, username: 'erin' }, env) };
  // the attacker makes a record from a password of their own…
  const forged = { record: { client_public_key: keyPairs.bob.publicKey, masking_key: sealed.toB64url(new Uint8Array(32)), envelope: sealed.toB64url(new Uint8Array(64)) } };
  // …but saving it needs erin's current password
  assert.equal((await post('/api/auth/upgrade/finish', forged, stolen)).status, 403);
  assert.equal((await post('/api/auth/upgrade/finish', { ...forged, access_code: 'a guess' }, stolen)).status, 403);
  assert.equal(db.prepare('SELECT opaque_record FROM users WHERE id = ?').get(erin).opaque_record, null);
  // erin herself still switches over fine
  const done = await opaque.signIn(post, 'erin', 'erins-real-pass');
  assert(done.token);
});

test('attack: an old stolen session cannot plant keys to receive someone’s files', async () => {
  db.prepare("INSERT INTO users (username, access_code) VALUES ('frank', 'opaque')").run();
  const frank = db.prepare("SELECT id FROM users WHERE username = 'frank'").get().id;
  const session = await api.signToken({ userId: frank, username: 'frank' }, env);
  const attackerKeys = await sealed.makeKeyPair();
  const plant = () => keysApi.onRequestPost(context('/api/keys', { user: null, headers: { Authorization: 'Bearer ' + session, 'Content-Type': 'application/json' },
    body: JSON.stringify({ public_key: attackerKeys.publicKey, private_key_box: 'e2e:AAAA' }) }));
  // the same session 11 minutes later, as if it had been stolen
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60 * 1000;
  try { assert.equal((await plant()).status, 401); } finally { Date.now = realNow; }
  assert.equal(db.prepare('SELECT public_key FROM users WHERE id = ?').get(frank).public_key, null);
});

test('attack: the server cannot tag people with their own token key', async () => {
  const tokens = await publicLib('tokens.js');
  const real = { n: 'AQAB' };   // any key that isn't the pinned one
  assert.equal(await tokens.trustedIssuer('https://sharesecure-du8.pages.dev', real), false);
  // a test copy of the site has no pin and uses its own key
  assert.equal(await tokens.trustedIssuer('http://127.0.0.1:8788', real), true);
  // the key is public: anyone can read and compare it, signed in or not
  const info = await (await (await load('api/tokens.js')).onRequestGet(context('/api/tokens', { user: null, method: 'GET' }))).json();
  assert(info.publicKey.n && !info.left);
});

test('attack: links, tokens and uploads without the right secret get nothing', async () => {
  freshDay();
  // a sealed upload with no sign-in and no token
  const key = sealed.newFileKey();
  const form = new FormData();
  form.set('file', new File([await sealed.lockFile(key, new TextEncoder().encode('x'))], 'sealed.bin'));
  form.set('e2e', '1'); form.set('expires_hours', '1');
  form.set('meta', await sealed.lockMeta(key, { name: 'x.txt', type: 'text/plain' }));
  assert.equal((await uploadHandler(context('/api/upload', { user: null, body: form }))).status, 401);
  // a made-up token
  const fake = `upload.${Math.floor(Date.now() / 86400000)}.${sealed.toB64url(sealed.newFileKey())}.${sealed.toB64url(new Uint8Array(256).fill(1))}`;
  assert.equal((await uploadHandler(context('/api/upload', { user: null, headers: { 'X-ShareSecure-Token': fake }, body: form }))).status, 401);

  // someone else's share: an anonymous send needs the link's delete key
  const own = await uploadHandler(context('/api/upload', { user: 'alice', body: form }));
  const share = await own.json();
  const send = sendHandler(context('/api/send/' + share.shortId, { user: 'mallory', params: { shortId: share.shortId }, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetUsername: 'bob', sealed_key: 'e2e:AAAA' }) }));
  assert.equal((await send).status, 403);
  // the stored file is a box: the wrong key opens nothing, and neither does a wrong passcode
  const raw = new Uint8Array(await (await rawHandler(context('/api/raw/' + share.shortId, { user: null, method: 'GET', params: { shortId: share.shortId } }))).arrayBuffer());
  await assert.rejects(sealed.unlockFile(sealed.newFileKey(), raw));
  const salt = sealed.newPasscodeSalt();
  await assert.rejects(sealed.unlockFile(await sealed.passcodeKey(key, 'wrong', salt), raw));
  // a name built to inject HTML or a script file comes out harmless
  const filetypes = await publicLib('filetypes.js');
  assert.equal(filetypes.nameFor('<img src=x onerror=alert(1)>.html', '', 'text/plain'), 'img src=x onerror=alert(1).txt');
  assert.equal(filetypes.nameFor('payload.hta', '', 'application/pdf'), 'payload.pdf');
});

test('attack: the desktop app never serves files from outside its own copy of the site', () => {
  const { bundledFile } = require(path.join(root, 'desktop', 'site-files.js'));
  const dir = path.join(root, 'public');
  for (const p of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/%2e%2e/Windows/win.ini', '/C:/Windows/win.ini',
    '/vendor/..%5c..%5cpackage.json', '/.git/config', '/%00index.html', '/../../server/settings.js']) {
    assert.equal(bundledFile(dir, p), null, p);
  }
  assert.equal(bundledFile(dir, '/signin'), 'signin.html');
  assert.equal(bundledFile(dir, '/vendor/pdf.min.mjs'), 'vendor/pdf.min.mjs');
  assert.equal(bundledFile(dir, '/r/abc123'), 'viewer.html');
});

// ── assistants: rules for sending, the local MCP server, and the inbox ────────

const assistantCall = (method, user, body) => context('/api/auth/assistant', { user, method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
// requests left waiting by earlier tests would hit the per-sender inbox limit
const clearRequests = () => db.exec("DELETE FROM files WHERE inbox_status = 'pending'");
const handlerFor = { GET: 'onRequestGet', PUT: 'onRequestPut', POST: 'onRequestPost' };
const assistant = async (method, user, body) => assistantApi[handlerFor[method]](assistantCall(method, user, body));

test('attack: an assistant’s send to someone new waits for the owner, and only the owner can approve it', async () => {
  freshDay(); clearRequests();
  const token = await mcp.createToken(1, env);
  const out = await rpc(token, 'share_text', { title: 'Injected', text: 'Something an injected page asked for', send_to: ['zoe', 'bob'] });
  assert(!out.isError, JSON.stringify(out));
  assert.deepEqual(out.structuredContent.sent_to, ['bob']);
  assert.deepEqual(out.structuredContent.waiting_for_approval, ['zoe']);
  assert.match(out.content[0].text, /Waiting for the user to approve/);
  const zoeInbox = async () => (await (await (await load('api/inbox/index.js')).onRequestGet(context('/api/inbox', { user: 'zoe', method: 'GET' }))).json()).files;
  assert.equal((await zoeInbox()).length, 0);

  // the same send again doesn't queue twice
  await rpc(token, 'send_share', { link: out.structuredContent.url, send_to: ['zoe'] });
  const waiting = await (await assistant('GET', 'alice')).json();
  assert.equal(waiting.waiting.length, 1);
  assert.equal(waiting.waiting[0].username, 'zoe');
  assert.equal(waiting.waiting[0].short_id, out.structuredContent.id);

  // an assistant's token isn't a session: it can't see, approve or loosen its own rules
  const asAgent = method => assistantApi[handlerFor[method]](context('/api/auth/assistant', { user: null, method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify({ id: waiting.waiting[0].id, action: 'approve', mode: 'anyone' }) }) }));
  for (const method of ['GET', 'PUT', 'POST']) assert.equal((await asAgent(method)).status, 401);
  // and nobody else's session can approve it either
  assert.equal((await assistant('POST', 'mallory', { id: waiting.waiting[0].id, action: 'approve' })).status, 404);

  const approved = await assistant('POST', 'alice', { id: waiting.waiting[0].id, action: 'approve', always: true });
  assert.equal(approved.status, 200, await approved.clone().text());
  const delivered = (await zoeInbox()).find(f => f.e2e);
  assert(delivered);
  // zoe opens it with her own key: approving didn't need or reveal the file key
  const zoeKey = await sealed.openKey(keyPairs.zoe.privateKey, delivered.inbox_key);
  assert.equal((await sealed.unlockMeta(zoeKey, delivered.original_filename)).name, 'Injected.md');
  assert.equal((await assistant('POST', 'alice', { id: waiting.waiting[0].id, action: 'approve' })).status, 404);

  // "always" put zoe on the list, so the next send goes straight to her
  const again = await rpc(token, 'share_text', { title: 'Second', text: 'Again', send_to: ['zoe'] });
  assert.deepEqual(again.structuredContent.sent_to, ['zoe']);

  // "nobody": links still work, sends are refused
  assert.equal((await assistant('PUT', 'alice', { mode: 'nobody' })).status, 200);
  const refused = await rpc(token, 'share_text', { title: 'Third', text: 'No', send_to: ['bob'] });
  assert.equal(refused.structuredContent.sent_to.length, 0);
  assert.match(refused.structuredContent.not_sent[0].reason, /doesn’t let assistants send/);

  // a declined send is gone
  await assistant('PUT', 'alice', { mode: 'approve', allowed: ['bob'] });
  const held = await rpc(token, 'share_text', { title: 'Fourth', text: 'Maybe', send_to: ['zoe'] });
  assert.deepEqual(held.structuredContent.waiting_for_approval, ['zoe']);
  const pending = (await (await assistant('GET', 'alice')).json()).waiting;
  assert.equal((await assistant('POST', 'alice', { id: pending[0].id, action: 'decline' })).status, 200);
  assert.equal((await (await assistant('GET', 'alice')).json()).waiting.length, 0);

  // replacing the token drops whatever an old token left waiting
  await rpc(token, 'share_text', { title: 'Fifth', text: 'Later', send_to: ['zoe'] });
  await mcp.createToken(1, env);
  assert.equal((await (await assistant('GET', 'alice')).json()).waiting.length, 0);
});

test('a send that hits a passing error is retried, and one that keeps failing says why', async () => {
  freshDay(); clearRequests();
  const token = await mcp.createToken(1, env);
  sqlFailures.push({ match: /INSERT INTO send_log/, times: 1 });
  const once = await rpc(token, 'share_text', { title: 'Flaky', text: 'Retried', send_to: ['bob'] });
  assert.deepEqual(once.structuredContent.sent_to, ['bob'], JSON.stringify(once));
  sqlFailures.push({ match: /INSERT INTO send_log/, times: 2 });
  const twice = await rpc(token, 'share_text', { title: 'Down', text: 'Failed', send_to: ['bob'] });
  assert.equal(twice.structuredContent.sent_to.length, 0);
  assert.match(twice.structuredContent.not_sent[0].reason, /synthetic outage/);
  // a failure after the copy was written takes the copy back, so nothing is half sent
  const before = db.prepare("SELECT COUNT(*) n FROM files WHERE inbox_status = 'pending'").get().n;
  sqlFailures.push({ match: /SUM\(CASE WHEN sender_tag/, times: 1 });
  const late = await rpc(token, 'share_text', { title: 'Late', text: 'Late failure', send_to: ['bob'] });
  assert.match(late.structuredContent.not_sent[0].reason, /nothing was sent/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM files WHERE inbox_status = 'pending'").get().n, before);
  sqlFailures.length = 0;
});

test('MCP inbox tools: list what was sent, without opening private files, and answer requests', async () => {
  freshDay(); clearRequests();
  const aliceToken = await mcp.createToken(1, env);
  const made = (await rpc(aliceToken, 'share_text', { title: 'For bob inbox', text: 'Inbox test', note: 'secret note', send_to: ['bob'] })).structuredContent;
  assert.deepEqual(made.sent_to, ['bob']);
  const bobToken = await mcp.createToken(2, env);
  const list = await rpc(bobToken, 'list_inbox');
  const row = list.structuredContent.files.find(f => f.status === 'pending' && f.private);
  assert(row);
  // the hosted server can't read a private file's name or note, so it never shows them
  assert.equal(row.name, null); assert.equal(row.note, null);
  assert(!list.content[0].text.includes('For bob inbox') && !list.content[0].text.includes('secret note'));
  assert(!JSON.stringify(list.structuredContent).includes('inbox_key'));
  const accepted = await rpc(bobToken, 'answer_request', { id: row.id, action: 'accept' });
  assert(!accepted.isError, JSON.stringify(accepted));
  // alice's token can't answer bob's requests
  assert((await rpc(aliceToken, 'answer_request', { id: row.id, action: 'decline' })).isError);
});

// The local package, talking to the real handlers through an in-process fetch.
function localFetch() {
  return async (url, init = {}) => {
    const u = new URL(url);
    const request = new Request(u.href, init);
    const ctx = { env, request, waitUntil: promise => promise.catch(() => {}) };
    if (u.pathname.startsWith('/api/agent/')) return agentApi({ ...ctx, params: { path: u.pathname.slice('/api/agent/'.length).split('/') } });
    if (u.pathname === '/api/keys') return keysApi.onRequestGet({ ...ctx, params: {} });
    throw new Error('Unexpected request ' + url);
  };
}

async function localServer(userId, username, { linked = true } = {}) {
  const { makeStore } = await pkgLib('store.js');
  const { makeApi } = await pkgLib('api.js');
  const { makeTools } = await pkgLib('tools.js');
  const dir = fs.mkdtempSync(path.join(temp, `store-${username}-`));
  const store = makeStore(dir);
  if (linked) {
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPairs[username].privateKey));
    store.saveIdentity({ url: 'https://sharesecure.test', username, publicKey: keyPairs[username].publicKey, pkcs8 });
  }
  const copied = [];
  const token = await mcp.createToken(userId, env);
  const tools = makeTools({
    api: makeApi({ url: 'https://sharesecure.test', token, fetchImpl: localFetch() }),
    store, copy: async text => { copied.push(text); return true; }, saveDir: path.join(dir, 'saved'),
  });
  return { tools, store, copied, token, dir };
}

test('local MCP: files are sealed on the computer, and the link’s key never reaches the assistant or the server', async () => {
  freshDay(); clearRequests();
  const alice = await localServer(1, 'alice');
  const secret = 'Quarterly numbers only alice and bob should see';
  const out = await alice.tools.call('share_text', { title: 'Local report', text: secret, note: 'from alice', send_to: ['bob'] });

  // the assistant gets no link and no key; the user's clipboard gets the whole link
  assert.equal(out.data.url, null);
  assert.equal(out.data.link_delivery, 'clipboard');
  assert(!JSON.stringify(out).includes('#k='));
  assert.deepEqual(out.data.sent_to, ['bob']);
  assert.equal(alice.copied.length, 1);
  const key = sealed.keyFromLink(alice.copied[0]);
  assert(key);
  assert(!JSON.stringify(out).includes(sealed.toB64url(key)));

  // the server stored only sealed data, and never got a plain file from this route
  const stored = JSON.stringify(db.prepare('SELECT * FROM files').all());
  assert(!stored.includes('Local report') && !stored.includes('from alice'));
  const raw = await rawHandler(context('/api/raw/' + out.data.id, { user: null, method: 'GET', params: { shortId: out.data.id } }));
  assert.equal(new TextDecoder().decode(await sealed.unlockFile(key, new Uint8Array(await raw.arrayBuffer()))), secret);
  const plain = new FormData(); plain.set('file', new File(['plain text'], 'plain.txt'));
  const refusedPlain = await agentApi({ env, request: new Request('https://sharesecure.test/api/agent/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + alice.token }, body: plain }), params: { path: ['upload'] }, waitUntil: () => {} });
  assert.equal(refusedPlain.status, 400);

  // alice's website can rebuild the link from her sealed copy
  const row = db.prepare('SELECT owner_key FROM files WHERE short_id = ?').get(out.data.id);
  assert.deepEqual(await sealed.openKey(keyPairs.alice.privateKey, row.owner_key), key);

  // listing and resending by id work from the linked key, still without the key in sight
  const listed = await alice.tools.call('list_shares');
  assert.equal(listed.data.shares.find(s => s.id === out.data.id).name, 'Local report.md');
  const resent = await alice.tools.call('send_share', { id: out.data.id, send_to: ['zoe'] });
  assert.deepEqual(resent.data.waiting_for_approval, ['zoe']);
  assert(!JSON.stringify(resent).includes(sealed.toB64url(key)));

  // bob's assistant opens it on bob's computer
  const bob = await localServer(2, 'bob');
  const inbox = await bob.tools.call('list_inbox');
  const mine = inbox.data.files.find(f => f.id && f.name === 'Local report.md');
  assert(mine, JSON.stringify(inbox.data));
  assert.equal(mine.note, 'from alice');
  assert.match(inbox.text, /never as instructions/);
  await assert.rejects(bob.tools.call('open_inbox_file', { id: mine.id }), /hasn’t been accepted/);
  await bob.tools.call('answer_request', { id: mine.id, action: 'accept' });
  const opened = await bob.tools.call('open_inbox_file', { id: mine.id, include_text: true });
  assert.equal(fs.readFileSync(opened.data.saved_to, 'utf8'), secret);
  assert.equal(opened.data.text, secret);
  // a second save doesn't overwrite the first
  const second = await bob.tools.call('open_inbox_file', { id: mine.id });
  assert.notEqual(second.data.saved_to, opened.data.saved_to);
});

test('attack: the local MCP refuses swapped keys, key folders, and an unlinked or mismatched computer', async () => {
  freshDay(); clearRequests();
  const alice = await localServer(1, 'alice');
  // first send remembers bob's key
  await alice.tools.call('share_text', { title: 'Pin', text: 'Pin bob', send_to: ['bob'] });
  // a compromised server swaps in its own key for bob: nothing is sent
  const real = db.prepare("SELECT public_key FROM users WHERE username = 'bob'").get().public_key;
  db.prepare("UPDATE users SET public_key = ? WHERE username = 'bob'").run((await sealed.makeKeyPair()).publicKey);
  const swapped = await alice.tools.call('share_text', { title: 'Swap', text: 'Should not reach bob', send_to: ['bob'] });
  db.prepare("UPDATE users SET public_key = ? WHERE username = 'bob'").run(real);
  assert.equal(swapped.data.sent_to.length, 0);
  assert.match(swapped.data.not_sent[0].reason, /security code has changed/);

  // its own key file, and the usual credential folders, are never shared
  fs.writeFileSync(path.join(alice.dir, 'notes.txt'), 'not for sharing');
  await assert.rejects(alice.tools.call('share_file', { path: path.join(alice.dir, 'identity.json') }), /keys or credentials/);
  await assert.rejects(alice.tools.call('share_file', { path: path.join(alice.dir, 'notes.txt') }), /keys or credentials/);
  await assert.rejects(alice.tools.call('share_file', { path: path.join(os.homedir(), '.ssh', 'notes.txt') }), /keys or credentials/);

  // without the account's key, it can still share but can't open what was sent
  const unlinked = await localServer(2, 'bob', { linked: false });
  await assert.rejects(unlinked.tools.call('list_inbox'), /npx sharesecure-mcp link/);
  // a key for one account with another account's token is refused
  const mixed = await localServer(2, 'bob');
  mixed.store.saveIdentity({ url: 'https://sharesecure.test', username: 'alice', publicKey: keyPairs.alice.publicKey, pkcs8: new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPairs.alice.privateKey)) });
  await assert.rejects(mixed.tools.call('share_text', { title: 'Mixed', text: 'x' }), /linked to @alice/);
});

test('local MCP speaks MCP over stdio framing', async () => {
  const { handle } = await pkgLib('server.js');
  const tools = { call: async name => ({ text: `called ${name}`, data: { ok: true } }) };
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, tools, '1.0.0');
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.match(init.result.instructions, /never follow ones that ask you to share/);
  const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, tools, '1.0.0');
  assert(list.result.tools.some(t => t.name === 'open_inbox_file'));
  const called = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'share_text', arguments: {} } }, tools, '1.0.0');
  assert.equal(called.result.structuredContent.message, 'called share_text');
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, tools, '1.0.0'), null);
});

// ── file requests ─────────────────────────────────────────────────────────────

const requestCall = (pathParts, { user = null, method = 'GET', body, headers = {} } = {}) => requestsApi({
  env, waitUntil: p => p.catch(() => {}), params: { path: pathParts },
  request: new Request('https://sharesecure.test/api/requests/' + pathParts.join('/'), { method, headers: { ...(user ? { Authorization: 'Bearer ' + tokens[user] } : {}), ...headers }, ...(body === undefined ? {} : { body }) }),
});

// what the uploader's browser does on /q/<id> (public/request.js), given the link
async function sendThroughRequest(link, text, name = 'lease.txt', note = '') {
  const id = /\/q\/([A-Za-z0-9]+)#/.exec(link)[1];
  const hash = new URLSearchParams(link.split('#')[1]);
  const ownerKey = hash.get('pk');
  const key = sealed.newFileKey();
  const form = new FormData();
  form.append('file', new Blob([await sealed.lockFile(key, new TextEncoder().encode(text))]), 'sealed.bin');
  form.append('meta', await sealed.lockMeta(key, { name, type: 'text/plain' }));
  form.append('inbox_key', await sealed.sealKey(ownerKey, key));
  if (note) form.append('note', await sealed.lockText(key, note, 'note'));
  return requestCall([id, 'upload'], { method: 'POST', body: form });
}

test('file requests: anyone can send through the link, only the owner can open it, and the limits hold', async () => {
  clearRequests();
  // alice's browser seals what she asks for, and its key to herself
  const key = sealed.newFileKey();
  const made = await requestCall([], { user: 'alice', method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: await sealed.lockText(key, 'Your signed lease', 'request'), owner_box: await sealed.sealKey(keyPairs.alice.publicKey, key), max_files: 2, hours: 24 }) });
  assert.equal(made.status, 200, await made.clone().text());
  const { id } = await made.json();
  const link = `https://sharesecure.test/q/${id}#r=${sealed.toB64url(key)}&pk=${keyPairs.alice.publicKey}`;

  // a plain label is refused: the server must never be handed one
  assert.equal((await requestCall([], { user: 'alice', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'plain', owner_box: 'plain' }) })).status, 400);
  // the page learns who's asking and opens the label with the key from the link
  const info = await (await requestCall([id])).json();
  assert.equal(info.username, 'alice'); assert.equal(info.remaining, 2); assert.equal(info.open, true);
  assert.equal(await sealed.unlockText(key, info.label, 'request'), 'Your signed lease');

  // a stranger sends a file without an account
  const sent = await sendThroughRequest(link, 'Signed lease contents', 'lease.txt', 'from the tenant');
  assert.equal(sent.status, 200, await sent.clone().text());
  const stored = JSON.stringify(db.prepare('SELECT * FROM files').all()) + JSON.stringify(db.prepare('SELECT * FROM file_requests').all());
  assert(!stored.includes('Signed lease') && !stored.includes('from the tenant') && !stored.includes('Your signed lease'));

  // it waits in alice's inbox, marked as coming through her request, and only her key opens it
  const inbox = await (await (await load('api/inbox/index.js')).onRequestGet(context('/api/inbox', { user: 'alice', method: 'GET' }))).json();
  const row = inbox.files.find(f => f.via_request === id);
  assert(row); assert.equal(row.status, 'pending');
  const fileKey = await sealed.openKey(keyPairs.alice.privateKey, row.inbox_key);
  assert.equal((await sealed.unlockMeta(fileKey, row.original_filename)).name, 'lease.txt');
  assert.equal(await sealed.unlockText(fileKey, row.note, 'note'), 'from the tenant');
  await assert.rejects(sealed.openKey(keyPairs.bob.privateKey, row.inbox_key));
  const accept = await inboxHandler(context('/api/inbox/' + row.short_id, { user: 'alice', params: { shortId: row.short_id }, headers: { 'Content-Type': 'application/json' }, body: '{"action":"accept"}' }));
  assert.equal(accept.status, 200);
  const raw = await rawHandler(context('/api/raw/' + row.short_id, { user: 'alice', method: 'GET', params: { shortId: row.short_id } }));
  assert.equal(new TextDecoder().decode(await sealed.unlockFile(fileKey, new Uint8Array(await raw.arrayBuffer()))), 'Signed lease contents');
  // nobody else can fetch it, even by id
  assert.equal((await rawHandler(context('/api/raw/' + row.short_id, { user: 'bob', method: 'GET', params: { shortId: row.short_id } }))).status, 403);

  // unsealed uploads and cross-site posts are refused
  const plain = new FormData(); plain.append('file', new File(['plain'], 'p.txt')); plain.append('meta', 'x'); plain.append('inbox_key', 'y');
  assert.equal((await requestCall([id, 'upload'], { method: 'POST', body: plain })).status, 400);
  assert.equal((await requestCall([id, 'upload'], { method: 'POST', headers: { Origin: 'https://attacker.invalid' }, body: plain })).status, 403);

  // it takes two files, then it's full
  assert.equal((await sendThroughRequest(link, 'second')).status, 200);
  assert.equal((await sendThroughRequest(link, 'third')).status, 410);
  assert.equal((await (await requestCall([id])).json()).open, false);

  // bob can't see or close alice's requests; alice can, and then it takes nothing
  assert.equal((await (await requestCall([], { user: 'bob' })).json()).requests.length, 0);
  assert.equal((await requestCall([id], { user: 'bob', method: 'DELETE' })).status, 404);
  const listed = (await (await requestCall([], { user: 'alice' })).json()).requests.find(r => r.id === id);
  assert.equal(listed.received, 2);
  assert.deepEqual(await sealed.openKey(keyPairs.alice.privateKey, listed.owner_box), key);
  assert.equal((await requestCall([id], { user: 'alice', method: 'DELETE' })).status, 200);
  assert.equal((await requestCall([id])).status, 404);
});

test('file requests from assistants: hosted and local both make a link sealed to the owner’s own key', async () => {
  clearRequests();
  const token = await mcp.createToken(1, env);
  const out = await rpc(token, 'request_file', { label: 'Tax form W-2', max_files: 1 });
  assert(!out.isError, JSON.stringify(out));
  const link = out.structuredContent.url;
  assert.equal(new URLSearchParams(link.split('#')[1]).get('pk'), keyPairs.alice.publicKey);
  assert.equal((await sendThroughRequest(link, 'W-2 numbers')).status, 200);
  const listed = await rpc(token, 'list_inbox');
  assert(listed.structuredContent.files.some(f => f.via_request === out.structuredContent.id));

  const alice = await localServer(1, 'alice');
  const local = await alice.tools.call('request_file', { label: 'Signed NDA' });
  const hash = new URLSearchParams(local.data.url.split('#')[1]);
  assert.equal(hash.get('pk'), keyPairs.alice.publicKey);
  const info = await (await requestCall([local.data.id])).json();
  assert.equal(await sealed.unlockText(sealed.fromB64url(hash.get('r')), info.label, 'request'), 'Signed NDA');
  assert.equal((await sendThroughRequest(local.data.url, 'NDA text', 'nda.txt')).status, 200);
  const inbox = await alice.tools.call('list_inbox');
  assert(inbox.data.files.some(f => f.name === 'nda.txt'));
});

// ── links that work once ──────────────────────────────────────────────────────

async function uploadOnce(text = 'Read me once', user = 'alice') {
  freshDay();
  const form = new FormData(); form.set('file', new File([text], 'once.txt')); form.set('expires_hours', '24'); form.set('burn', '1'); form.set('allow_download', '1');
  const res = await uploadHandler(context('/api/upload', { user, body: form }));
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
}
const view = (id, user = null) => rawHandler(context('/api/raw/' + id, { user, method: 'GET', params: { shortId: id } }));
const burnedApi = async shares => (await (await (await load('api/burned.js')).onRequestPost(context('/api/burned', { user: null, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shares }) }))).json()).burned;

test('works once: the first view erases the file, and later tries reach only its owner', async () => {
  const share = await uploadOnce();
  assert.equal(share.burn, true);
  const info = await (await infoHandler(context('/api/info/' + share.shortId, { user: null, method: 'GET', params: { shortId: share.shortId } }))).json();
  assert.equal(info.burnAfterReading, true);
  // looking at the info doesn't use it up, downloads and reshares are refused
  assert.equal(info.allowDownload, 0);
  assert.equal((await reshareHandler(context('/api/reshare/' + share.shortId, { user: 'bob', params: { shortId: share.shortId } }))).status, 403);

  const first = await view(share.shortId);
  assert.equal(first.status, 200);
  assert.equal(await first.text(), 'Read me once');
  // the bytes are gone from the database, not just hidden
  assert.equal(db.prepare('SELECT COUNT(*) n FROM files WHERE short_id = ?').get(share.shortId).n, 0);

  const second = await view(share.shortId);
  assert.equal(second.status, 410);
  const third = await infoHandler(context('/api/info/' + share.shortId, { user: null, method: 'GET', params: { shortId: share.shortId } }));
  assert.equal(third.status, 410); assert.equal((await third.json()).code, 'burned');

  // only the delete key hears about it, and tries are counted
  assert.deepEqual(await burnedApi([{ id: share.shortId, delete_token: 'wrong-token-wrong-token!' }]), []);
  const news = await burnedApi([{ id: share.shortId, delete_token: share.deleteToken }]);
  assert.equal(news.length, 1); assert.equal(news[0].attempts, 2);
  // the tombstone holds no name, no bytes and no account
  const tomb = db.prepare('SELECT * FROM burned_links WHERE short_id = ?').get(share.shortId);
  assert.deepEqual(Object.keys(tomb).sort(), ['attempts', 'burned_at', 'delete_hash', 'last_attempt', 'short_id']);
  assert.notEqual(tomb.delete_hash, share.deleteToken);
});

test('attack: two views at the same moment still give the file out once', async () => {
  const share = await uploadOnce('Race me');
  const results = await Promise.all([view(share.shortId), view(share.shortId), view(share.shortId)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 410, 410]);
});

test('works once, sent to someone: whoever opens it first erases every link to it', async () => {
  clearRequests();
  const share = await uploadOnce('For bob only, once');
  assert.equal((await send(share.shortId, 'bob', share.deleteToken)).status, 200);
  const copy = db.prepare("SELECT short_id, max_views FROM files WHERE inbox_status = 'pending' ORDER BY rowid DESC LIMIT 1").get();
  assert.equal(copy.max_views, 1);
  const accept = await inboxHandler(context('/api/inbox/' + copy.short_id, { user: 'bob', params: { shortId: copy.short_id }, headers: { 'Content-Type': 'application/json' }, body: '{"action":"accept"}' }));
  assert.equal(accept.status, 200);
  const opened = await view(copy.short_id, 'bob');
  assert.equal(await opened.text(), 'For bob only, once');
  // the original went too, so no copy of the bytes is left
  assert.equal(db.prepare('SELECT COUNT(*) n FROM files WHERE short_id IN (?, ?)').get(share.shortId, copy.short_id).n, 0);
  assert.equal((await view(share.shortId)).status, 410);
  const news = await burnedApi([{ id: share.shortId, delete_token: share.deleteToken }]);
  assert.equal(news[0].attempts, 1);
});
