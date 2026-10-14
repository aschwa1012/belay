'use strict';
// fake-core-writer.cjs — the real src/core with one change: every memory.store carries embed: false, so a test of who
// wrote a row needs no embedding model. The harness view is wrapped the same way, and nothing else differs, so the
// caller each write carries is the real adapter's. Loaded through BELAY_FAKE_CORE; it exports no run manager, so the
// adapter builds the real one.

const real = require('../../src/core/index.cjs');

const noEmbed = (c) => ({ ...c.memory, store: (a) => c.memory.store({ ...a, embed: false }) });

function wrap(c) {
  return new Proxy(c, {
    get(target, key) {
      if (key === 'memory') return noEmbed(target);
      if (key === 'harness') {
        return () => {
          const h = target.harness();
          return Object.defineProperties({ ...h, memory: noEmbed(h) }, { owner: { get: () => h.owner, enumerable: true } });
        };
      }
      const v = target[key];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

module.exports = { openCore: async (opts) => wrap(await real.openCore(opts)) };
