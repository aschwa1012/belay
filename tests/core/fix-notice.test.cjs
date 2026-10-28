'use strict';
// fix-notice.test.cjs — ADR 0031 amendment 3: past max_fix_rounds belay still creates the fix and its answer carries a
// fix_notice; a refusal needs the user's own fix_hard_cap, and both levers are carried forward across run epochs.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch;
before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
});
after(async () => {
  try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
});

const notices = async (work, n) => {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push((await orch.task.create({ spec: `fix ${i + 1}`, repairs: work.id })).fix_notice);
  return out;
};

test('the default (2): no notice for the first two fixes, then one on each later fix, and nothing is refused', async () => {
  await orch.run.attach({ adapter_pid: process.pid, max_fix_rounds: 2 });
  const work = await orch.task.create({ spec: 'work' });
  const got = await notices(work, 4);
  assert.deepStrictEqual(got.slice(0, 2), [undefined, undefined]);
  assert.strictEqual(got[2], `task ${work.id} now has 3 fix tasks in this run, past max_fix_rounds 2`);
  assert.strictEqual(got[3], `task ${work.id} now has 4 fix tasks in this run, past max_fix_rounds 2`);
});

test('max_fix_rounds 0: the first fix carries the notice', async () => {
  await orch.run.attach({ adapter_pid: process.pid, max_fix_rounds: 0 });
  const work = await orch.task.create({ spec: 'w0' });
  assert.match((await orch.task.create({ spec: 'f', repairs: work.id })).fix_notice, /now has 1 fix task in this run, past max_fix_rounds 0/);
});

test('a hard cap refuses with nothing written; the notice still comes below it', async () => {
  await orch.run.attach({ adapter_pid: process.pid, max_fix_rounds: 1, fix_hard_cap: 3 });
  const work = await orch.task.create({ spec: 'wh' });
  const got = await notices(work, 3);
  assert.strictEqual(got[0], undefined);
  assert.ok(got[1] && got[2]);
  const before = (await orch.task.list({})).tasks.length;
  await assert.rejects(orch.task.create({ spec: 'f4', repairs: work.id }), (e) => {
    assert.strictEqual(e.code, 'E_FIX_ROUNDS');
    assert.match(e.message, /fix_hard_cap is 3/);
    assert.strictEqual(e.detail.fix_hard_cap, 3);
    return true;
  });
  assert.strictEqual((await orch.task.list({})).tasks.length, before);
});

test('both levers are carried by a reattach that does not name them, and refused if malformed', async () => {
  await orch.run.attach({ adapter_pid: process.pid, max_fix_rounds: 1, fix_hard_cap: 2 });
  await orch.run.attach({ adapter_pid: process.pid });
  const work = await orch.task.create({ spec: 'wc' });
  await orch.task.create({ spec: 'a', repairs: work.id });
  assert.ok((await orch.task.create({ spec: 'b', repairs: work.id })).fix_notice);
  await assert.rejects(orch.task.create({ spec: 'c', repairs: work.id }), (e) => e.code === 'E_FIX_ROUNDS');
  await assert.rejects(orch.run.attach({ adapter_pid: process.pid, fix_hard_cap: -1 }), (e) => e.code === 'E_ARGS');
  await orch.run.attach({ adapter_pid: process.pid, fix_hard_cap: null });
  await orch.task.create({ spec: 'c', repairs: work.id });
});

test('the default hard cap (5, no run timeout) refuses the sixth fix with a message naming its source; a null cap is notice-only', async () => {
  const SRC = 'default, no run timeout';
  await orch.run.attach({ adapter_pid: process.pid, max_fix_rounds: 2, fix_hard_cap: 5, fix_hard_cap_source: SRC });
  const work = await orch.task.create({ spec: 'wd' });
  for (let i = 0; i < 5; i += 1) await orch.task.create({ spec: `f${i}`, repairs: work.id });
  await assert.rejects(orch.task.create({ spec: 'f6', repairs: work.id }), (e) => {
    assert.strictEqual(e.code, 'E_FIX_ROUNDS');
    assert.match(e.message, /fix_hard_cap is 5 \(default, no run timeout\); nothing was written/);
    assert.strictEqual(e.detail.fix_hard_cap_source, SRC);
    return true;
  });
  // a reattach that names neither keeps the cap and its source (carried from the unended epoch)
  await orch.run.attach({ adapter_pid: process.pid });
  await assert.rejects(orch.task.create({ spec: 'f6b', repairs: work.id }), (e) => /default, no run timeout/.test(e.message));
  // a run with a timeout and no explicit cap: null cap, notice only, however many fixes
  await orch.run.attach({ adapter_pid: process.pid, max_fix_rounds: 2, fix_hard_cap: null, fix_hard_cap_source: null });
  const w2 = await orch.task.create({ spec: 'wt' });
  const got = await notices(w2, 7);
  assert.ok(got.slice(2).every(Boolean));
  // an explicit cap from the spec wins and says so
  await orch.run.attach({ adapter_pid: process.pid, fix_hard_cap: 1, fix_hard_cap_source: 'run spec' });
  const w3 = await orch.task.create({ spec: 'wx' });
  await orch.task.create({ spec: 'one', repairs: w3.id });
  await assert.rejects(orch.task.create({ spec: 'two', repairs: w3.id }), (e) => /fix_hard_cap is 1 \(run spec\)/.test(e.message));
  await assert.rejects(orch.run.attach({ adapter_pid: process.pid, fix_hard_cap_source: 7 }), (e) => e.code === 'E_ARGS');
});
