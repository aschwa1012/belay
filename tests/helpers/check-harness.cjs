'use strict';
// check-harness.cjs — stands in for a store owner that is running a check command when it ends. It runs `node <args>` as a registered
// check and prints "<check pid> <time it was alive>" once the record has been seen:
//   node check-harness.cjs soft <args...>   then ends with process.exit, which runs exit handlers
//   node check-harness.cjs hold <args...>   then stays; the test ends it with a hard kill (TerminateProcess), which runs none
// The check command is `node <args>`; it should end by itself.

const path = require('node:path');
const { runCommand } = require(path.join(__dirname, '..', '..', 'src', 'core', 'evaluate.cjs'));

const [, , how, ...args] = process.argv;
let child = null;
runCommand([process.execPath, ...args], process.cwd(), 120000, { register: 'check', onChild: (c) => { child = c; } });
setTimeout(() => {
  process.stdout.write(`${child.pid} ${Date.now()}\n`, () => { if (how === 'soft') process.exit(0); });
}, 300);
