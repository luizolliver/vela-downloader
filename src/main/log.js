'use strict';

// Plain-text diagnostic log in the user's data folder (vela.log), so problems
// that only happen on someone's machine can be reported. Never pass cookie
// values, tokens or other secrets to it.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MAX_BYTES = 1024 * 1024;

const logDir = () => path.join(app.getPath('userData'), 'logs');
const logFile = () => path.join(logDir(), 'vela.log');

function rotate() {
  try {
    if (fs.statSync(logFile()).size > MAX_BYTES) fs.renameSync(logFile(), path.join(logDir(), 'vela.old.log'));
  } catch { /* no log yet */ }
}

function write(scope, message, detail) {
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    rotate();
    let line = `${new Date().toISOString()} [${scope}] ${message}`;
    if (detail !== undefined) {
      const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
      line += '\n' + text.split(/\r?\n/).map(l => '    ' + l).join('\n');
    }
    fs.appendFileSync(logFile(), line + '\n');
  } catch { /* logging must never break the app */ }
}

module.exports = { log: write, logFile, logDir };
