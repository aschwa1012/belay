'use strict';
// lock-reader.cjs <dataDir> <ms> — reads owner.json in a tight loop for <ms>, as status and CLI reads
// poll it, so a rename onto it meets an open handle almost every time. Writes <dataDir>/reader-<pid>
// once it is reading, so the test starts its write only against readers that are really there.
const fs = require('node:fs');
const path = require('node:path');
const { readOwnerLock } = require(path.resolve(__dirname, '..', '..', '..', 'src', 'core', 'lock.cjs'));

const dataDir = process.argv[2];
const end = Date.now() + Number(process.argv[3] || 10000);
const file = path.join(dataDir, 'owner.lock', 'owner.json');
let marked = false;
while (Date.now() < end) {
  try { fs.readFileSync(file, 'utf8'); } catch { /* not there yet */ }
  readOwnerLock(dataDir);
  if (!marked) { marked = true; fs.writeFileSync(path.join(dataDir, `reader-${process.pid}`), '1'); }
}
