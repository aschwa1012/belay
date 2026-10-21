'use strict';
// memory-embed-heavy.test.cjs — `belay memory embed --model <gguf embedder>` (ADR 0050 decision 4): refuses a model that is not a heavy
// embedder, loops bounded drain passes with progress, and reports a failure by name with how far it got. A fake core: no owner, no GPU.

const { test } = require('node:test');
const assert = require('node:assert');
const { doHeavy } = require('../../src/cli/cmd-memory-embed-heavy.cjs');

const EMB = 'Qwen/Qwen3-Embedding-4B-GGUF';
const fail = (code, error, message, extra = {}) => ({ code, text: `belay memory embed: ${message}\n`, json: { error: { code: error, message, ...extra } } });
const fakeCore = (passes) => { const calls = []; return { calls, memory: { drainHeavy: async (a) => { calls.push(a); const p = passes.length > 1 ? passes.shift() : passes[0]; if (p instanceof Error) throw p; return p; } } }; };
const run = (core, opts, project = 'p', lines = []) => doHeavy(core, opts, project, Date.now(), fail, (m) => lines.push(m));

test('a model that is not a heavy embedder, and the flags that do not go with it, are refused before any call', async () => {
  const core = fakeCore([{}]);
  for (const [opts, re] of [[{ model: 'nano-or-nothing' }, /heavy \(GPU\) embedder/], [{ model: 'giladgd/Qwen3-Reranker-4B-GGUF' }, /heavy \(GPU\) embedder/], [{ model: EMB, reembed: true }, /--reembed/], [{ model: EMB, dryRun: true }, /--dry-run/]]) {
    const r = await run(core, opts);
    assert.strictEqual(r.code, 2);
    assert.match(r.text, re);
  }
  assert.strictEqual((await run(core, { model: EMB }, null)).code, 2, 'no project');
  assert.deepStrictEqual(core.calls, []);
});

test('it drains in passes until the backlog is empty, with progress, and reports the total', async () => {
  const core = fakeCore([{ total: 5, written: 3, remaining: 2, done: false, dims: 2560, ms: 1 }, { total: 2, written: 2, remaining: 0, done: true, dims: 2560, ms: 1 }]);
  const lines = [];
  const r = await run(core, { model: EMB }, 'proj', lines);
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(core.calls, [{ model: EMB, namespaces: ['project/proj'] }, { model: EMB, namespaces: ['project/proj'] }]);
  assert.deepStrictEqual([r.json.total, r.json.embedded, r.json.remaining, r.json.done], [5, 5, 0, true]);
  assert.match(r.text, /embedded 5 of 5 notes/);
  assert.strictEqual(lines.length, 2);
  assert.match(lines[0], /3 of 5 embedded, 2 left/);
});

test('nothing behind is said plainly, a stalled drain exits 1, and a failure names how far it got', async () => {
  assert.match((await run(fakeCore([{ total: 0, written: 0, remaining: 0, done: true, dims: 2560, ms: 1 }]), { model: EMB })).text, /nothing to embed/);
  const stalled = await run(fakeCore([{ total: 4, written: 0, remaining: 4, done: false, dims: 2560, ms: 1 }]), { model: EMB });
  assert.strictEqual(stalled.code, 1);
  const boom = Object.assign(new Error('the GPU process exited'), { code: 'E_MODEL_ABSENT', detail: { written: 1 } });
  const r = await run(fakeCore([{ total: 5, written: 2, remaining: 3, done: false, dims: 2560, ms: 1 }, boom]), { model: EMB });
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.json.error.code, 'E_MODEL_ABSENT');
  assert.match(r.json.error.message, /3 written, the rest stay in the backlog/);
});
