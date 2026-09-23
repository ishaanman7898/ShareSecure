'use strict';
// Small JSON settings file that lives next to the database (never in the install
// folder, so updates can't overwrite it). Holds the session-signing secret and
// the auto-update preference.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./db');

const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    cache = {};
  }
  if (!cache.sessionSecret) {
    cache.sessionSecret = crypto.randomBytes(32).toString('hex');
    save();
  }
  if (typeof cache.autoUpdate !== 'boolean') cache.autoUpdate = false;
  return cache;
}

function save() {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

function get(key) {
  return load()[key];
}

function set(key, value) {
  load()[key] = value;
  save();
}

module.exports = { get, set };
