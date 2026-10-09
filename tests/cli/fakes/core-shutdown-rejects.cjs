'use strict';
// core-shutdown-rejects.cjs — test fixture for build step 5a-4, design item 3. Re-exports the real src/core/index.cjs's openCore, wrapped so that
// once this process's becomeOwner() call actually elects it, that owner's own store.close throws
// once. Owner.stop() (src/core/owner.cjs) then rejects — but only after it has already closed the
// server and released the lock, which is the guarantee item 1 of this step builds. Unlike the earlier
// round, shutdownOwner() itself is never overridden: the failure comes from inside the real owner, so
// the only thing standing between a live owner and a torn-down one is Owner.stop() itself. Confined to
// tests/, per src/cli/cmd-run.cjs's BELAY_FAKE_CORE guard.

const real = require('../../../src/core/index.cjs');
const { err } = require('../../../src/core/errors.cjs');

async function openCore(opts) {
  const core = await real.openCore(opts);
  const originalBecomeOwner = core.becomeOwner.bind(core);
  core.becomeOwner = async () => {
    const result = await originalBecomeOwner();
    if (result.owner && core.owner && !core.owner._probeStoreClosePatched) {
      core.owner._probeStoreClosePatched = true;
      const originalClose = core.owner.store.close.bind(core.owner.store);
      let thrownOnce = false;
      core.owner.store.close = () => {
        if (!thrownOnce) {
          thrownOnce = true;
          throw err('E_INTERNAL', 'PROBE: store.close rejected once by the core-shutdown-rejects.cjs fixture');
        }
        return originalClose();
      };
    }
    return result;
  };
  return core;
}

module.exports = { openCore };
