'use strict';
// late-check.cjs — a check command that starts a detached process 3 s in (after the 2 s the provenance slack allows from a spawn) and
// ends only when the test has hard-killed its owner and tells it to. argv: flagFile startedFile portFile outFile.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const [, , flag, started, portFile, out] = process.argv;
setTimeout(() => {
  const g = spawn(process.execPath, [path.join(__dirname, 'late-claim.cjs'), started, portFile, out], { detached: true, stdio: 'ignore', windowsHide: true });
  g.unref();
  const wait = setInterval(() => { if (fs.existsSync(flag)) { clearInterval(wait); process.exit(0); } }, 50);
  setTimeout(() => process.exit(0), 30000).unref(); // never outlives a failed test by long
}, 3000);
