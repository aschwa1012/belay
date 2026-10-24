'use strict';
// core-end-rejects.cjs — test fixture for build step 5a-3
//. Re-exports the real
// src/core/index.cjs's openCore, wrapped so the returned core's run.end rejects with E_INTERNAL
// exactly once; every other method, and every other core, is untouched. Confined to tests/, per
// src/cli/cmd-run.cjs's BELAY_FAKE_CORE guard.

const real = require('../../../src/core/index.cjs');
const { err } = require('../../../src/core/errors.cjs');

async function openCore(opts) {
  const core = await real.openCore(opts);
  let rejectedOnce = false;
  const originalEnd = core.run.end;
  core.run.end = async (args) => {
    if (!rejectedOnce) {
      rejectedOnce = true;
      throw err('E_INTERNAL', 'PROBE: run.end rejected once by the core-end-rejects.cjs fixture');
    }
    return originalEnd(args);
  };
  return core;
}

module.exports = { openCore };
