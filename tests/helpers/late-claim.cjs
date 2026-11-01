'use strict';
// late-claim.cjs — the detached process of late-check.cjs: it records that it started, waits for the port file, then makes one unkeyed
// claim of the operator on that owner (raw-claim.cjs tcp) and writes the owner's answer. argv: startedFile portFile outFile.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const [, , started, portFile, out] = process.argv;
fs.writeFileSync(started, String(process.pid));
const deadline = Date.now() + 25000;
const poll = setInterval(() => {
  if (Date.now() > deadline) { clearInterval(poll); process.exit(1); }
  let port;
  try { port = fs.readFileSync(portFile, 'utf8').trim(); } catch { return; }
  if (!port) return;
  clearInterval(poll);
  execFile(process.execPath, [path.join(__dirname, 'raw-claim.cjs'), port, 'tcp'], { windowsHide: true }, (e, stdout) => { fs.writeFileSync(out, stdout || String(e)); });
}, 50);
