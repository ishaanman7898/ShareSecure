'use strict';
// This computer's ShareSecure server, run in its own process (the app's own
// binary as Node). The app starts it and talks to it over IPC. When the app
// quits, this keeps running, so share links work until the last one expires,
// and then it stops by itself.
require('../server/index.js');
const crypto = require('crypto');
const { db } = require('../server/db');
const session = require('../server/session');
const settings = require('../server/settings');

const CHECK_EVERY = 30 * 1000;
// a link counts until it expires; one without an expiry keeps the server up
const liveLink = db.prepare('SELECT 1 FROM files WHERE is_active = 1 AND (expires_at IS NULL OR expires_at > ?) LIMIT 1');

const anyLive = () => Boolean(liveLink.get(new Date().toISOString()));

function stopIfNothingShared() {
  if (!anyLive()) process.exit(0);
}

// A new password for the owner account, from "Forgot your password?" in the
// app (see signin:reset in main.js). Only the app can ask, over this IPC line:
// nothing on the network reaches it. Every other session is signed out, and
// the files are untouched (they're encrypted with the key in .env, not the
// password). → the owner's username, or null
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

process.on('message', message => {
  if (message === 'stop') process.exit(0);
  if (message === 'live?') process.send({ live: anyLive() });
  if (message?.type === 'reset-password') process.send({ type: 'reset-password', username: resetPassword(message.password) });
});

// the app closed (or crashed): keep the links up until they've all expired
process.on('disconnect', () => {
  console.log('  [desktop] The app closed. Links keep working until they expire.');
  stopIfNothingShared();
  setInterval(stopIfNothingShared, CHECK_EVERY);
});
