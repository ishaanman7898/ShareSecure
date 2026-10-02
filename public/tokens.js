// A small wallet of anonymous tokens in this browser (see blindrsa.js).
//
// While you're signed in, the page quietly picks up a couple of upload tokens
// and some send tokens in the background, a while before you need them. When
// you share end to end or send to someone, a token is spent instead of your
// sign-in, so the server can't tell the upload or send came from you. Getting
// tokens early, not right before they're spent, keeps timing from linking them.
import { issuerKey, blind, finalize, tokenMessage } from './blindrsa.js';
import { randomBytes, toB64url, fromB64url } from './sealed.js';

const KEEP = { upload: 2, send: 10 };
const walletKey = user => `ss_tokens:${String(user || '').toLowerCase()}`;
const DAY_MS = 24 * 60 * 60 * 1000;
const today = () => Math.floor(Date.now() / DAY_MS);

function load(user) {
  try {
    const list = JSON.parse(localStorage.getItem(walletKey(user)) || '[]');
    // a token only works on the day it's for and the day after
    return list.filter(t => t.day >= today() - 1);
  } catch { return []; }
}

function save(user, list) {
  try { localStorage.setItem(walletKey(user), JSON.stringify(list)); } catch {}
}

const pause = ms => new Promise(r => setTimeout(r, ms));

let filling = false;

// Tops the wallet up, one token per request with a short random pause between.
export async function refill(user, authHeaders) {
  if (filling || !user) return;
  filling = true;
  try {
    const res = await fetch('/api/tokens', { headers: authHeaders });
    if (!res.ok) return;
    const info = await res.json();
    if (!info.available) return;
    const key = await issuerKey(info.publicKey);
    for (const kind of ['upload', 'send']) {
      let want = Math.min(KEEP[kind] - load(user).filter(t => t.kind === kind).length, info.left[kind]);
      while (want-- > 0) {
        await pause(300 + Math.random() * 1500);
        const nonce = randomBytes(32);
        const msg = tokenMessage(kind, info.day, info.keyId, nonce);
        const { blinded, inv } = await blind(key, msg);
        const signed = await fetch('/api/tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({ kind, blinded: toB64url(blinded) }),
        });
        if (!signed.ok) break;
        const sig = await finalize(key, msg, fromB64url((await signed.json()).signature), inv);
        save(user, [...load(user), { kind, day: info.day, nonce: toB64url(nonce), sig: toB64url(sig) }]);
      }
    }
  } catch {
    // no tokens just means sharing goes through the signed-in session
  } finally {
    filling = false;
  }
}

// Takes one token out of the wallet → the header value to send, or null.
export function takeToken(user, kind) {
  const list = load(user);
  const i = list.findIndex(t => t.kind === kind);
  if (i < 0) return null;
  const [t] = list.splice(i, 1);
  save(user, list);
  return `${t.kind}.${t.day}.${t.nonce}.${t.sig}`;
}

export function forgetTokens(user) {
  try { localStorage.removeItem(walletKey(user)); } catch {}
}
