'use strict';
// Things worth telling the owner about, for the desktop app's notifications
// (desktop/server-process.js passes them on; main.js decides which to show).
// They say what happened, never which file or who: notifications end up in
// the operating system's notification history.
//   expired  { count }  links of yours that just expired
//   opened   {}         someone opened one of your links, from another device
//   received {}         someone sent you a file
const { EventEmitter } = require('events');

module.exports = new EventEmitter();
