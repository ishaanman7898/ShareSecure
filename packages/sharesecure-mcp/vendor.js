// Copies the website's own encryption code into lib/, so this package runs
// exactly the code the browser runs. Runs before every npm pack/publish; run it
// by hand (npm run vendor) when working from the repository.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.join(here, '..', '..', 'public');
const lib = path.join(here, 'lib');

fs.mkdirSync(lib, { recursive: true });
for (const file of ['sealed.js', 'opaque.js', 'p256.js', 'filetypes.js', 'blindrsa.js', 'tokens.js']) {
  fs.copyFileSync(path.join(site, file), path.join(lib, file));
}
fs.writeFileSync(path.join(lib, 'package.json'), '{ "type": "module" }\n');
console.log('Copied the website’s encryption code into lib/.');
