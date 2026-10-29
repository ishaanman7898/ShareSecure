// A small wallet of anonymous tokens in this browser (see blindrsa.js).
//
// While you're signed in, the page quietly picks up a couple of upload tokens
// and some send tokens in the background, a while before you need them. When
// you share end to end or send to someone, a token is spent instead of your
// sign-in, so the server can't tell the upload or send came from you. Getting
// tokens early, not right before they're spent, keeps timing from linking them.
// There's no falling back to the sign-in: with none left, a share waits for one
// (anonToken), because a signed-in upload is tied to the account for good.
import { issuerKey, blind, finalize, tokenMessage } from './blindrsa.js';
import { randomBytes, toB64url, fromB64url } from './sealed.js';

// the whole day's uploads (see DAILY in functions/_tokens.js), so the wallet
// rarely runs dry and has to be topped up right before a share
const KEEP = { upload: 5, send: 20 };

// The one token-signing key each ShareSecure site may use, by the SHA-256 of
// its modulus. If the server hands out any other key, no tokens are taken:
// a server giving different people different keys could tell their tokens
// apart. (A site not listed here, like a test copy, uses whatever key it has.)
export const PINNED_ISSUERS = {
  'https://sharesecure-du8.pages.dev': 'RaTJnJlLUVBRXDFDVjvASBjIZEUxYe_Nfu822xfFsAo',
};

// Is this the key this site is meant to use? Checked against the key itself,
// never the id the server claims for it.
export async function trustedIssuer(origin, publicKey) {
  const id = toB64url(new Uint8Array(await crypto.subtle.digest('SHA-256', fromB64url(publicKey.n))));
  const pinned = PINNED_ISSUERS[origin];
  return pinned ? id === pinned : true;
}
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

let filling = null;

// Tops the wallet up, one token per request with a short random pause between.
// One top-up at a time; calling again while one runs waits for it.
export function refill(user, authHeaders) {
  if (!user) return Promise.resolve();
  if (!filling) filling = fill(user, authHeaders).finally(() => { filling = null; });
  return filling;
}

async function fill(user, authHeaders) {
  try {
    const res = await fetch('/api/tokens', { headers: authHeaders });
    if (!res.ok) return;
    const info = await res.json();
    if (!info.available || !info.left || !(await trustedIssuer(location.origin, info.publicKey))) return;
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
    // no tokens: anonToken says so, and nothing is shared signed in instead
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

// A token to spend, topping the wallet up first if it's empty → the header
// value, or null when there are none left today (the daily limit).
export async function anonToken(user, kind, authHeaders) {
  const token = takeToken(user, kind);
  if (token) return token;
  await refill(user, authHeaders);
  return takeToken(user, kind);
}

export function forgetTokens(user) {
  try { localStorage.removeItem(walletKey(user)); } catch {}
}
