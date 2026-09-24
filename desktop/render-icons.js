'use strict';
// Renders the app icons from desktop/logo.js. Run with Electron:
//   npx electron desktop/render-icons.js
//   icon.png       macOS/Linux, on Apple's icon grid (tile with margin + shadow)
//   icon-win.png   Windows, tile fills the canvas
//   public/app-icon.png, public/apple-touch-icon.png   the website (simple version)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { logo } = require('./logo');

const ROOT = path.join(__dirname, '..');
const jobs = [
  { file: 'desktop/icon.png', canvas: 1024, margin: 100, size: 1024 },
  { file: 'desktop/icon-win.png', canvas: 1024, margin: 16, size: 1024 },
  { file: 'public/app-icon.png', canvas: 1024, margin: 16, size: 256, simple: true },
  // iOS rounds the corners itself and wants no transparency
  { file: 'public/apple-touch-icon.png', canvas: 1024, margin: 0, size: 180, square: true, simple: true },
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024, height: 1024, show: false, frame: false, transparent: true,
    enableLargerThanScreen: true, useContentSize: true, webPreferences: { offscreen: true },
  });
  win.setContentSize(1024, 1024);
  for (const job of jobs) {
    let svg = logo({ canvas: job.canvas, margin: job.margin, simple: job.simple });
    if (job.square) svg = svg.replace(/rx="[\d.]+"/g, 'rx="0"');
    const html = `<body style="margin:0;background:transparent">${svg}</body>`;
    await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
    await new Promise(r => setTimeout(r, 300));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
    fs.writeFileSync(path.join(ROOT, job.file), img.resize({ width: job.size, height: job.size, quality: 'best' }).toPNG());
    console.log('wrote', job.file);
  }
  fs.writeFileSync(path.join(ROOT, 'desktop/logo.svg'), logo({ canvas: 1024, margin: 16 }));
  app.quit();
});
