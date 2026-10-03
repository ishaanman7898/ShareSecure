// What this computer keeps, in ~/.sharesecure (or $SHARESECURE_HOME):
//   identity.json   the account's private key, once you've run `link`. It
//                   opens files sent to you and your own shares, so it's
//                   written readable by you only.
//   contacts.json   the public key each person had the first time you sent
//                   them something. If the server ever hands out a different
//                   one, sending stops (the same check the website makes).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fromB64url, toB64url, importPrivateKey } from '../lib/sealed.js';

export function makeStore(dir = process.env.SHARESECURE_HOME || path.join(os.homedir(), '.sharesecure')) {
  const file = name => path.join(dir, name);

  function read(name) {
    try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return null; }
  }

  function write(name, value) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = file(name);
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temp, target);
  }

  let privateKey = null;

  return {
    dir,

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

    contact: username => (read('contacts.json') || {})[String(username).toLowerCase()] || null,

    rememberContact(username, publicKey) {
      const all = read('contacts.json') || {};
      all[String(username).toLowerCase()] = publicKey;
      write('contacts.json', all);
    },

    forgetContact(username) {
      const all = read('contacts.json') || {};
      delete all[String(username).toLowerCase()];
      write('contacts.json', all);
    },
  };
}
