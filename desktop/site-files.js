'use strict';
// Which file inside the app's own copy of the website answers a path, for the
// desktop app (see serveBundledSite in main.js). Kept apart from main.js so the
// tests can check it never reaches outside that folder.
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

// "/r/abc" → viewer.html, "/signin" → signin.html, … or null for anything else
function bundledFile(publicDir, pathname) {
  if (pathname === '/') return 'index.html';
  if (/^\/r\/[A-Za-z0-9]+$/.test(pathname)) return 'viewer.html';
  if (/^\/drop\/[A-Za-z0-9]+$/.test(pathname)) return 'drop.html';
  let rel;
  try { rel = decodeURIComponent(pathname).replace(/^\/+/, ''); } catch { return null; }
  // no climbing out, no Windows paths, no drive letters, no hidden files
  if (!rel || rel.includes('..') || rel.includes('\\') || rel.includes(':') || rel.includes('\0') || /(^|\/)\./.test(rel)) return null;
  for (const name of [rel, rel + '.html']) {
    const full = path.resolve(publicDir, name);
    if (!full.startsWith(path.resolve(publicDir) + path.sep) || !TYPES[path.extname(name)]) continue;
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return name;
  }
  return null;
}

module.exports = { bundledFile, TYPES };
