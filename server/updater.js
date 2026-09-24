'use strict';
// Over-the-air updates for self-hosted installs.
//
// Checks GitHub for the latest release, and on request (or automatically, if the
// owner turned that on) installs it in place:
//   - git installs:   fetch the release tag and check it out
//   - other installs: download the release tarball, install its dependencies in
//                     a temporary folder, then copy it over the program files
// Data lives in a separate folder (see db.js), so updates never touch it.
// After installing, the process exits with RESTART_CODE and launcher.js starts
// the new version.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const settings = require('./settings');

const REPO = 'ishaanman7898/ShareSecure';
const ROOT = path.join(__dirname, '..');
const RESTART_CODE = 75;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const TAG_RE = /^v\d+\.\d+\.\d+$/;

const currentVersion = require('../package.json').version;

const state = {
  latest: null,        // e.g. "1.7.0"
  releaseUrl: null,
  checkedAt: null,
  checkError: null,
  status: 'idle',      // idle | updating | restarting | restart-required | failed
  error: null,
};

const inDocker = fs.existsSync('/.dockerenv') || process.env.SHARESECURE_DOCKER === '1';
const underLauncher = process.env.SHARESECURE_LAUNCHER === '1';
// the desktop app's program files are read-only; it updates itself through electron-updater
const inDesktop = process.env.SHARESECURE_DESKTOP === '1';
const isGitInstall = fs.existsSync(path.join(ROOT, '.git'));

function newer(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

function run(cmd, args, cwd) {
  // npm is a .cmd shim on Windows and must go through the shell
  const shell = process.platform === 'win32' && cmd === 'npm';
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, shell, timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args[0]} failed: ${(stderr || err.message).toString().trim().split('\n').pop()}`));
      else resolve(stdout.toString());
    });
  });
}

async function check() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { 'User-Agent': 'ShareSecure-updater', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
    const release = await res.json();
    if (!TAG_RE.test(release.tag_name || '')) throw new Error('Unexpected release tag');
    state.latest = release.tag_name.slice(1);
    state.releaseUrl = release.html_url;
    state.checkError = null;
  } catch (err) {
    state.checkError = 'Couldn’t check for updates. Check your internet connection.';
  }
  state.checkedAt = new Date().toISOString();
  return status();
}

function status() {
  let blockedReason = null;
  if (inDocker) blockedReason = 'docker';
  else if (inDesktop) blockedReason = 'desktop';
  return {
    current: currentVersion,
    latest: state.latest,
    updateAvailable: Boolean(state.latest && newer(state.latest, currentVersion)),
    releaseUrl: state.releaseUrl,
    checkedAt: state.checkedAt,
    checkError: state.checkError,
    autoUpdate: settings.get('autoUpdate'),
    canUpdate: !blockedReason,
    blockedReason,
    status: state.status,
    error: state.error,
  };
}

// Older versions committed data/sharesecure.db to the repo. Checking out a
// release where it's no longer tracked would delete it, so move a copy aside
// and put it back afterwards.
function protectLegacyDb() {
  const dir = path.join(ROOT, 'data');
  const saved = [];
  for (const name of ['sharesecure.db', 'sharesecure.db-wal', 'sharesecure.db-shm']) {
    const fp = path.join(dir, name);
    if (fs.existsSync(fp)) {
      const copy = fp + '.updating';
      fs.copyFileSync(fp, copy);
      saved.push([copy, fp]);
    }
  }
  return () => {
    for (const [copy, fp] of saved) {
      if (!fs.existsSync(fp)) fs.renameSync(copy, fp);
      else fs.rmSync(copy, { force: true });
    }
  };
}

async function installFromGit(tag) {
  const previous = (await run('git', ['rev-parse', 'HEAD'], ROOT)).trim();
  require('./db').db.pragma('wal_checkpoint(TRUNCATE)');
  const restoreDb = protectLegacyDb();
  try {
    await run('git', ['fetch', '--depth=1', '--force', 'origin', `refs/tags/${tag}:refs/tags/${tag}`], ROOT);
    await run('git', ['checkout', '--force', tag], ROOT);
    restoreDb();
    await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], ROOT);
  } catch (err) {
    // roll back to the version that was running
    await run('git', ['checkout', '--force', previous], ROOT).catch(() => {});
    restoreDb();
    await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], ROOT).catch(() => {});
    throw err;
  }
}

async function installFromTarball(tag) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sharesecure-update-'));
  try {
    const res = await fetch(`https://codeload.github.com/${REPO}/tar.gz/refs/tags/${tag}`, {
      headers: { 'User-Agent': 'ShareSecure-updater' },
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const archive = path.join(tmp, 'release.tar.gz');
    fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    const src = path.join(tmp, 'src');
    fs.mkdirSync(src);
    // tar ships with Windows 10+, macOS and Linux. Paths are relative on purpose:
    // GNU tar (e.g. from Git for Windows) reads "C:\..." as a remote host.
    await run('tar', ['-xzf', path.basename(archive), '-C', path.basename(src), '--strip-components=1'], tmp);
    // install dependencies in the temp copy first, so a broken release never touches the running copy
    await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], src);
    // copy program files only: the loaded SQLite driver in node_modules is locked on Windows
    fs.cpSync(src, ROOT, {
      recursive: true,
      force: true,
      filter: from => !from.startsWith(path.join(src, 'node_modules')),
    });
    await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], ROOT);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

let restartHook = () => process.exit(RESTART_CODE);

async function apply() {
  if (state.status === 'updating' || state.status === 'restarting') return status();
  if (inDocker) throw new Error('Docker installs update by rebuilding the container.');
  if (inDesktop) throw new Error('The desktop app installs its own updates.');
  await check();
  if (!status().updateAvailable) return status();

  const tag = `v${state.latest}`;
  state.status = 'updating';
  state.error = null;
  try {
    if (isGitInstall) await installFromGit(tag);
    else await installFromTarball(tag);
  } catch (err) {
    state.status = 'failed';
    state.error = err.message;
    console.error('  [update] ' + err.message);
    return status();
  }

  console.log(`\n  [update] Installed ShareSecure ${state.latest}.`);
  if (underLauncher) {
    state.status = 'restarting';
    setTimeout(() => restartHook(), 500);
  } else {
    state.status = 'restart-required';
    console.log('  [update] Restart ShareSecure to finish updating.');
  }
  return status();
}

function setAutoUpdate(enabled) {
  settings.set('autoUpdate', Boolean(enabled));
  return status();
}

function start({ onRestart } = {}) {
  if (onRestart) restartHook = onRestart;
  const tick = async () => {
    await check();
    const s = status();
    if (s.updateAvailable && s.autoUpdate && s.canUpdate) await apply();
  };
  setTimeout(tick, 60 * 1000).unref();
  setInterval(tick, CHECK_EVERY_MS).unref();
}

module.exports = { status, check, apply, setAutoUpdate, start, RESTART_CODE };
