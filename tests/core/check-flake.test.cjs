'use strict';
// check-flake.test.cjs -- the store-wide flaky-check record (item J). The row must equal a hand count of the evaluations it saw:
// a replay of pass, fail, pass and a concurrent flag on one key, a retry's pass after a failure inside one evaluation, the
// head fallback, a check that did not run, and then the same through a real task.evaluate on a throwaway repository, where
// the row is written in the evaluation's own write. Deterministic: the flip is driven by a counter file, never a sleep.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo } = require('./worktree-helpers.cjs');

const { Store } = core('store.cjs');
const { openCore } = core('index.cjs');
const F = core('check-flake.cjs');

const ARGV = ['npm', 'test'];
const check = (passed, extra = {}) => ({ kind: 'command', argv: ARGV, executable: true, exit_code: passed ? 0 : 1, passed, ...extra, detail: { cwd: '/w', ...(extra.detail || {}) } });
const TREE = { head_sha: 'h1', tree_sha: 't1' };
const rowsOf = (s) => s.p('SELECT * FROM check_flake ORDER BY key_kind, key_sha').all();

test('a replay of evaluations on one key leaves the row a hand count says', () => {
  const d = sandbox();
  const s = new Store(path.join(d, 'memory.db'), { stamp: true });
  try {
    F.record(s, [check(true)], TREE, 10);                                      // pass            pass 1 fail 0 flips 0
    F.record(s, [check(false)], TREE, 20);                                     // fail            pass 1 fail 1 flips 1
    F.record(s, [check(true, { concurrent: [{ task_id: 'x', overlap_ms: 5 }] })], TREE, 30); // pass, beside another: pass 2 fail 1 flips 2
    F.record(s, [check(true)], TREE, 40);                                      // pass again      pass 3 fail 1 flips 2
    const [r, ...rest] = rowsOf(s);
    assert.strictEqual(rest.length, 0);
    assert.deepStrictEqual({ ...r }, { argv: JSON.stringify(ARGV), cwd: '/w', key_sha: 't1', key_kind: 'tree', pass_n: 3, fail_n: 1, flips: 2, last_outcome: 'pass', last_concurrent: 0, first_at: 10, last_at: 40 });
    F.record(s, [check(false, { concurrent: [{ task_id: 'x', overlap_ms: 5 }] })], TREE, 50);
    assert.strictEqual(rowsOf(s)[0].last_concurrent, 1);
    assert.strictEqual(rowsOf(s)[0].flips, 3);
  } finally { s.close(); cleanup(d); }
});

test('a pass on a retry inside one evaluation is a flip; a steady key and a check that did not run are not', () => {
  const d = sandbox();
  const s = new Store(path.join(d, 'memory.db'), { stamp: true });
  try {
    const retried = check(true, { detail: { attempts: [{ exit_code: 1, timed_out: false }, { exit_code: 0, timed_out: false }] } });
    F.record(s, [retried], TREE, 1);
    let r = rowsOf(s)[0];
    assert.deepStrictEqual([r.pass_n, r.fail_n, r.flips, r.last_outcome], [1, 1, 1, 'pass']);
    F.record(s, [{ ...check(false), argv: ['other'], executable: false }], TREE, 2);  // did not run: no row
    F.record(s, [{ ...check(true), argv: ['steady'] }], TREE, 3);
    F.record(s, [{ ...check(true), argv: ['steady'] }], TREE, 4);
    const steady = s.p('SELECT * FROM check_flake WHERE argv = ?').get(JSON.stringify(['steady']));
    assert.deepStrictEqual([steady.pass_n, steady.fail_n, steady.flips], [2, 0, 0]);
    assert.strictEqual(rowsOf(s).length, 2);
    assert.deepStrictEqual(F.list({ store: s }).keys.map((k) => k.argv), [ARGV], 'only the flipped key is listed');
    assert.strictEqual(F.list({ store: s }, null, { all: true }).keys.length, 2);
  } finally { s.close(); cleanup(d); }
});

test('with no tree id the head keys the row, and with neither nothing is recorded', () => {
  const d = sandbox();
  const s = new Store(path.join(d, 'memory.db'), { stamp: true });
  try {
    assert.strictEqual(F.record(s, [check(true)], { head_sha: 'h9' }, 1), 1);
    assert.strictEqual(F.record(s, [check(true)], null, 2), 0);
    const r = rowsOf(s);
    assert.deepStrictEqual(r.map((x) => [x.key_kind, x.key_sha]), [['head', 'h9']]);
  } finally { s.close(); cleanup(d); }
});

test('task.evaluate writes the row in its own write: a fail then a pass on one tree is one flip', async () => {
  const dir = sandbox();
  const repo = makeRepo(dir);
  const data = `${dir}/data`;
  const orch = await openCore({ dataDir: data, caller: callerFor('orchestrator'), embed: false });
  try {
    await orch.run.attach({ adapter_pid: process.pid, project_dir: repo });
    const counter = path.join(dir, 'count.txt').split(path.sep).join('/');
    const src = `const f=${JSON.stringify(counter)},fs=require('fs');const n=fs.existsSync(f)?+fs.readFileSync(f,'utf8'):0;fs.writeFileSync(f,String(n+1));process.exit(n===0?1:0)`;
    let t = await orch.task.create({ spec: 'flake', acceptance: { commands: [{ argv: [process.execPath, '-e', src], timeout_ms: 20000 }] } });
    t = await orch.task.worktreeCreate({ task_id: t.id });
    assert.deepStrictEqual((await orch.check.flake({ all: true })).keys, []);
    const first = await orch.task.evaluate({ task_id: t.id });
    assert.notStrictEqual(first.state, 'done');
    let k = (await orch.check.flake({ all: true })).keys;
    assert.strictEqual(k.length, 1);
    assert.deepStrictEqual([k[0].pass_n, k[0].fail_n, k[0].flips, k[0].key_kind, k[0].last_outcome], [0, 1, 0, 'tree', 'fail']);
    assert.strictEqual(k[0].key_sha, first.results.tree_sha, 'keyed by the tree the evaluation judged');
    const second = await orch.task.evaluate({ task_id: t.id });
    assert.strictEqual(second.state, 'done');
    k = (await orch.check.flake({})).keys;
    assert.strictEqual(k.length, 1);
    assert.deepStrictEqual([k[0].pass_n, k[0].fail_n, k[0].flips, k[0].last_outcome], [1, 1, 1, 'pass']);
  } finally { try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); } }
});

test('an attempt the evaluation budget cut short is not an outcome', () => {
  const d = sandbox();
  const s = new Store(path.join(d, 'memory.db'), { stamp: true });
  try {
    F.record(s, [check(true)], TREE, 1);
    F.record(s, [check(false, { detail: { timed_out: true, budget_capped_ms: 500 } })], TREE, 2); // capped timeout: nothing recorded
    let r = rowsOf(s)[0];
    assert.deepStrictEqual([r.pass_n, r.fail_n, r.flips, r.last_at], [1, 0, 0, 1]);
    // a timeout with no cap is the command's own failure; a capped retry is dropped while the real failure before it counts
    F.record(s, [check(false, { detail: { timed_out: true } })], TREE, 3);
    assert.deepStrictEqual([rowsOf(s)[0].fail_n, rowsOf(s)[0].flips], [1, 1]);
    const capped = check(false, { detail: { budget_capped_ms: 500, attempts: [{ exit_code: 1, timed_out: false }, { exit_code: null, timed_out: true }] } });
    F.record(s, [capped], TREE, 4);
    r = rowsOf(s)[0];
    assert.deepStrictEqual([r.pass_n, r.fail_n, r.flips], [1, 2, 1]);
  } finally { s.close(); cleanup(d); }
});

test('a rolled-back evaluation write leaves no row', () => {
  const d = sandbox();
  const s = new Store(path.join(d, 'memory.db'), { stamp: true });
  try {
    assert.throws(() => s.tx(() => { F.record(s, [check(true)], TREE, 1); throw new Error('the result row failed'); }), /result row failed/);
    assert.strictEqual(rowsOf(s).length, 0);
  } finally { s.close(); cleanup(d); }
});

test('list caps the rows and counts them all; a missing table is empty and any other failure is thrown', () => {
  const d = sandbox();
  const s = new Store(path.join(d, 'memory.db'), { stamp: true });
  try {
    for (let i = 0; i < 4; i++) { F.record(s, [{ ...check(true), argv: ['k', String(i)] }], TREE, 10 + i); F.record(s, [{ ...check(false), argv: ['k', String(i)] }], TREE, 20 + i); }
    const got = F.list({ store: s }, null, { limit: 3 });
    assert.strictEqual(got.total, 4);
    assert.deepStrictEqual(got.keys.map((k) => k.argv[1]), ['3', '2', '1'], 'newest first');
    assert.deepStrictEqual(s.p("SELECT name FROM sqlite_master WHERE name = 'ix_check_flake_flipped'").all().length, 1);
    s.db.exec('DROP INDEX ix_check_flake_flipped; DROP TABLE check_flake');
    assert.deepStrictEqual(F.list({ store: s }), { keys: [], total: 0 });
    assert.throws(() => F.list({ store: { p() { throw new Error('database disk image is malformed'); } } }), /malformed/);
  } finally { s.close(); cleanup(d); }
});

test('line names the program by its last path part for a Windows path too', () => {
  const bs = String.fromCharCode(92);
  const k = { argv: [`C:${bs}node${bs}node.exe`, 'x.js'], key_kind: 'tree', key_sha: 'abc', pass_n: 1, fail_n: 1, flips: 1, last_outcome: 'fail', last_concurrent: false };
  assert.match(F.line(k), /^flaky check: node\.exe x\.js /);
});
