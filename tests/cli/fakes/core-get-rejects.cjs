'use strict';
// core-get-rejects.cjs — ADR 0029 amendment 1 item 3 fixture. The real openCore, wrapped so the returned
// core's run.get rejects exactly once, which is the first read `belay run`'s close makes. Confined to
// tests/, per src/cli/cmd-run.cjs's BELAY_FAKE_CORE guard.

const real = require('../../../src/core/index.cjs');
const { err } = require('../../../src/core/errors.cjs');

async function openCore(opts) {
  const core = await real.openCore(opts);
  let rejectedOnce = false;
  const originalGet = core.run.get;
  core.run.get = async (args) => {
    if (!rejectedOnce) {
      rejectedOnce = true;
      throw err('E_INTERNAL', 'PROBE: run.get rejected once by the core-get-rejects.cjs fixture');
    }
    return originalGet(args);
  };
  return core;
}

module.exports = { openCore };
