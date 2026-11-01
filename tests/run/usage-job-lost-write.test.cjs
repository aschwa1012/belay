'use strict';
// A usage write that was sent and then lost (the owner went away, or the call timed out) may have committed. It is not re-run, and the
// next turn's row must not carry its dollars again.

const test = require('node:test');
const assert = require('node:assert');
const { usageJob } = require('../../src/run/memory-jobs.cjs');

function harness(lose) {
  const ledger = []; const events = [];
  const J = {
    w: { id: 'w1' }, gate: { aborted: false }, turnPath: false, ctx: {},
    core: {
      usage: { record: async (a) => { const lost = lose(a.turn); if (lost && lost.commit) ledger.push(a); if (lost) throw lost.err; ledger.push(a); return { seq: ledger.length }; } },
      memory: { recordEvent: async (f) => { events.push(f); return f; } },
    },
  };
  return { J, ledger, events };
}
const feed = async (J, costs) => { for (let i = 0; i < costs.length; i++) await usageJob(J, { workerId: 'w1', turn: i + 1, substrate: 'claude-code', cost: costs[i], pid: 42, usage: {} }); };
const sum = (rows) => rows.reduce((a, r) => a + r.cost_usd, 0);
const lostErr = (code, detail) => Object.assign(new Error('lost'), { code, detail });

for (const [name, err] of [['E_OWNER_LOST sent', lostErr('E_OWNER_LOST', { sent: true })], ['E_TIMEOUT', lostErr('E_TIMEOUT', { may_have_committed: true })]]) {
  test(`${name}: a committed row is not counted again in the next turn`, async () => {
    const { J, ledger, events } = harness((turn) => (turn === 2 ? { commit: true, err } : null));
    await feed(J, [1, 2, 3]);
    assert.deepStrictEqual(ledger.map((r) => r.cost_usd), [1, 1, 1]);
    assert.strictEqual(sum(ledger), 3);
    const f = events.filter((e) => e.ok === false);
    assert.strictEqual(f.length, 1); assert.match(f[0].message, /outcome unknown/);
  });
}

test('a first row lost after it was sent does not make the second row take the whole total', async () => {
  const { J, ledger } = harness((turn) => (turn === 1 ? { commit: true, err: lostErr('E_OWNER_LOST', { sent: true }) } : null));
  await feed(J, [1, 2]);
  assert.strictEqual(sum(ledger), 2);
});

test('a write known not to have been sent keeps its base: the next row folds the missed dollars in', async () => {
  const { J, ledger, events } = harness((turn) => (turn === 2 ? { commit: false, err: lostErr('E_OWNER_LOST', { sent: false, owner_stopping: true }) } : null));
  await feed(J, [1, 2, 3]);
  assert.deepStrictEqual(ledger.map((r) => r.cost_usd), [1, 2]);
  assert.doesNotMatch(events.find((e) => e.ok === false).message, /outcome unknown/);
});
