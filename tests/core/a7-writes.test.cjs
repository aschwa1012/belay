'use strict';
// a7-writes.test.cjs — the A7 shape in miniature (ADR 0002 evidence row C2, P3): an owner in its
// own process and two client processes writing concurrently, reconciled acked-against-rows. The lab's
// store lost 9 of 100 writes here while reporting success, so the assertion that matters is not "no
// errors" but acked_but_missing = 0 and unacked_but_present = 0.
//
// Embeddings are supplied by the callers, so this needs no model and runs in about a second.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor, startOwnerProcess, runFixture } = require('./helpers.cjs');

const { openCore } = core('index.cjs');
const { Store } = core('store.cjs');
const N = 100;

test('two client processes x 100 stores: acked equals rows, and integrity is ok', async () => {
  const dir = sandbox();
  let owner = null;
  try {
    owner = await startOwnerProcess(dir);

    const [a, b] = await Promise.all([
      runFixture('writer.cjs', [dir, 'wa', String(N)]),
      runFixture('writer.cjs', [dir, 'wb', String(N)]),
    ]);
    assert.strictEqual(a.code, 0, `writer wa exited ${a.code}: ${a.stderr}`);
    assert.strictEqual(b.code, 0, `writer wb exited ${b.code}: ${b.stderr}`);
    const ra = JSON.parse(a.stdout.trim());
    const rb = JSON.parse(b.stdout.trim());
    assert.deepStrictEqual(ra.errors, [], 'no writer may see an error');
    assert.deepStrictEqual(rb.errors, []);
    const acked = new Set([...ra.acked, ...rb.acked]);
    assert.strictEqual(ra.acked.length, N);
    assert.strictEqual(rb.acked.length, N);
    assert.strictEqual(acked.size, 2 * N, 'every acked id is distinct');

    // Read the rows back through the owner, then reconcile in both directions (P3).
    const reader = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
    const rows = [];
    for (let offset = 0; offset < 2 * N + 50; offset += 200) {
      const page = await reader.memory.list({ namespace: 'a7', limit: 200, offset });
      if (!page.rows.length) break;
      rows.push(...page.rows);
    }
    const present = new Set(rows.map(r => r.id));
    const ackedButMissing = [...acked].filter(id => !present.has(id));
    const unackedButPresent = [...present].filter(id => !acked.has(id));
    assert.deepStrictEqual(ackedButMissing, [], 'a write that was acknowledged must be in the store');
    assert.deepStrictEqual(unackedButPresent, [], 'nothing may be in the store that was never acknowledged');
    assert.strictEqual(rows.length, 2 * N);

    const stats = await reader.memory.stats({});
    assert.strictEqual(stats.owner.pid, owner.child.pid);
    assert.strictEqual(stats.owner.alive, true);

    const exited = new Promise(r => owner.child.once('exit', r));
    await reader.shutdownOwner(); // the shutdown method, never a signal
    await exited;
    owner = null;
    await reader.close();

    // With the owner gone the file is quiescent, so integrity is checkable directly on the sandbox.
    const s = new Store(path.join(dir, 'memory.db'));
    try {
      assert.deepStrictEqual(s.integrity(), ['ok']);
      assert.strictEqual(s.count(), 2 * N);
    } finally { s.close(); }
  } finally {
    if (owner) {
      try {
        const c = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
        await c.shutdownOwner();
        await c.close();
      } catch { /* already gone */ }
    }
    cleanup(dir);
  }
});
