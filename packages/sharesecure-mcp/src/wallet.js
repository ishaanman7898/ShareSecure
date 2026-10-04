// A small wallet of anonymous tokens, the same kind the website uses (see the
// site's tokens.js and blindrsa.js). They're picked up while signed in with
// your connection token, a while before they're needed, and spent on uploads
// and sends without it. The server signs each one blinded, so when one is
// spent it can't tell which account it gave it to.
import { issuerKey, blind, finalize, tokenMessage } from '../lib/blindrsa.js';
import { trustedIssuer } from '../lib/tokens.js';
import { randomBytes, toB64url, fromB64url } from '../lib/sealed.js';

const KEEP = { upload: 2, send: 10 };
const DAY_MS = 24 * 60 * 60 * 1000;
const today = () => Math.floor(Date.now() / DAY_MS);

export function makeWallet({ api, store, pause = ms => new Promise(r => setTimeout(r, ms)) }) {
  // a token only works on the day it's for and the day after
  const load = () => store.read('tokens.json', []).filter(t => t.day >= today() - 1);
  const save = list => store.write('tokens.json', list);
  let filling = null;

  // Tops the wallet up, one token per request with a short random pause between.
  async function refill() {
    if (filling) return filling;
    filling = (async () => {
      try {
        const info = await api.tokenInfo();
        if (!info.available || !info.left || !(await trustedIssuer(api.base, info.publicKey))) return;
        const key = await issuerKey(info.publicKey);
        for (const kind of ['upload', 'send']) {
          let want = Math.min(KEEP[kind] - load().filter(t => t.kind === kind).length, info.left[kind]);
          while (want-- > 0) {
            await pause(300 + Math.random() * 1500);
            const nonce = randomBytes(32);
            const msg = tokenMessage(kind, info.day, info.keyId, nonce);
            const { blinded, inv } = await blind(key, msg);
            const signed = await api.tokenSign(kind, toB64url(blinded));
            const sig = await finalize(key, msg, fromB64url(signed.signature), inv);
            save([...load(), { kind, day: info.day, nonce: toB64url(nonce), sig: toB64url(sig) }]);
          }
        }
      } catch {
        // no tokens: the next share says so, rather than going out signed in
      } finally {
        filling = null;
      }
    })();
    return filling;
  }

  // Takes one token → the header value to send, or null.
  function take(kind) {
    const list = load();
    const i = list.findIndex(t => t.kind === kind);
    if (i < 0) return null;
    const [t] = list.splice(i, 1);
    save(list);
    return `${t.kind}.${t.day}.${t.nonce}.${t.sig}`;
  }

  return { refill, take, count: kind => load().filter(t => t.kind === kind).length };
}
