'use strict';
// Build step H1 fixture for tests/run/test-runner.test.cjs (h2): runs one phase with a long bound and
// then lets the event loop drain. A timer runPhase left pending would keep this process alive.
//   node runphase-probe.cjs <fixture>
const { runPhase } = require('../../../scripts/test.cjs');

runPhase([process.argv[2]], { timeoutMs: 120000 }).then((r) => { console.log(`RESULT ${JSON.stringify(r)}`); });
