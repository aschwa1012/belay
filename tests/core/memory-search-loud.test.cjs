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

function seedStore(dir, embedded) {
  const store = new Store(path.join(dir, 'memory.db'), { stamp: true });
  store.store({ namespace: 'run/r', worker_id: 'w', text: TEXT, ...(embedded ? { embedding: [1, 0, 0], embedding_model: 'm', embedding_revision: 'r', dim: 3 } : {}) });
  return store;
}

// ---- path 1: the owner's own search times out ----

async function owned(mode, fn, { getEmbedder, embedded } = {}) {
  const dir = sandbox();
  let c, store;
  try {
    store = seedStore(dir, embedded);
    const failures = [], pauses = [];
    const guard = createEmbedderGuard({ mode, pauseRun: async (why) => { pauses.push(why); return {}; }, stopRun: async () => {} });
    const owner = { stopped: false, opts: { embedderMode: () => guard.mode(), memoryOff: () => guard.memoryOff(), onEmbedderFailure: (ev) => { failures.push(ev); return guard.onFailure(ev); } } };
    const hung = async () => ({ embed: () => new Promise(() => {}) }); // a load that never finishes
    owner.engine = new Engine({ dataDir: dir, store, getEmbedder: getEmbedder || hung, owner, establishedBy: 'owner' });
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

test('path 2 reads the CURRENT mode of the run row: attach records the launch mode, a resume that switches it is written by run.setEmbedderMode', async () => {
  const dir = sandbox();
  let c;
  try {
    const store = seedStore(dir);
    const E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
    await assert.rejects(E.handle('run.attach', { caller: orchestrator, adapter_pid: process.pid, embedder_mode: 'sometimes' }), (e) => e.code === 'E_ARGS');
    const attached = await E.handle('run.attach', { caller: orchestrator, adapter_pid: process.pid, project: 'acme' });
    assert.strictEqual(attached.run.embedder_mode, null, 'an empty row reads as required');
    store.close();
    c = await openCore({ dataDir: dir, caller: orchestrator, embed: false });
    c._tryOwner = async () => { throw err('E_OWNER_LOST', 'seam'); };
    await assert.rejects(hybrid(c, orchestrator), (e) => e.code === 'E_SEMANTIC_REQUIRED', 'the default');
    await c.close(); c = null;

    const again = new Store(path.join(dir, 'memory.db'), { stamp: true });
    const E2 = new Engine({ dataDir: dir, store: again, getEmbedder: null, owner: null, establishedBy: 'test' });
    await assert.rejects(E2.handle('run.setEmbedderMode', { caller: orchestrator, mode: 'sometimes' }), (e) => e.code === 'E_ARGS');
    const switched = await E2.handle('run.setEmbedderMode', { caller: orchestrator, mode: 'keyword' });
    assert.strictEqual(switched.embedder_mode, 'keyword');
    assert.strictEqual(core('rows.cjs').current(again, 'run', 'r').embedder_mode, 'keyword');
    again.close();
    c = await openCore({ dataDir: dir, caller: orchestrator, embed: false });
    c._tryOwner = async () => { throw err('E_OWNER_LOST', 'seam'); };
    const r = await hybrid(c, orchestrator);
    assert.deepStrictEqual(r.modes_failed.map((f) => f.code), ['E_OWNER_LOST'], 'keyword: the fallback');
    await c.close(); c = null;

    const third = new Store(path.join(dir, 'memory.db'), { stamp: true });
    await new Engine({ dataDir: dir, store: third, getEmbedder: null, owner: null, establishedBy: 'test' }).handle('run.setEmbedderMode', { caller: orchestrator, mode: 'off' });
    third.close();
    c = await openCore({ dataDir: dir, caller: orchestrator, embed: false });
    c._tryOwner = async () => { throw err('E_OWNER_LOST', 'seam'); };
    await assert.rejects(hybrid(c, orchestrator), (e) => e.code === 'E_LEVER_OFF', 'off');
  } finally { if (c) await c.close(); cleanup(dir); }
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

// ---- B: the owner's embedder FAILS (no timeout) ----

const broken = async () => { throw err('E_MODEL_ABSENT', 'the model files are gone', { embedder: true, cause: 'absent' }); };

test('B, required: the guard pauses the run and the search rethrows the advised error, not a keyword answer', async () => {
  await owned('required', async ({ c, guard, failures, pauses }) => {
    const e = await hybrid(c, orchestrator).then(() => null, (x) => x);
    assert.ok(e, 'refused');
    assert.strictEqual(e.code, 'E_MODEL_ABSENT');
    assert.match(e.message, /belay resume r --embedder keyword\|off/);
    await guard.settled();
    assert.strictEqual(failures.length, 1);
    assert.ok(pauses.length >= 1);
  }, { getEmbedder: broken });
});

test('B, keyword: recorded by the guard, keyword answer with the cause in modes_failed, no absence claim', async () => {
  await owned('keyword', async ({ c, guard, pauses }) => {
    const r = await hybrid(c, orchestrator);
    assert.deepStrictEqual(r.modes_failed.map((f) => [f.mode, f.code]), [['semantic', 'E_MODEL_ABSENT']]);
    assert.strictEqual(r.absence_established, false);
    await guard.settled();
    assert.strictEqual(guard.events()[0].action, 'continue');
    assert.deepStrictEqual(pauses, []);
  }, { getEmbedder: broken });
});

test('B, off: the failure turns memory off and the search is refused', async () => {
  await owned('off', async ({ c, guard }) => {
    await assert.rejects(hybrid(c, orchestrator), (e) => e.code === 'E_LEVER_OFF');
    assert.strictEqual(guard.memoryOff(), true);
  }, { getEmbedder: broken });
});

// ---- C: a semantic failure that is not the embedder's ----

const stubEmbedder = async () => ({ embed: async () => ({ embedding: [1, 0, 0], embedding_model: 'other', dim: 3 }) });
const mismatch = (c, caller) => c.handle('memory.search', { caller, namespace: 'run/r', query: 'owner pipe', mode: 'hybrid', query_embedding: [1, 0, 0], embedding_model: 'other' });
const wrongDim = (c, caller) => c.handle('memory.search', { caller, namespace: 'run/r', query: 'owner pipe', mode: 'hybrid', query_embedding: [1, 0, 0, 0, 0], embedding_model: 'm' });

for (const [name, call, code] of [['E_MODEL mismatch', mismatch, 'E_MODEL'], ['dimension mismatch', wrongDim, 'E_DIM']]) {
  test('C ' + name + ', required: refused E_SEMANTIC_REQUIRED naming the cause, and the guard is NOT told', async () => {
    await owned('required', async ({ c, guard, failures, pauses }) => {
      const e = await call(c, orchestrator).then(() => null, (x) => x);
      assert.ok(e, 'refused');
      assert.strictEqual(e.code, 'E_SEMANTIC_REQUIRED');
      assert.strictEqual(e.detail.cause, code);
      assert.strictEqual(e.detail.guarded, true);
      assert.match(e.message, /a resume does not fix/);
      await guard.settled();
      assert.deepStrictEqual([failures.length, pauses.length, guard.events().length], [0, 0, 0], 'a resume fixes none of them, so the run is not paused');
    }, { getEmbedder: stubEmbedder, embedded: true });
  });

  test('C ' + name + ', keyword and off: the keyword answer stands and modes_failed names the cause', async () => {
    for (const mode of ['keyword', 'off']) {
      await owned(mode, async ({ c, guard }) => {
        const r = await call(c, orchestrator);
        assert.deepStrictEqual(r.modes_failed.map((f) => [f.mode, f.code]), [['semantic', code]], mode);
        assert.strictEqual(r.absence_established, false);
        assert.strictEqual(r.results.length, 1);
        assert.strictEqual(guard.events().length, 0);
      }, { getEmbedder: stubEmbedder, embedded: true });
    }
  });
}

// ---- A: the copy fallback with no exception ----

const unresponsive = core('unresponsive.cjs');
const QUIET = [
  ['no lock, not listening or a failed dial', async () => ({ ok: false })],
  ['an answer that timed out and backed the owner off', async () => ({ ok: false, unresponsive: unresponsive.mark('pipe-x', 1, { what: 'answer', timeout_ms: 300 }) })],
];
for (const [cause, seam] of QUIET) {
  test('A (' + cause + '), required: refused, never keyword-only; keyword: the fallback names E_NO_EMBEDDER; off: refused', async () => {
    await copied(undefined, async (c) => {
      c._tryOwner = seam;
      const e = await hybrid(c, orchestrator).then(() => null, (x) => x);
      assert.ok(e, 'refused');
      assert.strictEqual(e.code, 'E_SEMANTIC_REQUIRED');
      assert.match(e.message, /E_NO_EMBEDDER/);
    });
    await copied({ project: 'acme', on_embedder_failure: 'keyword' }, async (c) => {
      c._tryOwner = seam;
      const r = await hybrid(c, orchestrator);
      assert.deepStrictEqual(r.modes_failed.map((f) => f.code), ['E_NO_EMBEDDER']);
      assert.strictEqual(r.absence_established, false);
    });
    await copied({ project: 'acme', on_embedder_failure: 'off' }, async (c) => {
      c._tryOwner = seam;
      await assert.rejects(hybrid(c, orchestrator), (e) => e.code === 'E_LEVER_OFF');
    });
    await copied(null, async (c) => { // no run attached: the operator's search keeps its fallback
      c._tryOwner = seam;
      const r = await hybrid(c, operator);
      assert.deepStrictEqual(r.modes_failed.map((f) => f.code), ['E_NO_EMBEDDER']);
    });
  });
}

// ---- status shows an index drop or refusal ----

test('status.get counts the run\'s index_bound events, and belay status prints a line for them', async () => {
  const dir = sandbox();
  try {
    const store = seedStore(dir);
    const E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
    await E.handle('run.attach', { caller: orchestrator, adapter_pid: process.pid, project: 'acme' });
    assert.strictEqual((await E.handle('status.get', { caller: orchestrator })).run.index_bounds, undefined);
    await E.handle('memory.recordEvent', { caller: orchestrator, kind: 'index_bound', ok: false, code: 'E_INDEX_BOUND', worker_id: 'w1', message: JSON.stringify({ refused: true }) });
    await E.handle('memory.recordEvent', { caller: orchestrator, kind: 'index_bound', ok: false, code: 'E_INDEX_BOUND', worker_id: 'w2', message: JSON.stringify({ refused: false }) });
    const st = await E.handle('status.get', { caller: orchestrator });
    assert.strictEqual(st.run.index_bounds, 2);
    store.close();
  } finally { cleanup(dir); }
});
