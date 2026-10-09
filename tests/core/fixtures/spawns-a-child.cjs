'use strict';
// spawns-a-child.cjs — an acceptance command that is a tree, not a process. It starts one plain child
// that outlives its own timeout, records that child's pid where the test can read it, and then sleeps
// past the deadline itself. The grandchild takes no stdio, so killing only the direct child still lets
// `close` fire on the parent's pipes: the leak is silent unless something checks the pid.
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const pidFile = process.argv[2];
if (!pidFile) { process.stderr.write('usage: spawns-a-child.cjs <pidFile>\n'); process.exit(2); }

const kid = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { windowsHide: true, stdio: 'ignore' });
fs.writeFileSync(pidFile, String(kid.pid));
process.stdout.write(JSON.stringify({ grandchild: kid.pid }) + '\n');
setTimeout(() => process.exit(0), 120000);
