'use strict';
// ShareSecure desktop: a private ShareSecure that runs on this computer. Its
// server runs in a process of its own (server-process.js). Share links keep
// working after you quit, until the last one expires: the app starts again in
// the background, with no window, just to serve them. Your ShareSecure
// account is the website; the app only links to it to send files to usernames.
const { app, BrowserWindow, Tray, Menu, shell, nativeImage, Notification, dialog, ipcMain, safeStorage, session, utilityProcess, powerMonitor, net: electronNet } = require('electron');
const fs = require('fs');
const net = require('net');
const path = require('path');
const util = require('util');

// a dev run (npm run desktop) never touches the installed app's data or lock
if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'ShareSecure-dev'));

// Set when the app starts only to keep links up: by Windows at sign-in, or by
// the app itself when you quit with links still live (see quit). No window, no
// tray: just the server, in this process (runInBackground).
const BACKGROUND_FLAG = '--background';
const BACKGROUND = process.argv.includes(BACKGROUND_FLAG);
if (BACKGROUND) {
  // Nothing is ever drawn, so Chromium's GPU and network helpers stay inside
  // this process instead of starting their own: one process, about 25 MB more
  // than the server alone, instead of the whole app's four or five.
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess2');
  app.dock?.hide();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

// the website: where sending to a username goes, and the changelog
const CLOUD = 'https://sharesecure-du8.pages.dev';

// Program files are read-only once packaged, so settings, the encryption key
// and every stored file live in the user's app-data folder. It's a separate
// folder from a command-line install, which has its own encryption key.
const USER_DIR = app.getPath('userData');
const DATA_DIR = path.join(USER_DIR, 'data');
const PORT_FILE = path.join(USER_DIR, 'port.json');
// up to 1.19 the app could also show your account instead; see forgetAccountMode
const MODE_FILE = path.join(USER_DIR, 'mode.json');
// the running server's process id and port, so the next launch can find it
const SERVER_FILE = path.join(USER_DIR, 'server.json');
const UPDATES_FILE = path.join(USER_DIR, 'updates.json');
// your saved sign-in, encrypted by the operating system (see saved sign-in below)
const SIGNIN_FILE = path.join(USER_DIR, 'signin.json');
const PROTECT_FILE = path.join(USER_DIR, 'protection.json');
// which notifications you want, and the one-time ones already shown
const NOTIFY_FILE = path.join(USER_DIR, 'notifications.json');
// the full-bleed tile reads better at window and tray sizes than the Mac-grid one
const ICON = path.join(__dirname, 'icon-win.png');

let win = null;
let tray = null;
let quitting = false;
let origin = '';
let server = null;      // this computer's server (a utility process), while the app runs it
let publicBase = null;  // the public address share links are made with (the website's /l/<this computer>)
let liveKnown = false;  // whether a link was live when last asked
let shuttingDown = false;

// The server listens on every address (IPv6 and IPv4), so probe both: a
// server holding only one of them still answers http://localhost:<port>.
function portFreeOn(port, host) {
  return new Promise(resolve => {
    const probe = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => probe.close(() => resolve(true)))
      .listen(port, host);
  });
}
const portFree = async port => (await portFreeOn(port, '::')) && (await portFreeOn(port, '127.0.0.1'));

// Keep the same port between launches: the page's saved state (your share list,
// owner keys) belongs to the origin, and a new port would be a new origin.
// Starting again (into the background, or out of it) frees it a moment later.
async function choosePort() {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(PORT_FILE, 'utf8')).port; } catch {}
  for (let i = 0; saved && i < 15 && !(await portFree(saved)); i++) await sleep(200);
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

// A server left running by an older version (up to 1.27, the server kept
// running on its own after you quit) has no line back to this app. Stop it,
// and start one this app can talk to, on the same port.
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

function serverEnv(port) {
  return {
    ...process.env,
    PORT: String(port),
    // only this computer can connect; links come in through the relay
    HOST: '127.0.0.1',
    DATA_DIR,
    ENV_FILE: path.join(DATA_DIR, '.env'),
    SHARESECURE_DESKTOP: '1',
    // where sending to a username goes, once you link your ShareSecure account
    SHARESECURE_CLOUD: CLOUD,
  };
}

// While the app is open, the server is its utility process: Node.js that
// Electron starts and stops with the app. (No program can run this app's own
// binary as plain Node any more: see electronFuses in package.json.)
async function startServer() {
  await stopLeftoverServer();
  const port = await choosePort();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const started = utilityProcess.fork(path.join(__dirname, 'server-process.js'), [], {
    env: serverEnv(port),
    stdio: 'pipe',
    serviceName: 'ShareSecure server',
  });
  server = started;
  const log = fs.createWriteStream(path.join(USER_DIR, 'server.log'));
  started.stdout?.pipe(log, { end: false });
  started.stderr?.pipe(log, { end: false });
  started.once('spawn', () => fs.writeFileSync(SERVER_FILE, JSON.stringify({ pid: started.pid, port })));
  started.on('message', message => { if (message?.type === 'notify') notifyFromServer(message); });
  let ready = false;
  started.once('exit', () => {
    log.end();
    if (server === started) server = null;
    // it stopped while the app still needs it: start it again
    if (ready && !quitting) {
      startServer().then(() => win?.loadURL(origin)).catch(err => dialog.showErrorBox('ShareSecure stopped', err.message));
    }
  });
  origin = `http://localhost:${port}`;
  await waitForServer(origin);
  ready = true;
  await refreshPublicBase();
  liveKnown = await hasLiveLinks();
}

function stopServer() {
  try { server?.postMessage('stop'); } catch {}
}

// Share links point at the website's address for this computer (server/relay.js).
async function refreshPublicBase() {
  try {
    const res = await fetch(`${origin}/api/mode`);
    publicBase = (await res.json()).publicUrl || publicBase;
  } catch {}
}
setInterval(async () => {
  if (!server) return;
  refreshPublicBase();
  liveKnown = await hasLiveLinks();
}, 30 * 1000);

// Whether any link is still live, that is, whether quitting should keep sharing.
function hasLiveLinks() {
  const asked = server;
  if (!asked) return Promise.resolve(false);
  return new Promise(resolve => {
    const timer = setTimeout(() => { asked.off('message', onReply); resolve(false); }, 1000);
    function onReply(message) {
      if (typeof message?.live !== 'boolean') return;
      clearTimeout(timer);
      asked.off('message', onReply);
      resolve(message.live);
    }
    asked.on('message', onReply);
    try { asked.postMessage('live?'); } catch { clearTimeout(timer); asked.off('message', onReply); resolve(false); }
  });
}

// Starts this app again once it has quit. An AppImage runs from a folder
// that's gone by then, so it's the AppImage itself that starts.
function relaunch(args) {
  app.relaunch({ args, ...(process.env.APPIMAGE ? { execPath: process.env.APPIMAGE } : {}) });
}
const argsWithout = flag => process.argv.slice(1).filter(arg => arg !== flag);

// Quitting with links still live starts the app again in the background,
// where only the server runs (a fraction of the whole app), and it stops by
// itself once the last link has expired.
const keepLinksUp = () => relaunch([...argsWithout(BACKGROUND_FLAG), BACKGROUND_FLAG]);

// ── in the background ───────────────────────────────────────────────────────
// The server runs in this process until the last link expires (then
// server-process.js stops it). Its log goes on in server.log.
async function runInBackground() {
  app.dock?.hide();
  startAtSignIn(true);
  try {
    await stopLeftoverServer();
    const port = await choosePort();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const log = fs.createWriteStream(path.join(USER_DIR, 'server.log'), { flags: 'a' });
    for (const level of ['log', 'info', 'warn', 'error']) console[level] = (...parts) => log.write(`${util.format(...parts)}\n`);
    Object.assign(process.env, serverEnv(port));
    fs.writeFileSync(SERVER_FILE, JSON.stringify({ pid: process.pid, port }));
    require('./server-process');
    // and say if ShareSecure updated itself since you last used it
    announceUpdate();
  } catch (err) {
    console.error('background start failed:', err.message);
    app.exit(1);
  }
}

// Opening ShareSecure while it's in the background starts it again as the
// whole app (links pause for a moment while it does).
function openTheApp() {
  relaunch(argsWithout(BACKGROUND_FLAG));
  app.exit(0);
}

// Links that belong in the app window. Share links point at the website's
// address for this computer, through the relay; open them here instead.
function inApp(url) {
  try {
    if (publicBase && url.startsWith(`${publicBase}/`)) return origin + url.slice(publicBase.length);
    const u = new URL(url);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return origin + u.pathname + u.search + u.hash;
  } catch {}
  return null;
}

const UPDATING_PAGE = require('url').pathToFileURL(path.join(__dirname, 'updating.html')).href;

function wireLinks(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    const target = inApp(url);
    if (target) openWindow(target, { width: 1100, height: 820 });
    else if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    // the app's own update page is the only local file a window may show
    if (inApp(url) || url.split(/[?#]/)[0] === UPDATING_PAGE) return;
    e.preventDefault();
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
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      // Windows and macOS check spelling themselves; on Linux Chromium would
      // download its dictionaries from Google
      spellcheck: process.platform !== 'linux',
    },
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

// A window hidden in the tray still holds a whole page in memory. Links don't
// need it (the server process serves them), so after a while it's let go, and
// opening ShareSecure again makes a fresh one, signed in from the saved
// sign-in. Without one (Linux with no keyring), it's kept, so you're never
// asked for your password just for having closed the window.
const FREE_HIDDEN_AFTER = 2 * 60 * 1000;
const comesBackSignedIn = () => canEncrypt() && Boolean(readSignIns()[origin]);
let freeTimer = null;
function stopFreeTimer() {
  clearTimeout(freeTimer);
  freeTimer = null;
}

function createMain(url) {
  // fills the screen at launch; un-maximizing goes back to this size
  win = openWindow(url, { width: 1240, height: 820, maximize: true });
  win.on('close', e => {
    // closing leaves the server sharing; quit from the tray icon
    if (quitting) return;
    e.preventDefault();
    win.hide();
    stopFreeTimer();
    const hidden = win;
    freeTimer = setTimeout(() => {
      freeTimer = null;
      // not while it's converting a file or showing an update
      if (hidden.isDestroyed() || hidden.isVisible() || convertingNow || !comesBackSignedIn()) return;
      if (hidden.webContents.getURL().startsWith('file:')) return;
      hidden.destroy();
    }, FREE_HIDDEN_AFTER);
    onceOnly('toldAboutTray', () => notify('ShareSecure is still running',
      'Your links keep working, even after you quit, until they expire. To stop them, choose Stop sharing and quit from the tray icon.'));
  });
  win.on('show', stopFreeTimer);
  // "Back to ShareSecure" on the update page, when an update didn't finish
  win.webContents.on('did-navigate-in-page', (_e, url) => {
    if (url.startsWith('file:') && url.endsWith('#back')) win.loadURL(backFromUpdate || origin);
  });
  win.on('closed', () => {
    stopFreeTimer();
    win = null;
  });
}

function showMain() {
  if (!win || win.isDestroyed()) return createMain(origin);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function start() {
  startAtSignIn(true);
  try {
    await startServer();
  } catch (err) {
    dialog.showErrorBox('ShareSecure couldn’t start', err.message);
    app.exit(1);
  }
}

// Up to 1.19 the app could show your ShareSecure account instead of running
// on this computer. That's the website's job now: forget the choice, and the
// account's saved sign-in.
function forgetAccountMode() {
  try { fs.unlinkSync(MODE_FILE); } catch {}
  const all = readSignIns();
  if (all[CLOUD]) {
    delete all[CLOUD];
    try { writeSignIns(all); } catch {}
  }
}

function buildTrayMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open ShareSecure', click: showMain },
    { label: 'Open data folder', click: () => shell.openPath(DATA_DIR) },
    { type: 'separator' },
    { label: 'Privacy policy', click: () => openWindow(`${origin}/privacy`, { width: 900, height: 820 }) },
    { label: 'Terms', click: () => openWindow(`${origin}/terms`, { width: 900, height: 820 }) },
    { label: 'Licenses', click: () => openWindow(`${origin}/licenses`, { width: 900, height: 820 }) },
    { type: 'separator' },
    { label: 'Quit ShareSecure', click: quit },
    { label: 'Stop sharing and quit', click: stopSharingAndQuit },
  ]));
}

async function quit() {
  quitting = true;
  if (await hasLiveLinks()) {
    onceOnly('toldAboutQuit', () => notify('Your links keep working',
      'ShareSecure keeps sharing in the background until your links expire, then stops by itself.'));
    keepLinksUp();
  }
  app.quit();
}

function stopSharingAndQuit() {
  quitting = true;
  stopServer();
  app.quit();
}

// Windows starts the app at sign-in, in the background, so links on this
// computer come back after a restart. With none live, it stops in seconds.
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
// Shown under Updates in Settings (see preload.js). An update waits for
// "Restart to update" instead of installing on quit: quitting leaves the
// server sharing, and installing would stop it. Updating from the
// menu (or from the notification that one is ready) shows updating.html while
// it downloads and installs; the app then reopens on the new version.
const updates = {
  current: app.getVersion(),
  status: app.isPackaged ? 'idle' : 'development',
  latest: null,
  progress: 0,
  error: null,
  autoUpdate: true,
};
let updater = null;
// set once you choose to update: install as soon as the download is in
let installWhenReady = false;
let notice = null;           // the last notification, kept so its click still works
let backFromUpdate = null;   // where "Back to ShareSecure" goes if an update fails

const updateState = () => ({ ...updates, local: true });

// updates.json: { autoUpdate, pending: a downloaded version, until it's running }
function readUpdatesFile() {
  try { return JSON.parse(fs.readFileSync(UPDATES_FILE, 'utf8')) || {}; } catch { return {}; }
}
function writeUpdatesFile(patch) {
  try {
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.writeFileSync(UPDATES_FILE, JSON.stringify({ ...readUpdatesFile(), ...patch }));
  } catch {}
}

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

function showUpdatePage() {
  if (!win || win.isDestroyed()) createMain(null);
  const here = win.webContents.getURL();
  if (here && !here.startsWith('file:')) backFromUpdate = here;
  win.loadFile(path.join(__dirname, 'updating.html'), {
    query: { from: updates.current, to: updates.latest || '', status: updates.status, local: '1' },
  });
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// "Update to …", "Restart to update", or a click on the notification
function installUpdate() {
  if (!updater) return;
  if (updates.status === 'available' || updates.status === 'downloading') {
    installWhenReady = true;
    showUpdatePage();
    if (updates.status === 'available') downloadUpdate();
    return;
  }
  if (updates.status !== 'downloaded') return;
  installWhenReady = false;
  showUpdatePage();
  // long enough to see what's happening; the server stops for the install,
  // and starts again when the app reopens
  setTimeout(() => { quitting = true; stopServer(); updater.quitAndInstall(true, true); }, 1800);
}

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return false;
  notice = new Notification({ title, body, icon: ICON });
  if (onClick) notice.on('click', onClick);
  notice.show();
  return true;
}

// A finished download, said out loud when you're not looking at the app
// (it's in the tray, or another window has the focus).
function notifyReady(version) {
  if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) return;
  if (!readNotifyPrefs().updates) return;
  notify(`ShareSecure ${version} is ready`, 'Click to restart and update. Your links pause for a moment while it installs.', installUpdate);
}

const newer = (a, b) => {
  const [x, y] = [a, b].map(v => String(v).split('.').map(n => parseInt(n, 10) || 0));
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

// The first run of a new version says so, however it got installed: with
// "Restart to update", when you quit, or while you weren't using the app (a
// background start at sign-in counts, so it can tell you before you open it).
// → whether it did
function announceUpdate() {
  const { pending } = readUpdatesFile();
  const now = app.getVersion();
  if (!pending || newer(pending, now)) return false;   // nothing, or not installed yet
  writeUpdatesFile({ pending: null });
  if (pending !== now) return false;
  return notify(`ShareSecure updated to ${now}`, 'You’re on the latest version. Click to see what’s new.',
    () => shell.openExternal(`${CLOUD}/changelog`));
}

function initUpdates() {
  updates.autoUpdate = readUpdatesFile().autoUpdate !== false;
  if (!app.isPackaged) return;
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch { return; /* updates are best effort */ }
  updater.autoDownload = updates.autoUpdate;
  updater.autoInstallOnAppQuit = false;
  updater.on('checking-for-update', () => setUpdates({ status: 'checking', error: null }));
  updater.on('update-not-available', info => setUpdates({ status: 'up-to-date', latest: info.version }));
  updater.on('update-available', info => setUpdates({ status: updater.autoDownload ? 'downloading' : 'available', latest: info.version, progress: 0 }));
  updater.on('download-progress', p => setUpdates({ status: 'downloading', progress: Math.round(p.percent) }));
  updater.on('update-downloaded', info => {
    setUpdates({ status: 'downloaded', latest: info.version });
    writeUpdatesFile({ pending: info.version });
    if (installWhenReady) installUpdate();
    else notifyReady(info.version);
  });
  updater.on('error', err => {
    installWhenReady = false;
    setUpdates({ status: 'error', error: String(err?.message || 'Something went wrong').split('\n')[0].slice(0, 160) });
  });
  checkForUpdates();
  setInterval(checkForUpdates, 6 * 60 * 60 * 1000);
}

// Only the app's own pages, in the top frame, may ask; with pages, only those
// (so a file shown in the viewer could never reach your saved sign-in).
function fromApp(event, pages) {
  const frame = event.senderFrame;
  if (!frame || frame.parent) return false;
  try {
    const url = new URL(frame.url);
    if (origin === '' || url.origin !== new URL(origin).origin) return false;
    return !pages || pages.includes(url.pathname.replace(/\.html$/, '').replace(/^\/index$/, '/'));
  } catch { return false; }
}
// the home page (sharing, Settings) and the sign-in page
const HOME = ['/'];
const SIGN_IN = ['/signin'];

ipcMain.handle('updates:status', e => (fromApp(e) ? updateState() : null));
ipcMain.handle('updates:check', async e => {
  if (!fromApp(e)) return null;
  await checkForUpdates();
  return updateState();
});
ipcMain.handle('updates:install', e => {
  if (!fromApp(e) || !updater) return null;
  setImmediate(installUpdate);
  return updateState();
});
ipcMain.handle('updates:auto', (e, on) => {
  if (!fromApp(e)) return null;
  updates.autoUpdate = on === true;
  writeUpdatesFile({ autoUpdate: updates.autoUpdate });
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

// ── converting files ────────────────────────────────────────────────────────
// Before a file is shared, the page can offer to turn it into another format
// (desktop/convert.js), and a file ShareSecure can't take into one it can.
// It all happens here, on this computer. The page only ever names a file the
// person picked or dropped (preload.js reads its path), or hands over bytes.
// FFmpeg isn't in the installer: it's fetched (and checked) the first time
// it's needed, after you say yes (desktop/ffmpeg.js).
const converter = require('./convert');
let convertingNow = 0;

converter.setup({
  dir: path.join(USER_DIR, 'ffmpeg'),
  // Chromium's network stack, so it goes through the computer's proxy settings
  fetchImpl: (url, init) => electronNet.fetch(url, init),
  confirm: async size => {
    const parent = BrowserWindow.getFocusedWindow() || (win && !win.isDestroyed() ? win : null);
    const options = {
      type: 'question',
      title: 'ShareSecure',
      buttons: ['Download', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: 'Download the converter first?',
      detail: `Converting this uses FFmpeg, a free converter. ShareSecure downloads it once from GitHub (about ${Math.ceil(size / 1e6)} MB) and keeps it on this computer. Your files never leave this computer.\n\nFFmpeg is free software under the GNU GPL and isn’t part of ShareSecure. Its license is under Licenses in the tray menu.`,
    };
    const { response } = await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
    return response === 0;
  },
});

ipcMain.handle('convert:options', (e, head) => {
  if (!fromApp(e, HOME) || !(head instanceof Uint8Array)) return null;
  return converter.optionsFor(head.subarray(0, 4096));
});
ipcMain.handle('convert:run', async (e, { filePath, bytes, name, to } = {}) => {
  if (!fromApp(e, HOME)) return null;
  convertingNow++;
  try {
    return await converter.convert({
      filePath: typeof filePath === 'string' && filePath ? filePath : null,
      bytes: bytes instanceof Uint8Array ? bytes : null,
      name: String(name || ''),
      to: String(to),
    });
  } catch (err) {
    if (err.code === 'cancelled') return { cancelled: true };
    console.error('convert failed:', err.message);
    return null;
  } finally {
    convertingNow--;
  }
});

// ── notifications ───────────────────────────────────────────────────────────
// You choose which ones you get, under Desktop app in Settings. "Still running
// in the background" is said once, ever, not on every close. They never name
// a file or a person: they stay in the system's notification history.
const NOTIFY_DEFAULTS = { expired: true, opened: false, received: true, updates: true };

function readNotifyFile() {
  try { return JSON.parse(fs.readFileSync(NOTIFY_FILE, 'utf8')) || {}; } catch { return {}; }
}
function writeNotifyFile(patch) {
  try {
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.writeFileSync(NOTIFY_FILE, JSON.stringify({ ...readNotifyFile(), ...patch }));
  } catch {}
}
function readNotifyPrefs() {
  const saved = readNotifyFile().prefs || {};
  const prefs = {};
  for (const [kind, on] of Object.entries(NOTIFY_DEFAULTS)) prefs[kind] = typeof saved[kind] === 'boolean' ? saved[kind] : on;
  return prefs;
}

// shows it the first time only
function onceOnly(flag, show) {
  if (readNotifyFile()[flag]) return;
  if (show()) writeNotifyFile({ [flag]: true });
}

// Opens come in bursts (a page, then its retries, then a second person), so
// they're gathered for a little while into one notification.
let opens = 0;
let opensTimer = null;
function notifyFromServer({ kind, count }) {
  if (!readNotifyPrefs()[kind]) return;
  if (kind === 'expired') {
    notify(count > 1 ? `${count} of your links expired` : 'One of your links expired',
      'It can’t be opened any more, and the file has been erased from this computer.', showMain);
  } else if (kind === 'received') {
    notify('Someone sent you a file', 'Open ShareSecure to accept or decline it.', showMain);
  } else if (kind === 'opened') {
    opens++;
    if (opensTimer) return;
    opensTimer = setTimeout(() => {
      notify('Your link was opened', opens > 1 ? `Your links were opened ${opens} times from another device.` : 'Someone opened one of your links from another device.', showMain);
      opens = 0;
      opensTimer = null;
    }, 15 * 1000);
  }
}

ipcMain.handle('notifications:get', e => (fromApp(e) ? readNotifyPrefs() : null));
ipcMain.handle('notifications:set', (e, kind, on) => {
  if (!fromApp(e) || !(kind in NOTIFY_DEFAULTS)) return null;
  writeNotifyFile({ prefs: { ...readNotifyPrefs(), [kind]: on === true } });
  return readNotifyPrefs();
});

// ── saved sign-in ───────────────────────────────────────────────────────────
// The app remembers your username and password so it signs you in at launch.
// They're encrypted with the operating system's key store (safeStorage), one
// for this computer's ShareSecure.
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
  if (!fromApp(e, SIGN_IN) || !canEncrypt()) return null;
  const saved = readSignIns()[siteOf(e)];
  if (!saved) return null;
  try {
    const { username, password } = JSON.parse(safeStorage.decryptString(Buffer.from(saved, 'base64')));
    return typeof username === 'string' && typeof password === 'string' ? { username, password } : null;
  } catch { return null; }
});
ipcMain.handle('signin:save', (e, username, password) => {
  if (!fromApp(e, SIGN_IN) || !canEncrypt() || typeof username !== 'string' || typeof password !== 'string') return false;
  const all = readSignIns();
  all[siteOf(e)] = safeStorage.encryptString(JSON.stringify({ username, password })).toString('base64');
  writeSignIns(all);
  return true;
});
// "Forgot your password?": a new password for this computer's owner account,
// after you confirm it here. Being at this computer is the proof: it's your
// ShareSecure, and the files don't depend on the password. → username or null
ipcMain.handle('signin:reset', async (e, password) => {
  if (!fromApp(e, SIGN_IN) || typeof password !== 'string' || password.length < 8 || !server) return null;
  const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender) || undefined, {
    type: 'question',
    title: 'ShareSecure',
    buttons: ['Set new password', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'Set a new password for ShareSecure on this computer?',
    detail: 'Your files and links stay as they are. Anywhere else you’re signed in is signed out.',
  });
  const asked = server;
  if (response !== 0 || !asked) return null;
  const username = await new Promise(resolve => {
    const timer = setTimeout(() => { asked.off('message', onReply); resolve(null); }, 10000);
    function onReply(message) {
      if (message?.type !== 'reset-password') return;
      clearTimeout(timer);
      asked.off('message', onReply);
      resolve(typeof message.username === 'string' ? message.username : null);
    }
    asked.on('message', onReply);
    try { asked.postMessage({ type: 'reset-password', password }); } catch { clearTimeout(timer); resolve(null); }
  });
  if (username) {
    const all = readSignIns();
    delete all[siteOf(e)];
    writeSignIns(all);
  }
  return username;
});

ipcMain.handle('signin:forget', e => {
  if (!fromApp(e)) return false;
  const all = readSignIns();
  delete all[siteOf(e)];
  writeSignIns(all);
  return true;
});

// opening ShareSecure again (a sign-in start in the background doesn't count)
app.on('second-instance', (_e, argv) => {
  if (argv.includes(BACKGROUND_FLAG)) return;
  if (BACKGROUND) openTheApp();
  else showMain();
});
app.on('activate', () => (BACKGROUND ? openTheApp() : showMain()));
app.on('before-quit', () => {
  // quit some other way (⌘Q, the Dock) with links live: they stay up too,
  // unless the computer is shutting down
  if (!quitting && !BACKGROUND && liveKnown && !shuttingDown) keepLinksUp();
  quitting = true;
});
// stay alive in the tray when every window is closed
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('app.sharesecure.desktop');
  powerMonitor.on('shutdown', () => { shuttingDown = true; });
  if (BACKGROUND) return runInBackground();
  // lets pages hide their "get the app" and "host it yourself" links in here
  app.userAgentFallback = `${app.userAgentFallback} ShareSecureDesktop/${app.getVersion()}`;
  // Electron says yes to every permission a page asks for unless told otherwise.
  // The app's pages only copy links, go full screen for video and show
  // notifications; never the camera, microphone, location or screen.
  const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen', 'notifications']);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));
  forgetAccountMode();
  await start();
  createTray();
  showMain();
  announceUpdate();
  initUpdates();
});
