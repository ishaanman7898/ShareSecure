'use strict';
// Keeps ShareSecure running across updates: starts the server as a child
// process and starts it again whenever it exits to apply an update.
const { spawn } = require('child_process');
const path = require('path');

const RESTART_CODE = 75;
let child = null;

function start() {
  child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    stdio: 'inherit',
    env: { ...process.env, SHARESECURE_LAUNCHER: '1' },
  });
  child.on('exit', (code, signal) => {
    if (code === RESTART_CODE) {
      console.log('\n  Restarting ShareSecure with the new version…\n');
      start();
    } else {
      process.exit(code ?? (signal ? 1 : 0));
    }
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { if (child) child.kill(sig); });
}

start();
