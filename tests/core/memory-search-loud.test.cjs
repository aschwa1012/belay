'use strict';
// memory-search-loud.test.cjs — a hybrid search whose semantic half fails does not degrade silently in a run (ADR 0034 and amendment 1).
// Path 1: the owner's own search times out while the embedder is slow. Path 2: the owner cannot be reached and the call falls back to a
// copy. Under `required` both are refused (path 1 also pauses the run through the guard); under `keyword` both keep the keyword answer
// and name the failure; under `off` both are refused; with no run attached the keyword fallback stays. Seams only: a stalled embed that
// never resolves, a stubbed owner lookup, and a limit of a few milliseconds. No sleeps and no load.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Engine } = core('engine.cjs');
const { Store } = core('store.cjs');
const { err } = core('errors.cjs');
const { openCore } = core('index.cjs');
const { renderSearchText } = require('../../src/cli/memory-render.cjs');
const { createEmbedderGuard } = require('../../src/run/embedder-guard.cjs');

const TEXT = 'The owner pipe wedges when the loop blocks on CreateProcess';
const worker = callerFor('worker', { run_id: 'r', worker_id: 'w1' });
const orchestrator = callerFor('orchestrator', { run_id: 'r' });
const operator = callerFor('operator');

function seedStore(dir, levers) {
  const store = new Store(path.join(dir, 'memory.db'), { stamp: true });
  store.store({ namespace: 'run/r', worker_id: 'w', text: TEXT });
  return store;
}

// ---- path 1: the owner's own search times out ----

async function owned(mode, fn) {
  const dir = sandbox();
  let c, store;
  try {
    store = seedStore(dir);
    const failures = [], pauses = [];
    const guard = createEmbedderGuard({ mode, pauseRun: async (why) => { pauses.push(why); return {}; }, stopRun: async () => {} });
    const owner = { stopped: false, opts: { embedderMode: () => guard.mode(), memoryOff: () => guard.memoryOff(), onEmbedderFailure: (ev) => { failures.push(ev); return guard.onFailure(ev); } } };
    const hung = async () => ({ embed: () => new Promise(() => {}) }); // a load that never finishes
    owner.engine = new Engine({ dataDir: dir, store, getEmbedder: hung, owner, establishedBy: 'owner' });
    c = await openCore({ dataDir: dir, caller: orchestrator, embed: false });
    c.owner = owner;
    c.vectorLimitMs = 20; // the in-process limit; production sets it under BELAY_TEST_MODE only
    await fn({ c, guard, failures, pauses });
  } finally { if (c) { c.owner = null; await c.close(); } if (store) store.close(); cleanup(dir); }
}
const hybrid = (c, caller) => c.handle('memory.search', { caller, namespace: 'run/r', query: 'owner pipe', mode: 'hybrid' });

test('path 1, required: the timeout reaches the guard and pauses the run, and the search is refused with the pause advice of the role', async () => {
  await owned('required', async ({ c, guard, failures, pauses }) => {
    const o = await hybrid(c, orchestrator).then(() => null, (e) => e);
    assert.ok(o, 'refused, not answered from keywords');
    assert.strictEqual(o.code, 'E_EMBED_BOUND');
    assert.strictEqual(o.detail.embedder, true);
    assert.strictEqual(o.detail.cause, 'timeout');
    assert.match(o.message, /belay resume r --embedder keyword\|off/, 'the orchestrator is told the operator\'s choices');
    // A Core speaks as its own process, so the worker's text is checked on the same advice function with a worker caller.
    const wErr = err('E_EMBED_BOUND', 'seam', { embedder: true, cause: 'timeout' });
    require('../../src/core/methods-memory.cjs').adviseEmbedderFailure(c.owner.engine, worker, wErr);
    assert.match(wErr.message, /Stop and wait: you will be resumed/, 'a worker gets its own advice');
    assert.doesNotMatch(wErr.message, /belay resume/);
    await guard.settled();
    assert.strictEqual(failures.length, 1);
    assert.strictEqual(failures[0].call, 'memory.search');
    assert.ok(pauses.length >= 1 && /embedder-failure/.test(pauses[0]), 'the run was asked to pause');
    assert.strictEqual(guard.events()[0].action, 'pause');
  });
});

test('path 1, keyword: the failure is recorded and the keyword answer stands, with the failure in modes_failed and no absence claim', async () => {
  await owned('keyword', async ({ c, guard, failures, pauses }) => {
    const r = await hybrid(c, orchestrator);
    assert.strictEqual(r.results.length, 1);
    assert.deepStrictEqual(r.modes_failed.map((f) => [f.mode, f.code]), [['semantic', 'E_TIMEOUT']]);
    assert.deepStrictEqual(r.modes_run, ['keyword']);
    assert.strictEqual(r.absence_established, false);
    await guard.settled();
    assert.strictEqual(failures.length, 1, 'the guard heard of it');
    assert.strictEqual(guard.events()[0].action, 'continue');
    assert.deepStrictEqual(pauses, []);
    const none = await c.handle('memory.search', { caller: orchestrator, namespace: 'run/r', query: 'zzzqqq nothing', mode: 'hybrid' });
    assert.strictEqual(none.absence_established, false, 'an empty answer is still no absence claim');
  });
});

test('path 1, off: the failure turns memory off and the search is refused', async () => {
  await owned('off', async ({ c, guard, pauses }) => {
    const e = await hybrid(c, orchestrator).then(() => null, (x) => x);
    assert.ok(e);
    assert.strictEqual(e.code, 'E_LEVER_OFF');
    assert.strictEqual(guard.memoryOff(), true);
    assert.deepStrictEqual(pauses, []);
  });
});

test('path 1, no run (a standalone owner with no guard): the keyword fallback stays', async () => {
  const dir = sandbox();
  let c, store;
  try {
    store = seedStore(dir);
    const hung = async () => ({ embed: () => new Promise(() => {}) });
    const engine = new Engine({ dataDir: dir, store, getEmbedder: hung, owner: null, establishedBy: 'owner' });
    c = await openCore({ dataDir: dir, caller: operator, embed: false });
    c.owner = { stopped: false, engine };
    c.vectorLimitMs = 20;
    const r = await c.handle('memory.search', { caller: operator, namespace: 'run/r', query: 'owner pipe', mode: 'hybrid' });
    assert.deepStrictEqual(r.modes_failed.map((f) => f.code), ['E_TIMEOUT']);
    assert.strictEqual(r.absence_established, false);
    assert.match(renderSearchText(r, 'full'), /^\*\*\* SEMANTIC SEARCH DID NOT RUN/m, 'the CLI text says so');
  } finally { if (c) { c.owner = null; await c.close(); } if (store) store.close(); cleanup(dir); }
});

// ---- path 2: the owner cannot be reached and the call falls back to a copy ----

async function copied(levers, fn) {
  const dir = sandbox();
  let c;
  try {
    const store = seedStore(dir);
    const E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
    if (levers !== null) await E.handle('run.attach', { caller: orchestrator, adapter_pid: process.pid, project: 'acme', ...(levers ? { memory_levers: JSON.stringify(levers) } : {}) });
    store.close();
    c = await openCore({ dataDir: dir, caller: orchestrator, embed: false });
    c._tryOwner = async () => { throw err('E_OWNER_LOST', 'seam: the owner did not answer its ping'); }; // an unreachable owner, without a process or a wait
    await fn(c);
  } finally { if (c) await c.close(); cleanup(dir); }
}

test('path 2, required (the default for an attached run): the search is refused naming the cause, with advice for the role, and no keyword result is returned', async () => {
  await copied(undefined, async (c) => {
    const o = await hybrid(c, orchestrator).then(() => null, (e) => e);
    assert.ok(o, 'refused');
    assert.strictEqual(o.code, 'E_SEMANTIC_REQUIRED');
    assert.match(o.message, /E_OWNER_LOST/);
    assert.match(o.message, /embedder mode is required/);
    assert.match(o.message, /belay resume r/);
    assert.strictEqual(o.detail.mode, 'required');
    await assert.rejects(hybrid(c, orchestrator), (e) => e.code === 'E_SEMANTIC_REQUIRED');
  });
});

test('path 2, keyword: the copy answers from keywords and names the failure; absence is not claimed', async () => {
  await copied({ project: 'acme', on_embedder_failure: 'keyword' }, async (c) => {
    const r = await hybrid(c, orchestrator);
    assert.strictEqual(r.results.length, 1);
    assert.deepStrictEqual(r.modes_failed.map((f) => [f.mode, f.code]), [['semantic', 'E_OWNER_LOST']]);
    assert.strictEqual(r.absence_established, false);
  });
});

test('path 2, off: the search is refused', async () => {
  await copied({ project: 'acme', on_embedder_failure: 'off' }, async (c) => {
    await assert.rejects(hybrid(c, orchestrator), (e) => e.code === 'E_LEVER_OFF');
  });
});

test('path 2, no run attached: the operator\'s CLI search keeps the keyword fallback, and its text says loudly that the semantic half did not run', async () => {
  await copied(null, async (c) => {
    for (const caller of [operator, orchestrator]) { // the second names a run that has no row
      const r = await hybrid(c, caller);
      assert.strictEqual(r.results.length, 1);
      assert.deepStrictEqual(r.modes_failed.map((f) => f.code), ['E_OWNER_LOST']);
      assert.strictEqual(r.absence_established, false);
      const text = renderSearchText(r, 'full');
      assert.match(text, /^\*\*\* SEMANTIC SEARCH DID NOT RUN/m);
      assert.match(text, /failed: semantic E_OWNER_LOST/);
    }
  });
});

test('path 2, an ended run is not a live run: the keyword fallback stays', async () => {
  const dir = sandbox();
  let c;
  try {
    const store = seedStore(dir);
    const E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
    await E.handle('run.attach', { caller: orchestrator, adapter_pid: process.pid, project: 'acme' });
    core('rows.cjs').append(store, 'run', { ...core('rows.cjs').current(store, 'run', 'r'), ended_at: Date.now(), exit_reason: 'test' }, 'test');
    store.close();
    c = await openCore({ dataDir: dir, caller: orchestrator, embed: false });
    c._tryOwner = async () => { throw err('E_OWNER_LOST', 'seam'); };
    const r = await hybrid(c, orchestrator);
    assert.deepStrictEqual(r.modes_failed.map((f) => f.code), ['E_OWNER_LOST']);
  } finally { if (c) await c.close(); cleanup(dir); }
});
