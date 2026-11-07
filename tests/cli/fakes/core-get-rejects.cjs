'use strict';
// core-get-rejects.cjs — ADR 0029 amendment 1 item 3 fixture. The real openCore, wrapped so the returned core's run.get rejects
// exactly once: the first run.get after run.attach that `belay run`'s close makes (src/cli/run-close.cjs, told by the caller's
// frame). Other readers after the attach, such as the policy watcher's fix-cap read, are answered as usual, and so is the
// run-live guard's start-up run.get before the attach. If the close's read ever moves out of run-close.cjs, nothing is rejected
// and the test that uses this fixture fails on its ended_by match. Confined to tests/, per src/cli/cmd-run.cjs's BELAY_FAKE_CORE guard.

const real = require('../../../src/core/index.cjs');
const { err } = require('../../../src/core/errors.cjs');

const fromClose = () => /[\\/]src[\\/]cli[\\/]run-close\.cjs:/.test(String(new Error().stack));

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
    if (armed && !rejectedOnce && fromClose()) {
      rejectedOnce = true;
      throw err('E_INTERNAL', 'PROBE: run.get rejected once by the core-get-rejects.cjs fixture');
    }
    return originalGet(args);
  };
  return core;
}

module.exports = { openCore };
