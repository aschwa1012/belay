'use strict';
// Makes a worker temp folder for run argv[2] under the temp dir argv[3] and exits without closing the run, as a killed adapter does.
const WT = require('../../../src/run/worker-temp.cjs');
const dir = WT.make(process.argv[2], 'w1', { root: process.argv[3] });
if (dir) require('node:fs').writeFileSync(require('node:path').join(dir, 'left.txt'), 'x');
process.stdout.write(dir || 'none');
