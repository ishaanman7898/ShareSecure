'use strict';
// Rebuild every app and web icon from the supplied ShareSecure.png.
// Run with: npx electron desktop/update-icons.js
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const source = nativeImage.createFromPath(path.join(root, 'ShareSecure.png'));
if (source.isEmpty()) throw new Error('Could not open ShareSecure.png');

function asPng(size) {
  return source.resize({ width: size, height: size, quality: 'best' }).toPNG();
}

function icoBuffer(sizes) {
  const images = sizes.map(size => ({ size, data: asPng(size) }));
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, index) => {
    const at = 6 + index * 16;
    header[at] = size === 256 ? 0 : size;
    header[at + 1] = size === 256 ? 0 : size;
    header[at + 2] = 0;
    header[at + 3] = 0;
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map(image => image.data)]);
}

app.whenReady().then(() => {
  const pngs = [
    ['desktop/icon.png', 1024],
    ['desktop/icon-win.png', 1024],
    ['public/app-icon.png', 256],
    ['public/apple-touch-icon.png', 180],
  ];
  for (const [file, size] of pngs) {
    fs.writeFileSync(path.join(root, file), asPng(size));
    console.log('wrote', file);
  }
  const ico = icoBuffer([16, 32, 48, 64, 128, 256]);
  for (const file of ['desktop/icon.ico', 'public/favicon.ico']) {
    fs.writeFileSync(path.join(root, file), ico);
    console.log('wrote', file);
  }
  app.quit();
}).catch(error => {
  console.error(error);
  app.exit(1);
});
