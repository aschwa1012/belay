'use strict';
// held-settle-xp-child.cjs — one operator process of memory-held-settle-xp.test.cjs (not a test itself). It opens its OWN Store connection to the db file and
// runs one memory.heldSettle through an Engine. Role A is held by a test-only seam on its own store object (nothing in product code): after the call has read the
// hold and before it opens its write transaction it waits for a gate file that role B writes once B's settle has committed.
const fs = require('node:fs');
const path = require('node:path');
const [role, dir, note, action, gate, flag] = process.argv.slice(2);
const C = path.join(__dirname, '..', '..', 'src', 'core');
const { Store } = require(path.join(C, 'store.cjs'));
const { Engine } = require(path.join(C, 'engine.cjs'));
const { callerFor } = require('./helpers.cjs');

const store = new Store(`${dir}/memory.db`);
const E = new Engine({ dataDir: dir, store, getEmbedder: async () => { throw new Error('no embedder'); }, owner: null, establishedBy: 'xp' });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const waitFor = (f) => { const t = Date.now(); while (!fs.existsSync(`${gate}/${f}`)) { if (Date.now() - t > 20000) throw new Error(`gate timeout ${f}`); sleep(10); } };

if (role === 'A') {
  const orig = store.tx.bind(store);
  store.tx = (fn) => { fs.writeFileSync(`${gate}/A-read`, ''); waitFor('B-done'); return orig(fn); };
} else waitFor('A-read');

const args = { id: note, action, reason: `by ${role}`, ...(flag === 'flag' ? { if_awaiting: true } : {}) };
E.handle('memory.heldSettle', { caller: callerFor('operator', { run_id: 'r-xp' }), ...args })
  .then((r) => { console.log(JSON.stringify({ role, ok: true, outcome: r.outcome })); })
  .catch((e) => { console.log(JSON.stringify({ role, ok: false, code: e.code, detail: e.detail })); })
  .finally(() => { if (role === 'B') fs.writeFileSync(`${gate}/B-done`, ''); store.close(); });
