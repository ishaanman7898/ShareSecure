'use strict';
// ShareSecure desktop: runs the self-hosted server inside the app and shows it
// in its own window. Closing the window keeps it running in the tray, because
// share links only work while the server is up.
const { app, BrowserWindow, Tray, Menu, shell, nativeImage, Notification } = require('electron');
const fs = require('fs');
const net = require('net');
const path = require('path');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

// Program files are read-only once packaged, so settings, the encryption key
// and every stored file live in the user's app-data folder. It's a separate
// folder from a command-line install, which has its own encryption key.
const USER_DIR = app.getPath('userData');
const DATA_DIR = path.join(USER_DIR, 'data');
const PORT_FILE = path.join(USER_DIR, 'port.json');
// the full-bleed tile reads better at window and tray sizes than the Mac-grid one
const ICON = path.join(__dirname, 'icon-win.png');

let win = null;
let tray = null;
let quitting = false;
let origin = '';
let toldAboutTray = false;

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
  require('../server/index.js');
  origin = `http://localhost:${port}`;
  await waitForServer(origin);
}

// Share links point at the public tunnel. Inside the app, open them on
// localhost instead, which skips the tunnel's warning page.
function toLocal(url) {
  try {
    const u = new URL(url);
    const base = process.env.BASE_URL && new URL(process.env.BASE_URL);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || (base && u.host === base.host)) {
      return origin + u.pathname + u.search + u.hash;
    }
  } catch {}
  return null;
}

function wireLinks(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    const local = toLocal(url);
    if (local) openWindow(local, { width: 1100, height: 820 });
    else if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (toLocal(url)) return;
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
  w.loadURL(url);
  return w;
}

function showMain() {
  if (!win || win.isDestroyed()) {
    win = openWindow(origin, { width: 1240, height: 820 });
    win.on('close', e => {
      if (quitting) return;
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
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  const image = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.setToolTip('ShareSecure');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open ShareSecure', click: showMain },
    { label: 'Open data folder', click: () => shell.openPath(DATA_DIR) },
    { type: 'separator' },
    { label: 'Quit ShareSecure', click: () => { quitting = true; app.quit(); } },
  ]));
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
// stay alive in the tray when every window is closed
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('app.sharesecure.desktop');
  try {
    await startServer();
  } catch (err) {
    const { dialog } = require('electron');
    dialog.showErrorBox('ShareSecure couldn’t start', err.message);
    app.exit(1);
    return;
  }
  createTray();
  showMain();
  checkForUpdates();
});
