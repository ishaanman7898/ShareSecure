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
fs.writeFileSync(path.join(temp, 'package.json'), '{"type":"module"}');
fs.cpSync(path.join(root, 'functions'), path.join(temp, 'functions'), { recursive: true });
const load = file => import(pathToFileURL(path.join(temp, 'functions', file)).href);
const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(path.join(root, 'db/schema.sql'), 'utf8'));
db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, access_code TEXT, zk_commitment TEXT)');
db.exec("INSERT INTO users (id, username, access_code) VALUES (1, 'alice', 'test'), (2, 'bob', 'test'), (3, 'mallory', 'test')");
const env = { TURSO_URL: 'https://audit.invalid', TURSO_TOKEN: 'test-only', TOKEN_SECRET: 'test-only-signing-secret', TAG_SECRET: 'test-only-tag-secret', ENCRYPTION_KEY: '42'.repeat(32) };
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
let api, mcp, uploadHandler, sendHandler, inboxHandler, rawHandler, infoHandler, reshareHandler;
const tokens = {};
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
  for (const [i, username] of ['alice', 'bob', 'mallory'].entries()) tokens[username] = await api.signToken({ userId: i + 1, username }, env);
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

test('MCP generated text is uploaded and delivered without manual user steps', async () => {
  const token = await mcp.createToken(1, env);
  const out = await rpc(token, 'share_text', { title: 'Agent report', text: 'Generated by a test agent', send_to: ['bob'] });
  assert(!out.isError, JSON.stringify(out));
  assert.match(out.content[0].text, /Sent to: bob/);
  assert.match(out.content[0].text, /Link: https:\/\/sharesecure.test\/r\//);
});

test('MCP generated binary: agent receives command, uploads exact bytes, polls receipt; replay is denied', async () => {
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
  assert.equal(await response.text(), bytes);
  const status = await rpc(token, 'upload_status', { ticket_id: ticketId });assert.match(status.content[0].text, /Upload complete/);
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
