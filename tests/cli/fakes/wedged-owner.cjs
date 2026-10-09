'use strict';
// wedged-owner.cjs — a fake store owner whose event loop is blocked. Argument: the sandbox data dir.
// It plants owner.lock naming its own live pid, listens on the owner's pipe name, prints `ready`, then
// blocks the loop for good. libuv keeps four pending pipe instances, so the first four dials connect
// and time out, and from the fifth the connect waits in WaitNamedPipeW (the dispatcher exit defect).
const fs = require('node:fs');
const net = require('node:net');
const { pipeName, lockPath, metaPath } = require('../../../src/core/lock.cjs');

const dataDir = process.argv[2];
const pipe = pipeName(dataDir);
fs.mkdirSync(lockPath(dataDir), { recursive: true });
fs.writeFileSync(metaPath(dataDir), JSON.stringify({ pid: process.pid, pipe, acquired_at: Date.now() }));
const server = net.createServer(() => { /* never answers */ });
server.listen(pipe, () => {
  process.stdout.write('ready\n', () => {
    for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  });
});
