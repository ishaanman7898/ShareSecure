// Checks that a ShareSecure site serves exactly the code in this repository.
//
// End-to-end encryption in a browser is only as good as the page that does
// it: a server could hand someone a changed page that leaks their keys. So
// every file the browser runs (public/: scripts, pages, styles, the vendored
// pdf.js and mammoth) is fetched from the live site and compared, byte for
// byte, with the file in this checkout. Anyone can run it:
//
//   node scripts/verify-site.mjs                      checks https://sharesecure-du8.pages.dev
//   node scripts/verify-site.mjs https://your.site    checks another copy
//   node scripts/verify-site.mjs --wait 600           keeps trying for up to 10 minutes
//                                                     (while a new deploy rolls out)
//
// It prints the SHA-256 of every file, so the result can be compared with
// anyone else's, and exits non-zero if any file differs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const args = process.argv.slice(2);
const waitFlag = args.indexOf('--wait');
const waitS = waitFlag >= 0 ? Number(args.splice(waitFlag, 2)[1]) || 0 : 0;
const site = (args[0] || 'https://sharesecure-du8.pages.dev').replace(/\/+$/, '');

// Pages-only config files aren't served
const SKIP = new Set(['_redirects', '_headers']);

function files(dir, prefix = '') {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...files(full, rel));
    else if (!SKIP.has(rel)) out.push(rel);
  }
  return out;
}

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// Git on Windows may check text files out with CRLF line endings; the deploy
// has LF, so compare the LF form of text files.
const TEXT = /\.(html|js|mjs|css|json|svg|txt|sh|ps1)$/;
const normalize = (rel, bytes) => TEXT.test(rel) ? Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n')) : bytes;

async function check() {
  const differences = [];
  const lines = [];
  for (const rel of files(root)) {
    const local = normalize(rel, fs.readFileSync(path.join(root, rel)));
    let served;
    try {
      const res = await fetch(`${site}/${rel.split('/').map(encodeURIComponent).join('/')}`, { redirect: 'follow', headers: { 'Cache-Control': 'no-cache' } });
      served = res.ok ? normalize(rel, Buffer.from(await res.arrayBuffer())) : null;
      if (!served) differences.push(`${rel}: the site answered ${res.status}`);
    } catch (err) {
      differences.push(`${rel}: ${err.message}`);
    }
    const ok = served && sha256(served) === sha256(local);
    if (served && !ok) differences.push(`${rel}: different content`);
    lines.push(`${ok ? 'ok  ' : 'DIFF'} ${sha256(local)}  ${rel}`);
  }
  return { differences, lines };
}

const deadline = Date.now() + waitS * 1000;
for (;;) {
  const { differences, lines } = await check();
  if (!differences.length || Date.now() > deadline) {
    console.log(lines.join('\n'));
    if (differences.length) {
      console.error(`\n${site} does NOT match this checkout:\n  ${differences.join('\n  ')}`);
      process.exitCode = 1;
    } else {
      console.log(`\n${site} serves exactly the ${lines.length} files in this checkout.`);
    }
    break;
  }
  await new Promise(r => setTimeout(r, 30000));
}
