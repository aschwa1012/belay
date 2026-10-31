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
const put = (store, id, run, rev, at) => store.p("INSERT INTO task(id, run_id, spec, state, policy_rev, written_at, written_by) VALUES (?, ?, 'x', 'open', ?, ?, 'orchestrator')").run(id, run, rev, at);

test('every version of a planned task of the run, in seq order; another run, a task with no plan and a version with no plan are left out', async () => {
  const d = sandbox();
  const s = new Store(path.join(d, 'memory.db'), { stamp: true });
  try {
    put(s, 'W', 'r1', 1, 10); put(s, 'N', 'r1', null, 11); put(s, 'O', 'r2', 1, 12); put(s, 'W', 'r1', 2, 30);
    const r = await revisions(E(s), { role: 'orchestrator', run_id: 'r1' }, {});
    assert.deepStrictEqual(r.revisions.map((x) => [x.id, x.policy_rev, x.written_at]), [['W', 1, 10], ['W', 2, 30]]);
    assert.ok(r.revisions[0].seq < r.revisions[1].seq);
    assert.deepStrictEqual((await revisions(E(s), { role: 'operator', run_id: 'r1' }, { run_id: 'r2' })).revisions.map((x) => x.id), ['O']);
    await assert.rejects(revisions(E(s), { run_id: 'r1' }, { nope: 1 }), (e) => e.code === 'E_ARGS');
    await assert.rejects(revisions(E(s), { run_id: 'r1' }, { limit: 0 }), (e) => e.code === 'E_ARGS');
  } finally { s.close(); cleanup(d); }
});
