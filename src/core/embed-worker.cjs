'use strict';
// embed-worker.cjs — the embedder child PROCESS (review 2, MF1: native onnx code cannot be interrupted
// in a worker thread, and terminating it crashed the owner on exit). embedder.cjs forks this file with
// IPC and knows it by pid. argv[2] is the JSON of { model, pkg, cacheDir }.
//
// Messages in: { id, op, ... } with op one of load, embed, tokenCount, close. Out: { id, ok: true,
// result } or { id, ok: false, error: { code, message, detail } }. `close` ends this process. When the
// owner dies the IPC channel closes; the channel is the only handle keeping this process's event loop
// alive, so the process ends by itself (measured 15 to 730 ms after the owner's death, also mid-embed).
// No 'disconnect' handler is needed and none is installed: tests/core/embedder-proc.test.cjs kills an
// owner by its exact pid mid-embed and asserts the child is gone within 2,000 ms. Nothing else requires
// this file.

const { EmbedderCore } = require('./embedder-core.cjs');

let core = null;
let sleepChain = Promise.resolve();
const opts = JSON.parse(process.argv[2] || '{}');

function fail(id, e) {
  process.send({ id, ok: false, error: { code: e && e.code, message: (e && e.message) || String(e), detail: e && e.detail } });
}

process.on('message', async (m) => {
  if (m.op === 'close') return process.exit(0);
  try {
    if (m.op === 'load') {
      if (m.testDelayMs && process.env.BELAY_TEST_MODE === '1') await new Promise(r => setTimeout(r, m.testDelayMs)); // tests only
      core = new EmbedderCore(opts);
      return process.send({ id: m.id, ok: true, result: await core.load(m.stored || null) });
    }
    if (m.op === 'env' && process.env.BELAY_TEST_MODE === '1') return process.send({ id: m.id, ok: true, result: { env: { ...process.env }, execArgv: process.execArgv } }); // tests only, needs no model
    if (m.op === 'sleep' && process.env.BELAY_TEST_MODE === '1') { // tests only: a slow op, served one at a time
      sleepChain = sleepChain.then(() => new Promise(r => setTimeout(r, m.ms)));
      return sleepChain.then(() => process.send({ id: m.id, ok: true, result: { slept: m.ms } }));
    }
    if (m.op === 'hang' && process.env.BELAY_TEST_MODE === '1') return; // tests only: never answers
    if (m.op === 'fail' && process.env.BELAY_TEST_MODE === '1') throw Object.assign(new Error('injected child failure'), m.code === undefined ? {} : { code: m.code }); // tests only: a codeless or Node-coded error
    if (!core || !core.pipe) throw Object.assign(new Error('the embedder process was asked to work before it finished loading'), { code: 'E_MODEL_ABSENT' });
    if (m.op === 'embed') return process.send({ id: m.id, ok: true, result: await core.embed(m.text, m.as) });
    if (m.op === 'tokenCount') return process.send({ id: m.id, ok: true, result: core.tokenCount(m.text) });
    throw Object.assign(new Error(`unknown embedder op ${m.op}`), { code: 'E_INTERNAL' });
  } catch (e) { fail(m.id, e); }
});
