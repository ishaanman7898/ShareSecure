// What this computer keeps, in ~/.sharesecure (or $SHARESECURE_HOME), all
// written readable by you only:
//   identity.json   the account's private key, once you've run `link`. It
//                   opens files sent to you, your sealed list of shares and
//                   your assistant rules.
//   contacts.json   the public key each person had the first time you sent
//                   them something. If the server ever hands out a different
//                   one, sending stops (the same check the website makes).
//   profile.json    your username and public key, looked up once, so sharing
//                   doesn't have to ask the server who you are each time.
//   tokens.json     anonymous upload and send tokens, picked up ahead of time.
//   shares.json     the shares made here, with their keys and delete keys, so
//                   they can be resent or deleted without tying them to you.
//   later.json      waiting sends and list updates, posted a while after the
//                   share they belong to so the timing doesn't link the two.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fromB64url, toB64url, importPrivateKey } from '../lib/sealed.js';

export function makeStore(dir = process.env.SHARESECURE_HOME || path.join(os.homedir(), '.sharesecure')) {
  const file = name => path.join(dir, name);

  function read(name, fallback = null) {
    try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
  }

  function write(name, value) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = file(name);
    const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temp, target);
  }

  let privateKey = null;

  return {
    dir,
    read,
    write,

    // { url, username, publicKey, privateKey (base64url PKCS#8), linkedAt } or null
    identity: () => read('identity.json'),

    saveIdentity({ url, username, publicKey, pkcs8 }) {
      write('identity.json', { url, username, publicKey, privateKey: toB64url(pkcs8), linkedAt: new Date().toISOString() });
      privateKey = null;
    },

    forgetIdentity() {
      fs.rmSync(file('identity.json'), { force: true });
      privateKey = null;
    },

    // the private key as a key WebCrypto can use but not read out, or null
    async privateKey() {
      if (privateKey) return privateKey;
      const id = read('identity.json');
      if (!id?.privateKey) return null;
      privateKey = await importPrivateKey(fromB64url(id.privateKey));
      return privateKey;
    },

    contact: username => (read('contacts.json', {}))[String(username).toLowerCase()] || null,

    rememberContact(username, publicKey) {
      const all = read('contacts.json', {});
      all[String(username).toLowerCase()] = publicKey;
      write('contacts.json', all);
    },
  };
}
