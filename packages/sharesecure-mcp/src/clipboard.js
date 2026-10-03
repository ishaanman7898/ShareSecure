// Puts text on the clipboard with the system's own tool. → true if it worked
import { spawn } from 'node:child_process';

const TOOLS = {
  win32: [['clip', []]],
  darwin: [['pbcopy', []]],
  linux: [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]],
};

function run(command, args, text) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true }); } catch { resolve(false); return; }
    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0));
    child.stdin.end(text);
  });
}

export async function copyToClipboard(text) {
  for (const [command, args] of TOOLS[process.platform] || []) {
    if (await run(command, args, text)) return true;
  }
  return false;
}
