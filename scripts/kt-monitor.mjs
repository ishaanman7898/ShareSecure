// Checks the whole public key log of a ShareSecure site (see public/kt.js).
//
//   node scripts/kt-monitor.mjs [site] [--heads file] [--write]
//
// It downloads every entry and checks:
//   1. the entries hash to the root the site publishes;
//   2. no account changed key without being deleted first (a second key for
//      someone is exactly what a server trying to read their files would add);
//   3. with --heads, every log recorded in that file (one JSON line per check)
//      is still the start of today's log, so nothing was rewritten or dropped.
// With --write, today's log is added to the file. Exits non-zero on any problem.
import fs from 'node:fs';
import { leafHash, rootOf } from '../public/kt.js';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); if (i < 0) return null; const [, v] = args.splice(i, 2); return v ?? true; };
const write = args.includes('--write') ? (args.splice(args.indexOf('--write'), 1), true) : false;
const headsFile = flag('--heads');
const site = (args[0] || 'https://sharesecure-du8.pages.dev').replace(/\/+$/, '');

async function get(path) {
  const res = await fetch(site + path, { headers: { 'Cache-Control': 'no-cache' } });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

const problems = [];
const head = await get('/api/transparency');
const all = [];
while (all.length < head.size) {
  const { entries } = await get(`/api/transparency?start=${all.length}&count=1000`);
  if (!entries.length) break;
  all.push(...entries);
}
if (all.length < head.size) problems.push(`The site says the log has ${head.size} entries but only gave ${all.length}.`);
all.length = Math.min(all.length, head.size);
all.forEach((e, i) => { if (e.index !== i) problems.push(`Entry ${i} came back numbered ${e.index}.`); });

// 1. the entries hash to the published root
const leaves = [];
for (const e of all) leaves.push(await leafHash(e.label, e.kind, e.public_key));
const root = await rootOf(leaves);
if (root !== head.root) problems.push(`The entries hash to ${root}, but the site publishes ${head.root}.`);

// 2. one key per account at a time
const current = new Map();
for (const e of all) {
  if (e.kind === 'gone') { current.delete(e.label); continue; }
  if (e.kind !== 'key') { problems.push(`Entry ${e.index} has an unknown kind "${e.kind}".`); continue; }
  const had = current.get(e.label);
  if (had && had !== e.public_key) problems.push(`Entry ${e.index}: account ${e.label.slice(0, 16)}… got a second, different key without being deleted.`);
  current.set(e.label, e.public_key);
}

// 3. every log seen before is the start of this one
const seen = headsFile && fs.existsSync(headsFile)
  ? fs.readFileSync(headsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  : [];
for (const old of seen) {
  if (old.size > leaves.length) { problems.push(`A log of ${old.size} entries was recorded before, but today's has only ${leaves.length}.`); continue; }
  if ((await rootOf(leaves.slice(0, old.size))) !== old.root) problems.push(`The log recorded on ${old.checked_at} (size ${old.size}) isn't the start of today's: history was rewritten.`);
}

console.log(`${site}: ${head.size} entries, root ${head.root}, ${current.size} accounts with a key.`);
if (problems.length) {
  console.error(`\nProblems:\n  ${problems.join('\n  ')}`);
  process.exitCode = 1;
} else {
  console.log('Every check passed.');
  const last = seen.at(-1);
  if (write && headsFile && (!last || last.size !== head.size || last.root !== head.root)) {
    fs.appendFileSync(headsFile, JSON.stringify({ size: head.size, root: head.root, checked_at: new Date().toISOString() }) + '\n');
    console.log(`Recorded in ${headsFile}.`);
  }
}
