'use strict';
// What the app's pages can ask of the desktop app: its version and its
// updates, shown under Updates in the account menu. main.js only answers the
// app's own pages.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shareSecureDesktop', {
  updates: {
    status: () => ipcRenderer.invoke('updates:status'),
    check: () => ipcRenderer.invoke('updates:check'),
    install: () => ipcRenderer.invoke('updates:install'),
    setAuto: on => ipcRenderer.invoke('updates:auto', on === true),
    onChange: callback => ipcRenderer.on('updates:status', (_e, state) => callback(state)),
  },
});
