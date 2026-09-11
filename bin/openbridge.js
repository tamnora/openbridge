#!/usr/bin/env node
'use strict';

const major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 18) {
    console.error('OpenBridge requiere Node 18 o superior (tenes ' + process.versions.node + ').');
    console.error('Actualizalo en https://nodejs.org');
    process.exit(1);
}

const cli = require('../src/cli');

cli.main(process.argv.slice(2))
    .then((code) => { if (typeof code === 'number') process.exitCode = code; })
    .catch((e) => {
        console.error('error: ' + ((e && e.message) || e));
        process.exitCode = 1;
    });
