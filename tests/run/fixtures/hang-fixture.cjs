'use strict';
// Build step H1 fixture for tests/run/test-runner.test.cjs. Not a *.test.cjs, so no glob picks it up.
// It hangs on purpose: it spawns a sleeping grandchild, writes both pids to the file the test names in
// H1_PIDS_FILE, and holds a timer so this process never exits on its own.
// The grandchild is detached: on Windows libuv puts an ordinary child in a kill-on-close job of its
// parent, so ending only the direct child would take an ordinary grandchild with it and hide a runner
// that stops the child alone. A detached one leaves that job and survives unless the tree is walked.
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 20000); setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, detached: true });
fs.writeFileSync(process.env.H1_PIDS_FILE, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
// Bounded: a runner that fails to stop this tree must not hang the test that uses it.
setTimeout(() => { try { process.kill(grandchild.pid); } catch { /* gone */ } process.exit(0); }, 20000);
setInterval(() => {}, 1000);
