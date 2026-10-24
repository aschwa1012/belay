'use strict';
// slow-owner.cjs — a store owner whose `listen` is held back, so a test can dial into the window
// between winning the lock and serving the pipe. The delay is injected here, in the fixture, rather
// than as a seam in the owner: production code carries no test hook.
//
// The window closes when the test says so, not when a timer says so. A fixed delay is a race against
// whatever else the machine is doing: under a full concurrent suite this process can take longer to
// reach `acquireLock` than the window was ever going to be open, and the test then measures nothing.
// So the test creates <releaseFile> when it has finished looking, and this waits for it.
//
// Prints one line of JSON once it is actually listening. Stops only through the pipe's `shutdown`.
const fs = require('node:fs');
const path = require('node:path');
const { Owner } = require(path.resolve(__dirname, '..', '..', '..', 'src', 'core', 'owner.cjs'));

const dataDir = process.argv[2];
const releaseFile = process.argv[3];
const capMs = Number(process.argv[4] || 60000); // a backstop, so a failed test cannot strand this process
if (!dataDir || !releaseFile) { process.stderr.write('usage: slow-owner.cjs <dataDir> <releaseFile> [capMs]\n'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForRelease() {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(releaseFile)) return;
    await sleep(20);
  }
}

const owner = new Owner(dataDir, { embed: false, exitOnShutdown: true });
const listen = owner._listen.bind(owner);
owner._listen = () => waitForRelease().then(listen);

owner.start()
  .then(info => { process.stdout.write(JSON.stringify({ ready: true, ...info }) + '\n'); })
  .catch(e => { process.stdout.write(JSON.stringify({ ready: false, code: e.code, message: e.message }) + '\n'); process.exit(1); });
