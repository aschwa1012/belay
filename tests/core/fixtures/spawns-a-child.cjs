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
// The grandchild's creation time (ADR 0039), written beside the pid while it lives, so the test can tell it from a process handed its number
// after the tree kill. A snapshot that cannot be read leaves no file, and the test then treats a held pid as unverifiable.
require('../../../src/core/proc-identity.cjs').createdOf(kid.pid, { kind: 'test-setup' }).then((made) => {
  if (made && made.created != null) fs.writeFileSync(`${pidFile}.created`, String(made.created));
}).catch(() => {});
setTimeout(() => process.exit(0), 120000);
