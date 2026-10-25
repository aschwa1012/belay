'use strict';
// core-get-rejects.cjs — ADR 0029 amendment 1 item 3 fixture. The real openCore, wrapped so the returned core's run.get rejects
// exactly once: the first run.get after run.attach, which is the first read `belay run`'s close makes. The run-live guard's
// start-up run.get comes before the attach and is answered as usual. Confined to tests/, per src/cli/cmd-run.cjs's
// BELAY_FAKE_CORE guard.

const real = require('../../../src/core/index.cjs');
const { err } = require('../../../src/core/errors.cjs');

async function openCore(opts) {
  const core = await real.openCore(opts);
  let armed = false;
  let rejectedOnce = false;
  const originalAttach = core.run.attach;
  core.run.attach = async (args) => {
    const row = await originalAttach(args);
    armed = true;
    return row;
  };
  const originalGet = core.run.get;
  core.run.get = async (args) => {
    if (armed && !rejectedOnce) {
      rejectedOnce = true;
      throw err('E_INTERNAL', 'PROBE: run.get rejected once by the core-get-rejects.cjs fixture');
    }
    return originalGet(args);
  };
  return core;
}

module.exports = { openCore };
