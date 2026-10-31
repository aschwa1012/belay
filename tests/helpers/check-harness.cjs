'use strict';
// check-harness.cjs — stands in for a store owner that is running a check command when it ends (process.exit, which runs exit
// handlers). It runs a long-lived command as a registered check, waits until the record has been seen, prints
// "<check pid> <time it was alive>", and exits while the check still runs. The test closes the check by its pid.

const path = require('node:path');
const { runCommand } = require(path.join(__dirname, '..', '..', 'src', 'core', 'evaluate.cjs'));

let child = null;
runCommand([process.execPath, '-e', 'setTimeout(() => {}, 60000)'], process.cwd(), 120000, { register: 'check', onChild: (c) => { child = c; } });
setTimeout(() => {
  process.stdout.write(`${child.pid} ${Date.now()}\n`, () => process.exit(0));
}, 300);
