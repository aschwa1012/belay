'use strict';
// owner-proc.cjs — a store owner in its own process, so a test can exercise the pipe. Prints one line
// of JSON when it is listening. Stops only through the pipe's `shutdown` method, never a signal.
const path = require('node:path');
const { Owner } = require(path.resolve(__dirname, '..', '..', '..', 'src', 'core', 'owner.cjs'));

const dataDir = process.argv[2];
if (!dataDir) { process.stderr.write('usage: owner-proc.cjs <dataDir>\n'); process.exit(2); }

const owner = new Owner(dataDir, { embed: false, exitOnShutdown: true });
owner.start()
  .then(info => { process.stdout.write(JSON.stringify({ ready: true, ...info }) + '\n'); })
  .catch(e => { process.stdout.write(JSON.stringify({ ready: false, code: e.code, message: e.message }) + '\n'); process.exit(1); });
