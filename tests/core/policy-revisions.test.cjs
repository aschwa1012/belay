'use strict';
// policy-revisions.test.cjs -- policy.revisions: the plan revision of every version of the run's tasks, read from the append-only task rows.
// A real sandbox store; the rows are written as the amend writes them (a new version with a higher policy_rev).

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { core, sandbox, cleanup } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { revisions } = core('policy-revisions.cjs');

const E = (store) => ({ store });
const put = (store, id, run, rev, at, results = null) => store.p("INSERT INTO task(id, run_id, spec, state, policy_rev, written_at, written_by, results) VALUES (?, ?, 'x', 'open', ?, ?, 'orchestrator', ?)").run(id, run, rev, at, results && JSON.stringify(results));

test('every version of a planned task of the run, in seq order; another run, a task with no plan and a version with no plan are left out', async () => {
  const d = sandbox();
  const s = new Store(path.join(d, 'memory.db'), { stamp: true });
  try {
    put(s, 'W', 'r1', 1, 10); put(s, 'N', 'r1', null, 11); put(s, 'O', 'r2', 1, 12); put(s, 'W', 'r1', 2, 30);
    const r = await revisions(E(s), { role: 'orchestrator', run_id: 'r1' }, {});
    assert.deepStrictEqual(r.revisions.map((x) => [x.id, x.policy_rev, x.written_at]), [['W', 1, 10], ['W', 2, 30]]);
    assert.strictEqual(r.truncated, false);
    assert.ok(r.revisions[0].seq < r.revisions[1].seq);
    assert.deepStrictEqual((await revisions(E(s), { role: 'operator', run_id: 'r1' }, { run_id: 'r2' })).revisions.map((x) => x.id), ['O']);
    await assert.rejects(revisions(E(s), { run_id: 'r1' }, { nope: 1 }), (e) => e.code === 'E_ARGS');
    await assert.rejects(revisions(E(s), { run_id: 'r1' }, { limit: 0 }), (e) => e.code === 'E_ARGS');
  } finally { s.close(); cleanup(d); }
});

test('with task_ids: exactly those tasks, every version (a null policy_rev too), the evaluation each holds, and a run past the limit is truncated, never silently cut', async () => {
  const d = sandbox();
  const s = new Store(path.join(d, 'memory.db'), { stamp: true });
  try {
    put(s, 'W', 'r1', 1, 10); put(s, 'W', 'r1', 1, 20, { evaluated_at: 20, passed: true }); put(s, 'F', 'r1', null, 25);
    for (let i = 0; i < 40; i += 1) put(s, `other${i % 4}`, 'r1', 1, 100 + i); // a busy run: many versions of tasks that were not asked for
    put(s, 'W', 'r1', 2, 30);
    const caller = { role: 'orchestrator', run_id: 'r1' };
    const got = await revisions(E(s), caller, { task_ids: ['W', 'F'], limit: 10 });
    assert.strictEqual(got.truncated, false, 'versions of tasks not asked for do not count against the limit');
    assert.deepStrictEqual(got.revisions.map((x) => [x.id, x.policy_rev, x.evaluated_at]), [['W', 1, null], ['W', 1, 20], ['F', null, null], ['W', 2, null]]);
    const cut = await revisions(E(s), caller, { task_ids: ['W', 'F'], limit: 2 });
    assert.deepStrictEqual([cut.revisions.length, cut.truncated], [2, true]);
    assert.strictEqual((await revisions(E(s), caller, { limit: 5 })).truncated, true, 'no task_ids: the planned versions of the whole run, cut off and said so');
    assert.deepStrictEqual(await revisions(E(s), caller, { task_ids: [] }), { revisions: [], truncated: false });
    assert.deepStrictEqual((await revisions(E(s), { role: 'orchestrator', run_id: 'r2' }, { task_ids: ['W'] })).revisions, [], 'another run tasks are not read');
    await assert.rejects(revisions(E(s), caller, { task_ids: 'W' }), (e) => e.code === 'E_ARGS');
  } finally { s.close(); cleanup(d); }
});
