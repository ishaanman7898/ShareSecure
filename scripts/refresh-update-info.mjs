// Signing an installer after electron-builder made it changes its bytes, so the
// sha512 and size the in-app updater checks (dist/latest*.yml) go stale and
// every update would fail its check. This rewrites them from the files as they
// are now, and removes the installers' blockmaps, which also describe the old
// bytes (without one, an update downloads the whole installer instead).
//
//   node scripts/refresh-update-info.mjs dist/latest.yml
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

const sha512 = file => createHash('sha512').update(readFileSync(file)).digest('base64');

for (const yml of process.argv.slice(2)) {
  const dir = dirname(yml);
  const lines = readFileSync(yml, 'utf8').split('\n');
  let file = null;
  const out = lines.map(line => {
    const url = /^\s*-?\s*(?:url|path):\s*(.+?)\s*$/.exec(line);
    if (url) {
      file = join(dir, url[1]);
      if (!existsSync(file)) throw new Error(`${yml} lists ${url[1]}, which isn't in ${dir}`);
      rmSync(file + '.blockmap', { force: true });
      return line;
    }
    if (!file) return line;
    const hash = /^(\s*)sha512:\s*/.exec(line);
    if (hash) return `${hash[1]}sha512: ${sha512(file)}`;
    const size = /^(\s*)size:\s*/.exec(line);
    if (size) return `${size[1]}size: ${readFileSync(file).length}`;
    return line;
  });
  writeFileSync(yml, out.join('\n'));
  console.log(`updated ${yml}`);
}
