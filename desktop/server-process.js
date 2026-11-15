'use strict';
// This computer's ShareSecure server. While the app is open it runs here as
// Electron's utility process, and talks to the app over process.parentPort.
// Once you quit with links still live, the app starts again in the background
// (main.js, BACKGROUND_FLAG) and runs this itself: no window, no line to an
// app, and it stops by itself once the last link has expired.
require('../server/index.js');
const crypto = require('crypto');
const { db } = require('../server/db');
const session = require('../server/session');
const settings = require('../server/settings');
const events = require('../server/events');

const CHECK_EVERY = 30 * 1000;
// the app, when this is its utility process
const parent = process.parentPort || null;
const tell = message => { try { parent?.postMessage(message); } catch {} };
// a link counts until it expires; one without an expiry keeps the server up
const liveLink = db.prepare('SELECT 1 FROM files WHERE is_active = 1 AND (expires_at IS NULL OR expires_at > ?) LIMIT 1');

const anyLive = () => Boolean(liveLink.get(new Date().toISOString()));

function stopIfNothingShared() {
  if (!anyLive()) process.exit(0);
}

// A new password for the owner account, from "Forgot your password?" in the
// app (see signin:reset in main.js). Only the app can ask, over its line to
// this process: nothing on the network reaches it. Every other session is
// signed out, and the files are untouched (they're encrypted with the key in
// .env, not the password). → the owner's username, or null
function resetPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024) return null;
  const owner = db.prepare('SELECT id, username FROM users ORDER BY id LIMIT 1').get();
  if (!owner) return null;
  db.prepare('UPDATE users SET access_code = ? WHERE id = ?').run(session.hashPassword(password), owner.id);
  settings.set('sessionSecret', crypto.randomBytes(32).toString('hex'));
  session.recordSuccess('local');
  session.recordSuccess('remote');
  return owner.username;
}

if (parent) {
  parent.on('message', ({ data: message }) => {
    if (message === 'stop') process.exit(0);
    if (message === 'live?') tell({ live: anyLive() });
    if (message?.type === 'reset-password') tell({ type: 'reset-password', username: resetPassword(message.password) });
  });
  // What to notify you about goes to the app, which shows the ones you chose
  // (only while it's open: in the background, nothing here shows them).
  for (const kind of ['expired', 'opened', 'received']) {
    events.on(kind, detail => tell({ type: 'notify', kind, ...detail }));
  }
  // files sent to your username are looked for even with no window open
  setInterval(() => require('../server/routes/cloud').syncSoon().catch(() => {}), 60 * 1000).unref();
} else {
  // In the background: keep the links up until they've all expired. The first
  // look waits a moment, so a notification the app shows as it starts (an
  // update installed) has time to appear.
  console.log('  [desktop] Running in the background. Links keep working until they expire.');
  setTimeout(stopIfNothingShared, 5 * 1000);
  setInterval(stopIfNothingShared, CHECK_EVERY);
}
