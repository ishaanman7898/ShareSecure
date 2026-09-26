'use strict';
// ShareSecure desktop. On first launch you choose how to use it:
//   account  sign in to your ShareSecure account (the website, in its own window)
//   local    run a private ShareSecure on this computer; closing the window keeps
//            it running in the tray, because share links only work while it's up
const { app, BrowserWindow, Tray, Menu, shell, nativeImage, Notification, dialog } = require('electron');
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

// Program files are read-only once packaged, so settings, the encryption key
// and every stored file live in the user's app-data folder. It's a separate
// folder from a command-line install, which has its own encryption key.
const USER_DIR = app.getPath('userData');
const DATA_DIR = path.join(USER_DIR, 'data');
const PORT_FILE = path.join(USER_DIR, 'port.json');
const MODE_FILE = path.join(USER_DIR, 'mode.json');
// the full-bleed tile reads better at window and tray sizes than the Mac-grid one
const ICON = path.join(__dirname, 'icon-win.png');

let win = null;
let tray = null;
let quitting = false;
let mode = null;     // 'account' | 'local' | null until chosen
let origin = '';
let toldAboutTray = false;

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

async function startServer() {
  const port = await choosePort();
  process.env.PORT = String(port);
  process.env.DATA_DIR = DATA_DIR;
  process.env.ENV_FILE = path.join(DATA_DIR, '.env');
  process.env.SHARESECURE_DESKTOP = '1';
  // where sending to a username goes, once you link your ShareSecure account
  process.env.SHARESECURE_CLOUD = CLOUD;
  require('../server/index.js');
  origin = `http://localhost:${port}`;
  await waitForServer(origin);
}

// Links that belong in the app window. In local mode, share links point at the
// public tunnel; open them on localhost instead, which skips its warning page.
function inApp(url) {
  try {
    const u = new URL(url);
    if (mode === 'account') return u.origin === CLOUD ? url : null;
    const base = process.env.BASE_URL && new URL(process.env.BASE_URL);
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
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
}

function openWindow(url, size) {
  const w = new BrowserWindow({
    ...size,
    minWidth: 380,
    minHeight: 560,
    title: 'ShareSecure',
    icon: ICON,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  wireLinks(w.webContents);
  w.once('ready-to-show', () => w.show());
  if (url) w.loadURL(url);
  return w;
}

function mainUrl(newAccount = false) {
  if (mode !== 'account') return origin;
  return newAccount ? `${CLOUD}/signin?new=1` : `${CLOUD}/signin`;
}

function createMain(url) {
  win = openWindow(url, { width: 1240, height: 820 });
  win.on('close', e => {
    // with an account there's no server to keep alive, so closing quits
    if (quitting || mode !== 'local') return;
    e.preventDefault();
    win.hide();
    if (!toldAboutTray && Notification.isSupported()) {
      toldAboutTray = true;
      new Notification({
        title: 'ShareSecure is still running',
        body: 'Your links keep working while it runs. Quit from the tray icon to stop it.',
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

// Switching needs a fresh start: a local server can't be stopped in place.
async function changeMode() {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Choose again', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'Choose how to use ShareSecure',
    detail: 'ShareSecure will restart and ask whether to sign in to your account or run it on this computer. Nothing is deleted.',
  });
  if (response !== 0) return;
  try { fs.unlinkSync(MODE_FILE); } catch {}
  quitting = true;
  app.relaunch();
  app.exit(0);
}

function buildTrayMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open ShareSecure', click: showMain },
    ...(mode === 'local' ? [{ label: 'Open data folder', click: () => shell.openPath(DATA_DIR) }] : []),
    { label: 'Switch between account and this computer…', click: changeMode, enabled: Boolean(mode) },
    { type: 'separator' },
    // reachable from the welcome screen too, before anything is set up
    { label: 'Privacy policy', click: () => openWindow(`${origin || CLOUD}/privacy`, { width: 900, height: 820 }) },
    { label: 'Terms', click: () => openWindow(`${origin || CLOUD}/terms`, { width: 900, height: 820 }) },
    { type: 'separator' },
    { label: 'Quit ShareSecure', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  const image = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.setToolTip('ShareSecure');
  buildTrayMenu();
  tray.on('click', showMain);
}

function checkForUpdates() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  } catch { /* updates are best effort */ }
}

app.on('second-instance', showMain);
app.on('activate', showMain);
app.on('before-quit', () => { quitting = true; });
// in local mode stay alive in the tray when every window is closed
app.on('window-all-closed', () => { if (mode !== 'local') app.quit(); });

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('app.sharesecure.desktop');
  // lets pages hide their "get the app" and "host it yourself" links in here
  app.userAgentFallback = `${app.userAgentFallback} ShareSecureDesktop/${app.getVersion()}`;
  const saved = readMode();
  if (saved) await start(saved);
  createTray();
  showMain();
  checkForUpdates();
});
