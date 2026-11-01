'use strict';
// embedder-budgets.test.cjs — the owner's responsiveness while the embedding model loads, measured in the phase that runs
// nothing else (invariant 9). The functional claim (every ping during the load was answered, and the embedder is a child
// process) stays in tests/core/embedder-store.test.cjs; the 250 ms bounds on the owner's event-loop gap and on the slowest
// ping are timing claims, and in the concurrent phase a neighbour's GC or spawn can stall one tick past them with no product
// change. The owner shares this process's event loop, so a stall anywhere in the load shows up as a gap between ticks of a
// timer here. The raw numbers are printed and written to receipts/embedder-last.json and are asserted only against the bound.
// Skipped, with the reason, when the model is not fetched.

require('../helpers/tmp.cjs');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor, optInModel } = require('../core/helpers.cjs');
optInModel();

const { openCore } = core('index.cjs');
const { ping } = core('ping.cjs');
const M = core('models.cjs');
const K = core('model-cache.cjs');

const BOUND_MS = 250;
const VOYAGE = M.MODELS[M.DEFAULT_MODEL];
function absence(entry) {
  if (!K.packageDir()) return 'the transformers package is not installed at the pinned version (run npm install)';
  const c = K.checkPresent(entry);
  return c.present ? null : `the model ${entry.id} is not in the cache at ${c.dir} (run belay embedder fetch --model ${entry.id})`;
}

// A run warms the embedder before any agent: the child is forked there, and the load that follows is what this watches.
test('budgets: the owner answers its pipe and keeps its event loop turning within 250 ms while the model loads', { timeout: 240000 }, async (t) => {
  const why = absence(VOYAGE);
  if (why) return t.skip(why);
  const dir = sandbox();
  let c = null;
  const beatOf = { last: Date.now(), gap: 0 };
  const beat = setInterval(() => { const now = Date.now(); beatOf.gap = Math.max(beatOf.gap, now - beatOf.last); beatOf.last = now; }, 20);
  try {
    c = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: true });
    await c.memory.warm({});
    await new Promise((r) => setTimeout(r, 600)); // the fork's own stall is over before the watch begins; the load itself continues
    beatOf.last = Date.now(); beatOf.gap = 0;
    const first = c.memory.store({ namespace: 'm10', text: 'a row that makes the owner load the model' });
    let done = false;
    first.then(() => { done = true; }, () => { done = true; });
    let n = 0, max = 0, seen = false;
    while (!done) {
      const r = await ping(dir, 2000);
      if (r.ok) seen = true; // the very first ping can land before the owner's pipe is listening; count from the first answer
      if (!done && seen) { n += 1; max = Math.max(max, r.ms); }
      await new Promise((res) => setTimeout(res, 20));
    }
    await first;
    clearInterval(beat);
    const line = { gate: 'owner_loop_during_model_load', bound_ms: BOUND_MS, event_loop_gap_ms: beatOf.gap, slowest_ping_ms: max, pings: n };
    console.log(JSON.stringify(line));
    const receiptsDir = path.join(__dirname, 'receipts');
    fs.mkdirSync(receiptsDir, { recursive: true });
    fs.writeFileSync(path.join(receiptsDir, 'embedder-last.json'), JSON.stringify(line, null, 2));
    assert.ok(n >= 3, `only ${n} pings landed during the load; it was not in flight long enough to prove anything`);
    assert.ok(beatOf.gap < BOUND_MS, `the owner's event loop stalled for ${beatOf.gap} ms during the load`);
    assert.ok(max < BOUND_MS, `the slowest ping during the load took ${max} ms`);
  } finally {
    clearInterval(beat);
    if (c) { await c.shutdownOwner(); await c.close(); }
    cleanup(dir);
  }
});
