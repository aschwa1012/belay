'use strict';
// core-attach-late-rejects.cjs — ADR 0039 fixture. The real openCore, wrapped so run.attach rejects once, 900 ms
// after it is called: by then a quick fake claude has already exited, which is the case the attach-failure kill
// must not act on. Confined to tests/, per src/cli/cmd-run.cjs's BELAY_FAKE_CORE guard.

const real = require('../../../src/core/index.cjs');
const { err } = require('../../../src/core/errors.cjs');

async function openCore(opts) {
  const core = await real.openCore(opts);
  let rejected = false;
  const original = core.run.attach;
  core.run.attach = async (args) => {
    if (!rejected) {
      rejected = true;
      await new Promise((r) => setTimeout(r, 900));
      throw err('E_INTERNAL', 'PROBE: run.attach rejected late by the core-attach-late-rejects.cjs fixture');
    }
    return original(args);
  };
  return core;
}

module.exports = { openCore };
