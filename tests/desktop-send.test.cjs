'use strict';
// The desktop app sending to usernames (server/routes/cloud.js), against the
// website's real handlers and SQL. What matters here: nothing the desktop puts
// on the website for a send carries the linked account's sign-in, so the
// website can't tie the copy, the send or its deletion to the account.
// No request is allowed to reach the network or a production database.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sharesecure-desktopsend-'));
const CLOUD = 'https://sharesecure.test';

// the desktop server, with its own data folder
process.env.DATA_DIR = path.join(temp, 'desktop');
process.env.ENCRYPTION_KEY = '23'.repeat(32);
process.env.USE_RELAY = 'false';
process.env.SHARESECURE_CLOUD = CLOUD;
fs.mkdirSync(process.env.DATA_DIR);

// the website's handlers, copied beside the shared modules they import
fs.writeFileSync(path.join(temp, 'package.json'), '{"type":"module","version":"0.0.0-test"}');
fs.cpSync(path.join(root, 'functions'), path.join(temp, 'functions'), { recursive: true });
fs.mkdirSync(path.join(temp, 'public'));
for (const f of ['sealed.js', 'filetypes.js', 'zip.js', 'protect.js', 'mcp-common.js', 'opaque.js', 'p256.js', 'blindrsa.js', 'tokens.js', 'kt.js']) {
  fs.copyFileSync(path.join(root, 'public', f), path.join(temp, 'public', f));
}
const load = file => import(pathToFileURL(path.join(temp, 'functions', file)).href);

// the website's database (Turso, faked with SQLite in memory)
const web = new DatabaseSync(':memory:');
web.exec(fs.readFileSync(path.join(root, 'db/schema.sql'), 'utf8'));
web.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, access_code TEXT)');
web.exec("INSERT INTO users (id, username, access_code) VALUES (1, 'alice', 'test'), (2, 'bob', 'test')");
const issuerKey = require('node:crypto').generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const env = { TURSO_URL: 'https://audit.invalid', TURSO_TOKEN: 'test-only', TOKEN_SECRET: 'test-only-signing-secret', TAG_SECRET: 'test-only-tag-secret', ENCRYPTION_KEY: '42'.repeat(32), TOKEN_ISSUER_KEY: issuerKey, KT_BLOCK: '4' };

function turso(options) {
  const stmt = JSON.parse(options.body).requests[0].stmt;
  const args = stmt.args.map(a => a.type === 'null' ? null : a.type === 'text' ? a.value : Number(a.value));
  try {
    const query = web.prepare(stmt.sql);
    const rows = query.all(...args);
    const cols = query.columns().map(c => ({ name: c.name }));
    const typed = v => v === null ? { type: 'null' } : { type: typeof v === 'number' ? 'integer' : 'text', value: String(v) };
    return Response.json({ results: [{ type: 'ok', response: { result: { cols, rows: rows.map(r => cols.map(c => typed(r[c.name]))), affected_row_count: web.prepare('SELECT changes() n').get().n } } }] });
  } catch (error) {
    return Response.json({ results: [{ type: 'error', error: { message: error.message } }] });
  }
}

// every request the desktop makes to the website, to check which carry the account
const seen = [];
let handlers;
const realFetch = global.fetch;
global.fetch = async (url, options = {}) => {
  if (String(url) === 'https://audit.invalid/v2/pipeline') return turso(options);
  const u = new URL(url);
  assert.equal(u.origin, CLOUD, 'Unexpected network request blocked: ' + url);
  const request = new Request(u.href, options);
  seen.push({ method: request.method, path: u.pathname, auth: request.headers.get('Authorization'), token: request.headers.get('X-ShareSecure-Token') });
  const ctx = { env, request, params: {}, waitUntil: p => p.catch(() => {}) };
  const [, kind, id] = /^\/api\/(send|delete)\/([A-Za-z0-9]+)$/.exec(u.pathname) || [];
  if (kind) return handlers[kind]({ ...ctx, params: { shortId: id } });
  const handler = handlers[`${request.method} ${u.pathname}`];
  if (!handler) throw new Error('Unexpected request ' + request.method + ' ' + url);
  return handler(ctx);
};

let cloud, settings, utils, storeFile, sealed, aliceToken, bobKeys;
before(async () => {
  const tokensApi = await load('api/tokens.js');
  const keysApi = await load('api/keys/index.js');
  handlers = {
    'GET /api/tokens': tokensApi.onRequestGet,
    'POST /api/tokens': tokensApi.onRequestPost,
    'GET /api/keys': keysApi.onRequestGet,
    'GET /api/transparency': (await load('api/transparency.js')).onRequestGet,
    'POST /api/upload': (await load('api/upload.js')).onRequestPost,
    send: (await load('api/send/[shortId].js')).onRequestPost,
    delete: (await load('api/delete/[shortId].js')).onRequestPost,
  };
  const api = await load('_turso.js');
  // the columns later releases added to files (the real site adds them on first use)
  await api.ensureFileColumns(api.getDb(env));
  sealed = await import(pathToFileURL(path.join(temp, 'public', 'sealed.js')).href);
  // alice is the account linked to this computer; bob gets the file
  aliceToken = await api.signToken({ userId: 1, username: 'alice' }, env);
  const bobToken = await api.signToken({ userId: 2, username: 'bob' }, env);
  const aliceKeys = await sealed.makeKeyPair();
  bobKeys = await sealed.makeKeyPair();
  for (const [token, pair] of [[aliceToken, aliceKeys], [bobToken, bobKeys]]) {
    const res = await keysApi.onRequestPost({ env, params: {}, waitUntil: () => {}, request: new Request(CLOUD + '/api/keys', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_key: pair.publicKey, private_key_box: await sealed.lockPrivateKey(pair.privateKey, sealed.newFileKey()) }),
    }) });
    assert.equal(res.status, 200, await res.clone().text());
  }

  settings = require(path.join(root, 'server', 'settings.js'));
  utils = require(path.join(root, 'server', 'utils.js'));
  ({ storeFile } = require(path.join(root, 'server', 'routes', 'files.js')));
  cloud = require(path.join(root, 'server', 'routes', 'cloud.js'));
  cloud.noPauses();
  settings.set('cloudToken', utils.encryptString(aliceToken, utils.getEncKey()));
  settings.set('cloudUsername', 'alice');
});

after(() => {
  global.fetch = realFetch;
  web.close();
  try { require(path.join(root, 'server', 'db.js')).db.close(); } catch {}
  assert(path.basename(temp).startsWith('sharesecure-desktopsend-'));
  fs.rmSync(temp, { recursive: true, force: true });
});

const lockedShare = () => storeFile(
  { buffer: Buffer.from('Quarterly numbers, desktop test'), originalname: 'numbers.txt', mimetype: 'text/plain', size: 31 },
  { expires_hours: '24', allow_download: '1' }, { seal: true });

test('desktop: the website copy, the send and the delete never carry the linked account', async () => {
  const share = await lockedShare();
  assert(!share.error, share.error);

  const out = await cloud.sendOne(share.shortId, 'bob', 'from the desktop');
  assert.equal(out.status, 200, JSON.stringify(out.body));

  // the copy and the send went with anonymous tokens alone
  const upload = seen.find(r => r.path === '/api/upload');
  const send = seen.find(r => r.path.startsWith('/api/send/'));
  assert(upload?.token && !upload.auth, 'the upload spends a token, not the sign-in');
  assert(send?.token && !send.auth, 'the send spends a token, not the sign-in');
  // only picking up tokens is signed in (they're blinded, so they can't be matched to what they're spent on)
  assert.deepEqual([...new Set(seen.filter(r => r.auth).map(r => r.path))], ['/api/tokens']);

  // the website's rows say nothing about alice
  const rows = web.prepare('SELECT user_tag, user_id, sender_tag, recipient_user_tag, inbox_key, e2e FROM files').all();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.user_tag, null); assert.equal(row.user_id, null); assert.equal(row.sender_tag, null);
    assert.equal(row.e2e, 1);
  }
  // bob, and only bob, can open the key sealed to him
  const copy = rows.find(r => r.recipient_user_tag);
  assert(await sealed.openKey(bobKeys.privateKey, copy.inbox_key));

  // deleting the share here takes the website's copy back with the delete key alone
  seen.length = 0;
  await cloud.forgetCloudCopy(share.shortId);
  const del = seen.find(r => r.path.startsWith('/api/delete/'));
  assert(del, 'the copy is deleted');
  assert.equal(del.auth, null, 'deleting doesn’t say whose copy it was');
  assert.equal(web.prepare('SELECT COUNT(*) n FROM files').get().n, 0);
});

test('desktop: out of tokens, a send stops instead of going signed in', async () => {
  // today's uploads are used up, so the website hands out no more upload tokens
  web.exec(`UPDATE token_issued SET count = 99 WHERE kind = 'upload'`);
  settings.set('cloudTokens', null);
  const share = await lockedShare();
  seen.length = 0;
  const out = await cloud.sendOne(share.shortId, 'bob', '');
  assert.equal(out.status, 429, JSON.stringify(out.body));
  assert(!seen.some(r => r.path === '/api/upload'), 'nothing was uploaded');
  assert(!seen.some(r => r.auth && r.path !== '/api/tokens'), 'the sign-in only ever asks for tokens');
});
