'use strict';
// count-copies.cjs — loaded with --require into a CLI child by tests/cli/read-one-copy.test.cjs. Counts the store copies the process
// makes (each copy of memory.db is one call of copy-read's copy hook onto a file named memory.db) and writes the count to COPY_COUNT_FILE on exit.
const fs = require('node:fs');
const path = require('node:path');
let copies = 0;
require(path.join(__dirname, '..', '..', '..', 'src', 'core', 'copy-read.cjs')).hooks.copy = (src, dst) => {
  if (path.basename(String(dst)) === 'memory.db') copies += 1;
};
process.on('exit', () => { try { fs.writeFileSync(process.env.COPY_COUNT_FILE, String(copies)); } catch { /* the test reports a missing file */ } });
