'use strict';
// This computer's ShareSecure server, run in its own process (the app's own
// binary as Node). The app starts it and talks to it over IPC. When the app
// quits, this keeps running, so share links work until the last one expires,
// and then it stops by itself.
require('../server/index.js');
const { db } = require('../server/db');

const CHECK_EVERY = 30 * 1000;
// a link counts until it expires; one without an expiry keeps the server up
const liveLink = db.prepare('SELECT 1 FROM files WHERE is_active = 1 AND (expires_at IS NULL OR expires_at > ?) LIMIT 1');

const anyLive = () => Boolean(liveLink.get(new Date().toISOString()));

function stopIfNothingShared() {
  if (!anyLive()) process.exit(0);
}

process.on('message', message => {
  if (message === 'stop') process.exit(0);
  if (message === 'live?') process.send({ live: anyLive() });
});

// the app closed (or crashed): keep the links up until they've all expired
process.on('disconnect', () => {
  console.log('  [desktop] The app closed. Links keep working until they expire.');
  stopIfNothingShared();
  setInterval(stopIfNothingShared, CHECK_EVERY);
});
