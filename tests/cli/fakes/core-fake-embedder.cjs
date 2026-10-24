'use strict';
// core-fake-embedder.cjs — ADR 0034 fixture. The real openCore, wrapped so that once the process owns the store
// its embedder is a fake that FAKE_EMBEDDER_MODE controls (the real one needs the 243 MB model):
//   ok          warm-up passes; the fake embed() fails with an embedder-failure error (E_TIMEOUT, detail.embedder true)
//   caller      warm-up passes; the fake embed() fails with E_TOO_LONG, a caller's error that is NOT an embedder failure
//   changed     warm-up passes; the fake embed() fails with E_MODEL_CHANGED (detail.embedder true, cause canary)
//   warm-fails  warm-up itself fails: E_MODEL_ABSENT with detail.embedder true
// memory.warm({ retry }) (the call a resume makes, ADR 0034 decision 2) fails with the same error until the file named
// by FAKE_EMBEDDER_FIXED exists, then heals: later embed() calls succeed. It stands for e2's memory.warm.
// Confined to tests/, per src/cli/cmd-run.cjs's BELAY_FAKE_CORE guard.

const real = require('../../../src/core/index.cjs');
const { err } = require('../../../src/core/errors.cjs');

async function openCore(opts) {
  const core = await real.openCore(opts);
  const mode = process.env.FAKE_EMBEDDER_MODE || 'ok';
  let healed = false;
  core.memory.warm = async ({ reload } = {}) => {
    if (!reload) { await core.owner.getEmbedder(); return { state: 'ready' }; } // the first warm-up
    if (process.env.FAKE_EMBEDDER_WARM_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_EMBEDDER_WARM_DELAY_MS))); // a slow reload
    if (!process.env.FAKE_EMBEDDER_FIXED || !require('node:fs').existsSync(process.env.FAKE_EMBEDDER_FIXED)) {
      throw err('E_MODEL_ABSENT', 'FAKE: the model files are still absent', { embedder: true, cause: 'absent' });
    }
    healed = true;
    return { state: 'ready' };
  };
  const becomeOwner = core.becomeOwner.bind(core);
  core.becomeOwner = async () => {
    const r = await becomeOwner();
    if (!core.owner) return r;
    core.owner.getEmbedder = async () => {
      if (mode === 'warm-fails') throw err('E_MODEL_ABSENT', 'FAKE: the model files are absent', { embedder: true, cause: 'absent' });
      core.owner.embedInfo = { model: 'fake-model', load_ms: 7, pid: 1 };
      return {
        embed: async () => {
          if (healed && require('node:fs').existsSync(process.env.FAKE_EMBEDDER_FIXED)) return { embedding: new Array(4).fill(0.5), embedding_model: 'fake-model', embedding_revision: 'x', dim: 4 };
          if (mode === 'changed') throw err('E_MODEL_CHANGED', 'FAKE: the store was built with another embedding model', { embedder: true, cause: 'canary' });
          if (mode === 'caller') throw err('E_TOO_LONG', 'FAKE: the text is past the window', { tokens: 99999 });
          throw err('E_TIMEOUT', 'FAKE: the embedder did not answer embed within 60000 ms', { embedder: true, cause: 'timeout', op: 'embed' });
        },
      };
    };
    return r;
  };
  return core;
}

module.exports = { openCore };
