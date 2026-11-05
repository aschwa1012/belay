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
// Then the two creation times (ADR 0039), written into the same file once a snapshot reads them, so a test that finds both stopped can tell
// them from processes handed their numbers later. A fixture stopped before the snapshot lands leaves the file as it was, and the test then
// treats a held pid as unverifiable.
require('../../../src/core/proc-identity.cjs').processSnapshot().then((snap) => {
  if (!snap) return;
  const c = snap.get(process.pid); const g = snap.get(grandchild.pid);
  fs.writeFileSync(process.env.H1_PIDS_FILE, JSON.stringify({ child: process.pid, grandchild: grandchild.pid, child_created: c ? c.created : null, grandchild_created: g ? g.created : null }));
}).catch(() => {});
// Bounded: a runner that fails to stop this tree must not hang the test that uses it.
setTimeout(() => { if (grandchild.exitCode === null && grandchild.signalCode === null) { try { grandchild.kill(); } catch { /* gone */ } } process.exit(0); }, 20000); // by its live handle only
setInterval(() => {}, 1000);
