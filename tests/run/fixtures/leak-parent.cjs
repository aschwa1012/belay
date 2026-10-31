'use strict';
// Starts a detached grandchild that inherits stdout and stderr, prints the grandchild's pid, and exits at once.
const { spawn } = require('node:child_process');
const gc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
process.stdout.write(`gc ${gc.pid}\n`, () => process.exit(0));
