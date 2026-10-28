'use strict';
// ShareSecure desktop. On first launch you choose how to use it:
//   account  sign in to your ShareSecure account (the website, in its own window)
//   local    run a private ShareSecure on this computer. Its server runs in a
//            process of its own, which outlives the app: share links keep
//            working after you quit, until the last one expires
const { app, BrowserWindow, Tray, Menu, shell, nativeImage, Notification, dialog, session, ipcMain, safeStorage, net: electronNet } = require('electron');
const { fork } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

// a dev run (npm run desktop) never touches the installed app's data or lock
if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'ShareSecure-dev'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

const CLOUD = 'https://sharesecure-du8.pages.dev';
// set when the app restarts to create an account (see createAccount)
const NEW_ACCOUNT_FLAG = '--new-account';
// set when Windows starts the app at sign-in: bring the links back up, no window
const BACKGROUND_FLAG = '--background';

// Program files are read-only once packaged, so settings, the encryption key
// and every stored file live in the user's app-data folder. It's a separate
// folder from a command-line install, which has its own encryption key.
const USER_DIR = app.getPath('userData');
const DATA_DIR = path.join(USER_DIR, 'data');
const PORT_FILE = path.join(USER_DIR, 'port.json');
const MODE_FILE = path.join(USER_DIR, 'mode.json');
// the running server's process id and port, so the next launch can find it
const SERVER_FILE = path.join(USER_DIR, 'server.json');
const UPDATES_FILE = path.join(USER_DIR, 'updates.json');
// your saved sign-in, encrypted by the operating system (see saved sign-in below)
const SIGNIN_FILE = path.join(USER_DIR, 'signin.json');
const PROTECT_FILE = path.join(USER_DIR, 'protection.json');
// the full-bleed tile reads better at window and tray sizes than the Mac-grid one
const ICON = path.join(__dirname, 'icon-win.png');

let win = null;
let tray = null;
let quitting = false;
let mode = null;     // 'account' | 'local' | null until chosen
let origin = '';
let toldAboutTray = false;
let server = null;      // this computer's server process, while the app runs it
let publicBase = null;  // the public address share links are made with (the tunnel)

function readMode() {
  try {
    const m = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8')).mode;
    if (m === 'account' || m === 'local') return m;
  } catch {}
  // 1.8.0 only had local mode: anyone with a local database keeps it
  return fs.existsSync(path.join(DATA_DIR, 'sharesecure.db')) ? 'local' : null;
}

function saveMode(m) {
  fs.mkdirSync(USER_DIR, { recursive: true });
  fs.writeFileSync(MODE_FILE, JSON.stringify({ mode: m }));
}

function portFree(port) {
  return new Promise(resolve => {
    const probe = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => probe.close(() => resolve(true)))
      .listen(port, '127.0.0.1');
  });
}

// Keep the same port between launches: the page's saved state (your share list,
// owner keys) belongs to the origin, and a new port would be a new origin.
async function choosePort() {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(PORT_FILE, 'utf8')).port; } catch {}
  for (const port of [saved, 3000, 3100, 3200, 4300, 5300].filter(Boolean)) {
    if (await portFree(port)) {
      fs.mkdirSync(USER_DIR, { recursive: true });
      fs.writeFileSync(PORT_FILE, JSON.stringify({ port }));
      return port;
    }
  }
  throw new Error('No free port for ShareSecure');
}

async function waitForServer(url) {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${url}/api/mode`);
      if (res.ok) return;
    } catch { /* not listening yet */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('ShareSecure didn’t start');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// A server left running after the app quit (keeping links up) has no line back
// to this app. Stop it, and start one this app can talk to, on the same port.
async function stopLeftoverServer() {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8')); } catch {}
  if (!saved?.pid || !isRunning(saved.pid)) return;
  // only if ShareSecure is what answers on its port, not some process that got its id
  try {
    const res = await fetch(`http://localhost:${saved.port}/api/mode`, { signal: AbortSignal.timeout(2000) });
    if (!(await res.json()).selfHostMode) return;
  } catch { return; }
  try { process.kill(saved.pid); } catch { return; }
  for (let i = 0; i < 50 && (isRunning(saved.pid) || !(await portFree(saved.port))); i++) await sleep(100);
}

async function startServer() {
  await stopLeftoverServer();
  const port = await choosePort();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const log = fs.openSync(path.join(USER_DIR, 'server.log'), 'w');
  // the app's own binary run as Node, detached so it can outlive the app
  server = fork(path.join(__dirname, 'server-process.js'), [], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(port),
      DATA_DIR,
      ENV_FILE: path.join(DATA_DIR, '.env'),
      SHARESECURE_DESKTOP: '1',
      // where sending to a username goes, once you link your ShareSecure account
      SHARESECURE_CLOUD: CLOUD,
    },
    stdio: ['ignore', log, log, 'ipc'],
    detached: true,
    windowsHide: true,
  });
  fs.closeSync(log);
  server.unref();
  fs.writeFileSync(SERVER_FILE, JSON.stringify({ pid: server.pid, port }));
  const started = server;
  let ready = false;
  started.once('exit', () => {
    if (server === started) server = null;
    // it stopped while the app still needs it: start it again
    if (ready && !quitting && mode === 'local') {
      startServer().then(() => win?.loadURL(origin)).catch(err => dialog.showErrorBox('ShareSecure stopped', err.message));
    }
  });
  origin = `http://localhost:${port}`;
  await waitForServer(origin);
  ready = true;
  await refreshPublicBase();
}

function stopServer() {
  if (server?.connected) server.send('stop');
}

// Share links point at the public tunnel, whose address the server picks.
async function refreshPublicBase() {
  try {
    const res = await fetch(`${origin}/api/mode`);
    publicBase = (await res.json()).publicUrl || publicBase;
  } catch {}
}
setInterval(() => { if (server) refreshPublicBase(); }, 30 * 1000);

// Whether any link is still live, that is, whether quitting leaves the server sharing.
function hasLiveLinks() {
  if (!server?.connected) return Promise.resolve(false);
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 1000);
    server.once('message', message => { clearTimeout(timer); resolve(message?.live === true); });
    server.send('live?');
  });
}

// Links that belong in the app window. In local mode, share links point at the
// public tunnel; open them on localhost instead, which skips its warning page.
function inApp(url) {
  try {
    const u = new URL(url);
    if (mode === 'account') return u.origin === CLOUD ? url : null;
    const base = publicBase && new URL(publicBase);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || (base && u.host === base.host)) {
      return origin + u.pathname + u.search + u.hash;
    }
  } catch {}
  return null;
}

function wireLinks(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    const target = inApp(url);
    if (target) openWindow(target, { width: 1100, height: 820 });
    else if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (inApp(url) || url.startsWith('file:')) return;
    e.preventDefault();
    // "Create an account" on this computer's sign-in page
    if (url.startsWith(`${CLOUD}/signin`)) return createAccount();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
}

function openWindow(url, { maximize = false, ...size }) {
  const w = new BrowserWindow({
    ...size,
    minWidth: 380,
    minHeight: 560,
    title: 'ShareSecure',
    icon: ICON,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js') },
  });
  wireLinks(w.webContents);
  // a page has to ask again (protection:viewing): leaving a file un-hides the window
  w.webContents.on('did-navigate', () => w.setContentProtection(false));
  w.once('ready-to-show', () => {
    if (maximize) w.maximize();
    w.show();
  });
  if (url) w.loadURL(url);
  return w;
}

function mainUrl(newAccount = false) {
  if (mode !== 'account') return origin;
  return newAccount ? `${CLOUD}/signin?new=1` : `${CLOUD}/signin`;
}

function createMain(url) {
  // fills the screen at launch; un-maximizing goes back to this size
  win = openWindow(url, { width: 1240, height: 820, maximize: true });
  win.on('close', e => {
    // with an account there's no server to keep alive, so closing quits
    if (quitting || mode !== 'local') return;
    e.preventDefault();
    win.hide();
    if (!toldAboutTray && Notification.isSupported()) {
      toldAboutTray = true;
      new Notification({
        title: 'ShareSecure is still running',
        body: 'Your links keep working, even after you quit, until they expire. To stop them, choose Stop sharing and quit from the tray icon.',
        icon: ICON,
      }).show();
    }
  });
  win.on('closed', () => {
    win = null;
    if (mode !== 'local' && !quitting) app.quit();
  });
}

function showMain() {
  if (!mode) return showWelcome();
  if (!win || win.isDestroyed()) return createMain(mainUrl());
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// First launch: pick "sign in to your account" or "run it on this computer".
// The page's buttons change the URL hash, which we listen for here.
function showWelcome() {
  if (win && !win.isDestroyed()) { win.show(); return; }
  createMain(null);
  win.loadFile(path.join(__dirname, 'welcome.html'));
  win.webContents.on('did-navigate-in-page', async (_e, url) => {
    const choice = new URL(url).hash.slice(1);
    if (!['account', 'account-new', 'local'].includes(choice)) return;
    const chosen = choice === 'local' ? 'local' : 'account';
    saveMode(chosen);
    await start(chosen);
    win.loadURL(mainUrl(choice === 'account-new'));
    buildTrayMenu();
  });
}

async function start(chosen) {
  mode = chosen;
  startAtSignIn(mode === 'local');
  if (updater) updater.autoInstallOnAppQuit = mode !== 'local';
  if (mode === 'local') {
    try {
      await startServer();
    } catch (err) {
      dialog.showErrorBox('ShareSecure couldn’t start', err.message);
      app.exit(1);
    }
  } else {
    origin = CLOUD;
  }
}

// Opens sign-up for a ShareSecure account. From this computer's own
// ShareSecure that means switching to an account, which needs a restart.
async function createAccount() {
  if (mode === 'account') {
    showMain();
    win.loadURL(mainUrl(true));
    return;
  }
  if (!mode) {
    saveMode('account');
    await start('account');
    showMain();
    win.loadURL(mainUrl(true));
    buildTrayMenu();
    return;
  }
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: 'ShareSecure',
    buttons: ['Create an account', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'Create a ShareSecure account?',
    detail: 'ShareSecure will restart with your account. The files on this computer stay, but their links stop working until you switch back from the tray icon.',
  });
  if (response !== 0) return;
  saveMode('account');
  stopServer();
  quitting = true;
  app.relaunch({ args: [...process.argv.slice(1).filter(a => a !== NEW_ACCOUNT_FLAG), NEW_ACCOUNT_FLAG] });
  app.exit(0);
}

// Switching needs a fresh start: a local server can't be stopped in place.
async function changeMode() {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: 'ShareSecure',
    buttons: ['Choose again', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'Choose how to use ShareSecure',
    detail: 'ShareSecure will restart and ask whether to sign in to your account or run it on this computer. Nothing is deleted.',
  });
  if (response !== 0) return;
  try { fs.unlinkSync(MODE_FILE); } catch {}
  stopServer();
  quitting = true;
  app.relaunch();
  app.exit(0);
}

function buildTrayMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open ShareSecure', click: showMain },
    { label: 'Create a ShareSecure account…', click: createAccount },
    ...(mode === 'local' ? [{ label: 'Open data folder', click: () => shell.openPath(DATA_DIR) }] : []),
    { label: 'Switch between account and this computer…', click: changeMode, enabled: Boolean(mode) },
    { type: 'separator' },
    // reachable from the welcome screen too, before anything is set up
    { label: 'Privacy policy', click: () => openWindow(`${origin || CLOUD}/privacy`, { width: 900, height: 820 }) },
    { label: 'Terms', click: () => openWindow(`${origin || CLOUD}/terms`, { width: 900, height: 820 }) },
    { type: 'separator' },
    { label: 'Quit ShareSecure', click: quit },
    ...(mode === 'local' ? [{ label: 'Stop sharing and quit', click: () => { stopServer(); quit(); } }] : []),
  ]));
}

async function quit() {
  quitting = true;
  if (mode === 'local' && await hasLiveLinks() && Notification.isSupported()) {
    new Notification({
      title: 'Your links keep working',
      body: 'ShareSecure keeps sharing in the background until your links expire, then stops by itself.',
      icon: ICON,
    }).show();
  }
  app.quit();
}

// Windows starts the app at sign-in, in the background, so links on this
// computer come back after a restart. With none live, it exits right away.
function startAtSignIn(on) {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: on, args: [BACKGROUND_FLAG] });
}

function createTray() {
  // the folder without most of the tile's margin, so it reads at tray size
  const full = nativeImage.createFromPath(ICON);
  const { width } = full.getSize();
  const inset = Math.round(width * 0.16);
  const image = full.crop({ x: inset, y: inset, width: width - 2 * inset, height: width - 2 * inset })
    .resize({ width: 16, height: 16, quality: 'best' });
  tray = new Tray(image);
  tray.setToolTip('ShareSecure');
  buildTrayMenu();
  tray.on('click', showMain);
}

// ── updates ─────────────────────────────────────────────────────────────────
// Shown under Updates in the account menu (see preload.js). In local mode an
// update waits for "Restart to update" instead of installing on quit: quitting
// leaves the server sharing, and installing would stop it.
const updates = {
  current: app.getVersion(),
  status: app.isPackaged ? 'idle' : 'development',
  latest: null,
  progress: 0,
  error: null,
  autoUpdate: true,
};
let updater = null;

const updateState = () => ({ ...updates, local: mode === 'local' });

function setUpdates(patch) {
  Object.assign(updates, patch);
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('updates:status', updateState());
}

function checkForUpdates() {
  if (!updater || ['downloading', 'downloaded'].includes(updates.status)) return Promise.resolve();
  return updater.checkForUpdates().catch(() => {});
}

function downloadUpdate() {
  setUpdates({ status: 'downloading', progress: 0 });
  updater.downloadUpdate().catch(() => {});
}

function initUpdates() {
  try { updates.autoUpdate = JSON.parse(fs.readFileSync(UPDATES_FILE, 'utf8')).autoUpdate !== false; } catch {}
  if (!app.isPackaged) return;
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch { return; /* updates are best effort */ }
  updater.autoDownload = updates.autoUpdate;
  updater.autoInstallOnAppQuit = mode !== 'local';
  updater.on('checking-for-update', () => setUpdates({ status: 'checking', error: null }));
  updater.on('update-not-available', info => setUpdates({ status: 'up-to-date', latest: info.version }));
  updater.on('update-available', info => setUpdates({ status: updater.autoDownload ? 'downloading' : 'available', latest: info.version, progress: 0 }));
  updater.on('download-progress', p => setUpdates({ status: 'downloading', progress: Math.round(p.percent) }));
  updater.on('update-downloaded', info => setUpdates({ status: 'downloaded', latest: info.version }));
  updater.on('error', err => setUpdates({ status: 'error', error: String(err?.message || 'Something went wrong').split('\n')[0].slice(0, 160) }));
  checkForUpdates();
  setInterval(checkForUpdates, 6 * 60 * 60 * 1000);
}

// Only the app's own pages, in the top frame, may ask.
function fromApp(event) {
  const frame = event.senderFrame;
  if (!frame || frame.parent) return false;
  try {
    const from = new URL(frame.url).origin;
    return from === CLOUD || (origin !== '' && from === new URL(origin).origin);
  } catch { return false; }
}

ipcMain.handle('updates:status', e => (fromApp(e) ? updateState() : null));
ipcMain.handle('updates:check', async e => {
  if (!fromApp(e)) return null;
  await checkForUpdates();
  return updateState();
});
ipcMain.handle('updates:install', e => {
  if (!fromApp(e) || !updater) return null;
  if (updates.status === 'available') downloadUpdate();
  else if (updates.status === 'downloaded') {
    // the server stops for the install, and starts again when the app reopens
    setImmediate(() => { quitting = true; stopServer(); updater.quitAndInstall(true, true); });
  }
  return updateState();
});
ipcMain.handle('updates:auto', (e, on) => {
  if (!fromApp(e)) return null;
  updates.autoUpdate = on === true;
  try { fs.writeFileSync(UPDATES_FILE, JSON.stringify({ autoUpdate: updates.autoUpdate })); } catch {}
  if (updater) {
    updater.autoDownload = updates.autoUpdate;
    if (updates.autoUpdate && updates.status === 'available') downloadUpdate();
  }
  setUpdates({});
  return updateState();
});

// ── hiding files from screenshots ───────────────────────────────────────────
// Windows and macOS can leave a window out of screenshots and screen
// recordings (it shows up black). A window gets that while it shows a file
// whose sender chose "discourage screenshots", or any view-only file when the
// setting below is on. It's off by default. Linux has no such thing.
function readProtection() {
  try { return { hideViewOnly: JSON.parse(fs.readFileSync(PROTECT_FILE, 'utf8')).hideViewOnly === true }; } catch { return { hideViewOnly: false }; }
}
const protectionState = () => ({ ...readProtection(), supported: process.platform === 'win32' || process.platform === 'darwin' });

ipcMain.handle('protection:get', e => (fromApp(e) ? protectionState() : null));
ipcMain.handle('protection:set', (e, on) => {
  if (!fromApp(e)) return null;
  try {
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.writeFileSync(PROTECT_FILE, JSON.stringify({ hideViewOnly: on === true }));
  } catch {}
  return protectionState();
});
ipcMain.handle('protection:viewing', (e, { viewOnly, discourage } = {}) => {
  if (!fromApp(e)) return false;
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return false;
  const hide = discourage === true || (viewOnly === true && readProtection().hideViewOnly);
  w.setContentProtection(hide);
  return hide;
});

// ── saved sign-in ───────────────────────────────────────────────────────────
// The app remembers your username and password so it signs you in at launch.
// They're encrypted with the operating system's key store (safeStorage), one
// per site: your account and this computer's ShareSecure each have their own.
// Signing out or deleting the account forgets them.
function canEncrypt() {
  if (!safeStorage.isEncryptionAvailable()) return false;
  // on Linux without a keyring this would be a fixed, public key
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
}

function readSignIns() {
  try { return JSON.parse(fs.readFileSync(SIGNIN_FILE, 'utf8')); } catch { return {}; }
}

function writeSignIns(all) {
  fs.mkdirSync(USER_DIR, { recursive: true });
  fs.writeFileSync(SIGNIN_FILE, JSON.stringify(all), { mode: 0o600 });
}

const siteOf = event => new URL(event.senderFrame.url).origin;

ipcMain.handle('signin:load', e => {
  if (!fromApp(e) || !canEncrypt()) return null;
  const saved = readSignIns()[siteOf(e)];
  if (!saved) return null;
  try {
    const { username, password } = JSON.parse(safeStorage.decryptString(Buffer.from(saved, 'base64')));
    return typeof username === 'string' && typeof password === 'string' ? { username, password } : null;
  } catch { return null; }
});
ipcMain.handle('signin:save', (e, username, password) => {
  if (!fromApp(e) || !canEncrypt() || typeof username !== 'string' || typeof password !== 'string') return false;
  const all = readSignIns();
  all[siteOf(e)] = safeStorage.encryptString(JSON.stringify({ username, password })).toString('base64');
  writeSignIns(all);
  return true;
});
ipcMain.handle('signin:forget', e => {
  if (!fromApp(e)) return false;
  const all = readSignIns();
  delete all[siteOf(e)];
  writeSignIns(all);
  return true;
});

app.on('second-instance', (_e, argv) => { if (!argv.includes(BACKGROUND_FLAG)) showMain(); });
app.on('activate', showMain);
app.on('before-quit', () => { quitting = true; });
// in local mode stay alive in the tray when every window is closed
app.on('window-all-closed', () => { if (mode !== 'local') app.quit(); });

// ── the website's page code comes from this app ─────────────────────────────
// With an account, the window shows the ShareSecure website. Its pages and
// scripts (the code that encrypts your files) are served from the copy inside
// this app, not downloaded, so a compromised server can't change that code.
// Only the API (/api, /mcp, /connect) goes over the network.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const { bundledFile: findFile, TYPES } = require('./site-files');
const PAGE_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; " +
  "frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const bundledFile = pathname => findFile(PUBLIC_DIR, pathname);

function serveBundledSite() {
  session.defaultSession.protocol.handle('https', async request => {
    const url = new URL(request.url);
    const isPage = url.origin === CLOUD && request.method === 'GET' && !/^\/(api|mcp|connect)(\/|$)/.test(url.pathname);
    const file = isPage && bundledFile(url.pathname);
    if (file) {
      const type = TYPES[path.extname(file)];
      return new Response(fs.readFileSync(path.join(PUBLIC_DIR, file)), {
        headers: {
          'Content-Type': type,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': type.startsWith('text/html') ? PAGE_CSP : "frame-ancestors 'none'",
        },
      });
    }
    return electronNet.fetch(request, { bypassCustomProtocolHandlers: true });
  });
}

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('app.sharesecure.desktop');
  serveBundledSite();
  // lets pages hide their "get the app" and "host it yourself" links in here
  app.userAgentFallback = `${app.userAgentFallback} ShareSecureDesktop/${app.getVersion()}`;
  const saved = readMode();
  if (process.argv.includes(BACKGROUND_FLAG)) {
    // started at sign-in: start the server and leave it sharing on its own
    if (saved === 'local') await start(saved);
    app.exit(0);
    return;
  }
  if (saved) await start(saved);
  createTray();
  if (mode === 'account' && process.argv.includes(NEW_ACCOUNT_FLAG)) createMain(mainUrl(true));
  else showMain();
  initUpdates();
});
