'use strict';

const fs = require('node:fs');
const paths = require('./paths');

function ts() {
    return new Date().toISOString();
}

function write(line) {
    const text = '[' + ts() + '] ' + line;
    try {
        fs.appendFileSync(paths.serverLogPath(), text + '\n');
    } catch (e) { /* sin log no detenemos nada */ }
    console.log(text);
}

function log(...parts) { write(parts.join(' ')); }
function error(...parts) { write('ERROR: ' + parts.join(' ')); }
function warn(...parts) { write('aviso: ' + parts.join(' ')); }

module.exports = { log, error, warn };
