#!/usr/bin/env node
// sharesecure-mcp            run the local MCP server (what assistants start)
// sharesecure-mcp link       put the account's key on this computer, so
//                            assistants can open files sent to you and resend
//                            your shares. Asks for your password here, in the
//                            terminal; it never leaves this computer.
// sharesecure-mcp unlink     remove the key from this computer
// sharesecure-mcp trust <u>  accept someone's new security code
// sharesecure-mcp status     what this computer is linked to
//
// Settings (environment variables):
//   SHARESECURE_TOKEN   the connection token from the website (account menu →
//                       Connect an AI assistant). Needed to run the server.
//   SHARESECURE_URL     the ShareSecure site, default https://sharesecure-du8.pages.dev
//   SHARESECURE_LINKS   "clipboard" (default): full links go to your clipboard,
//                       never to the assistant. "show": the assistant gets them.
//   SHARESECURE_HOME    where the key is kept, default ~/.sharesecure
import { createRequire } from 'node:module';
import { makeStore } from './src/store.js';
import { makeApi } from './src/api.js';
import { makeTools } from './src/tools.js';
import { serve } from './src/server.js';
import { copyToClipboard } from './src/clipboard.js';

let lib;
try {
  lib = {
    sealed: await import('./lib/sealed.js'),
    opaque: await import('./lib/opaque.js'),
  };
} catch {
  console.error('lib/ is missing. From the repository, run `npm run vendor` in packages/sharesecure-mcp first.');
  process.exit(1);
}

const version = createRequire(import.meta.url)('./package.json').version;
const url = (process.env.SHARESECURE_URL || 'https://sharesecure-du8.pages.dev').replace(/\/+$/, '');
const store = makeStore();
const [command, ...args] = process.argv.slice(2);

// asks in the terminal; a hidden answer isn't echoed
function ask(question, hidden = false) {
  return new Promise((resolve, reject) => {
    const { stdin, stderr } = process;
    if (!stdin.isTTY) { reject(new Error('Run this in a terminal.')); return; }
    stderr.write(question);
    let answer = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData);
          stderr.write('\n');
          resolve(answer);
          return;
        }
        if (ch === '\u0003') { stderr.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') {
          if (answer) { answer = answer.slice(0, -1); if (!hidden) stderr.write('\b \b'); }
          continue;
        }
        answer += ch;
        if (!hidden) stderr.write(ch);
      }
    };
    stdin.on('data', onData);
  });
}

async function link() {
  console.error(`Linking this computer to your ShareSecure account at ${url}.`);
  console.error('Your password is checked without being sent anywhere (OPAQUE), and only unlocks your key here.\n');
  const username = (await ask('Username: ')).trim().replace(/^@/, '');
  const password = await ask('Password: ', true);
  const post = lib.opaque.postWith(globalThis.fetch, url);
  let done;
  try {
    done = await lib.opaque.signIn(post, username, password);
  } catch (err) {
    throw new Error(err.message || 'Couldn’t sign in.');
  }
  if (!done.privateKeyBox || !done.publicKey) {
    throw new Error('This account has no key yet. Sign in on the website once, then run this again.');
  }
  const pkcs8 = await lib.sealed.unlockPrivateKeyBytes(done.privateKeyBox, done.exportKey);
  await lib.sealed.importPrivateKey(pkcs8);   // check it really is a key
  store.saveIdentity({ url, username: done.username || username, publicKey: done.publicKey, pkcs8 });
  console.error(`\nLinked as @${done.username || username}. Your key is in ${store.dir} (readable by you only).`);
  console.error(`Your security code: ${await lib.sealed.fingerprint(done.publicKey)}`);
  console.error('It should match the one on the website (account menu → Security code).');
  console.error('Run `npx sharesecure-mcp unlink` to take the key off this computer.');
}

async function status() {
  const id = store.identity();
  console.error(id
    ? `Linked to @${id.username} at ${id.url} since ${id.linkedAt}.\nSecurity code: ${await lib.sealed.fingerprint(id.publicKey)}`
    : 'Not linked. Shares still work; run `npx sharesecure-mcp link` to open files sent to you and resend shares.');
  console.error(`Links go to: ${process.env.SHARESECURE_LINKS === 'show' ? 'the assistant' : 'your clipboard'}`);
}

async function trust(username) {
  if (!username) throw new Error('Usage: npx sharesecure-mcp trust <username>');
  const name = username.replace(/^@/, '');
  const pub = await makeApi({ url, token: '' }).publicKey(name);
  if (!pub) throw new Error(`@${name} has no key.`);
  console.error(`@${name}’s security code is now: ${await lib.sealed.fingerprint(pub)}`);
  console.error('Only accept it if it matches what they read to you.');
  const answer = (await ask('Accept it? (yes/no) ')).trim().toLowerCase();
  if (answer !== 'yes' && answer !== 'y') { console.error('Nothing changed.'); return; }
  store.rememberContact(name, pub);
  console.error('Done.');
}

try {
  if (command === 'link') await link();
  else if (command === 'unlink') { store.forgetIdentity(); console.error('The key is no longer on this computer.'); }
  else if (command === 'status') await status();
  else if (command === 'trust') await trust(args[0]);
  else if (command === '--version' || command === '-v') console.log(version);
  else if (command === undefined || command === 'serve') {
    const token = process.env.SHARESECURE_TOKEN || '';
    if (!token.startsWith('ss_')) {
      console.error('Set SHARESECURE_TOKEN to your connection token (ShareSecure website → account menu → Connect an AI assistant).');
      process.exit(1);
    }
    const tools = makeTools({
      api: makeApi({ url, token }),
      store,
      copy: copyToClipboard,
      reveal: process.env.SHARESECURE_LINKS === 'show',
    });
    serve(tools, version);
  } else {
    console.error(`Unknown command ${command}. Commands: link, unlink, status, trust <username>.`);
    process.exit(1);
  }
} catch (err) {
  console.error(err.message || String(err));
  process.exitCode = 1;
}
