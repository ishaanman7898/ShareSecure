'use strict';
// What the app's pages can ask of the desktop app: its version and its
// updates, shown under Updates in the account menu, and your saved sign-in.
// main.js only answers the app's own pages.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('shareSecureDesktop', {
  updates: {
    status: () => ipcRenderer.invoke('updates:status'),
    check: () => ipcRenderer.invoke('updates:check'),
    install: () => ipcRenderer.invoke('updates:install'),
    setAuto: on => ipcRenderer.invoke('updates:auto', on === true),
    onChange: callback => ipcRenderer.on('updates:status', (_e, state) => callback(state)),
  },
  // hiding windows that show files from screenshots (Windows and macOS)
  protection: {
    get: () => ipcRenderer.invoke('protection:get'),
    set: on => ipcRenderer.invoke('protection:set', on === true),
    viewing: ({ viewOnly, discourage } = {}) => ipcRenderer.invoke('protection:viewing', { viewOnly: viewOnly === true, discourage: discourage === true }),
  },
  // which notifications to show: expired, opened, received, updates
  notifications: {
    get: () => ipcRenderer.invoke('notifications:get'),
    set: (kind, on) => ipcRenderer.invoke('notifications:set', String(kind), on === true),
  },
  // turning a file into another format before it's shared (desktop/convert.js).
  // The path comes from the File itself, so the page can only name files the
  // person picked or dropped; one without a path (a pasted image) goes as bytes.
  convert: {
    options: head => ipcRenderer.invoke('convert:options', new Uint8Array(head)),
    run: async (file, to) => {
      let filePath = '';
      try { filePath = webUtils.getPathForFile(file); } catch {}
      const bytes = filePath ? null : new Uint8Array(await file.arrayBuffer());
      return ipcRenderer.invoke('convert:run', { filePath, bytes, name: file.name, to: String(to) });
    },
  },
  signIn: {
    load: () => ipcRenderer.invoke('signin:load'),
    save: (username, password) => ipcRenderer.invoke('signin:save', String(username), String(password)),
    forget: () => ipcRenderer.invoke('signin:forget'),
    // a new owner password, after the app asks you to confirm → username or null
    reset: password => ipcRenderer.invoke('signin:reset', String(password)),
  },
});
