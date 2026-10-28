'use strict';
// What the app's pages can ask of the desktop app: its version and its
// updates, shown under Updates in the account menu, and your saved sign-in.
// main.js only answers the app's own pages.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shareSecureDesktop', {
  updates: {
    status: () => ipcRenderer.invoke('updates:status'),
    check: () => ipcRenderer.invoke('updates:check'),
    install: () => ipcRenderer.invoke('updates:install'),
    setAuto: on => ipcRenderer.invoke('updates:auto', on === true),
    onChange: callback => ipcRenderer.on('updates:status', (_e, state) => callback(state)),
  },
  // your account or this computer: which one, and switching (the app asks first)
  mode: {
    get: () => ipcRenderer.invoke('mode:get'),
    switch: () => ipcRenderer.invoke('mode:switch'),
  },
  // hiding windows that show files from screenshots (Windows and macOS)
  protection: {
    get: () => ipcRenderer.invoke('protection:get'),
    set: on => ipcRenderer.invoke('protection:set', on === true),
    viewing: ({ viewOnly, discourage } = {}) => ipcRenderer.invoke('protection:viewing', { viewOnly: viewOnly === true, discourage: discourage === true }),
  },
  signIn: {
    load: () => ipcRenderer.invoke('signin:load'),
    save: (username, password) => ipcRenderer.invoke('signin:save', String(username), String(password)),
    forget: () => ipcRenderer.invoke('signin:forget'),
  },
});
