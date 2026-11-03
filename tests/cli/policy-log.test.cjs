'use strict';
require('../helpers/tmp.cjs');
// policy-log.test.cjs -- package I: `belay status` and `belay receipts` show the policy step log as facts (step, task, trigger, outcome, the row
// or the error, and the cost of the turn the step started, from the usage ledger), read from a copy of the store. Rows are planted on a stopped
// store; the commands are driven as subprocesses. A run with no step shows nothing, the data directory is byte-identical after the reads, and
// no CLI or status path requires the executor, the embedder or a run module.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { openCore } = require('../../src/core/index.cjs');
const { Store } = require('../../src/core/store.cjs');
const { ROOT, CLI, sandbox, cleanup } = require('./stop-helpers.cjs');

const AT = Date.UTC(2026, 9, 30, 12, 0, 0);

async function plant(dataDir, steps, usage) {
  const orch = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-p', pid: process.pid } });
  try { await orch.run.attach({ adapter_pid: process.pid }); } finally { await orch.shutdownOwner(); await orch.close(); }
  const s = new Store(path.join(dataDir, 'memory.db'), { stamp: true });
  try {
    const ins = s.p('INSERT INTO policy_step(run_id, task_id, step, trigger_table, trigger_id, trigger_seq, policy_rev, outcome, row_ref, error, worker_id, turn, at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of steps) ins.run('run-p', r.task, r.step, r.tt || 'task', r.tid || r.task, r.ts ?? 3, r.rev ?? 1, r.outcome, r.ref ?? null, r.error ?? null, r.worker ?? null, r.turn ?? null, AT + r.seq * 1000, AT + r.seq * 1000 + 5);
    const u = s.p('INSERT INTO usage(id, run_id, worker_id, task_id, turn, substrate, cost_usd, cost_basis, at, written_at, written_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of usage || []) u.run(`us-${crypto.randomUUID()}`, 'run-p', r.worker ?? null, null, r.turn, 'claude-code', r.usd, 'delta-of-cumulative', AT, AT, 'orchestrator');
  } finally { s.close(); }
}
const cli = (dataDir, ...a) => spawnSync(process.execPath, [CLI, ...a, '--data', dataDir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
const STEPS = [
  { seq: 1, task: 't1', step: 'fix', outcome: 'done', ref: 'task:t1-fix', turn: 4 },
  { seq: 2, task: 't1', step: 're_review', outcome: 'done', ref: 'task:t1-rr', worker: 'w-rev', turn: 2 },
  { seq: 3, task: 't2', step: 'integrate', tt: 'integration', tid: 'i1', outcome: 'exception', error: 'E_ARGS: a\nb', turn: 7 },
  { seq: 4, task: 't3', step: 'fix', outcome: 'started' },
];
const USAGE = [{ turn: 4, usd: 0.25 }, { turn: 4, usd: 0.5 }, { turn: 2, usd: 1.5, worker: 'w-rev' }, { turn: 2, usd: 9, worker: 'someone-else' }];

function tree(dir) {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = `${d}/${e.name}`; if (e.isDirectory()) walk(p); else out[p] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } };
  walk(dir);
  return out;
}

test('receipts and status show each step with its outcome, effect and turn cost, the same in json', async () => {
  const dir = sandbox(), dataDir = `${dir}/.belay`;
  try {
    await plant(dataDir, STEPS, USAGE);
    const rc = cli(dataDir, 'receipts', 'run-p');
    assert.strictEqual(rc.status, 0, rc.stderr);
    const text = rc.stdout.split('\n').filter((l) => /^policy steps|^ {2}step /.test(l)).map((l) => l.replace(/at \d\d:\d\d:\d\d/, 'at T'));
    assert.deepStrictEqual(text, [
      'policy steps: 4 in all',
      '  step 1 fix t1 on task:t1:3 rev 1 at T: done -> task:t1-fix (turn 4 $0.75)',
      '  step 2 re_review t1 on task:t1:3 rev 1 at T: done -> task:t1-rr (turn 2 $1.5)',
      '  step 3 integrate t2 on integration:i1:3 rev 1 at T: exception error: E_ARGS: a b (turn 7 cost not yet recorded)',
      '  step 4 fix t3 on task:t3:3 rev 1 at T: started (no turn)',
    ]);
    const j = JSON.parse(cli(dataDir, 'receipts', 'run-p', '--json').stdout).policy_log;
    assert.deepStrictEqual([j.total, j.steps.length, j.steps[0].turn_cost_usd, j.steps[0].turn_cost_rows, j.steps[2].turn_cost_usd, j.steps[3].turn], [4, 4, 0.75, 2, null, null]);
    assert.strictEqual(j.steps[1].turn_cost_usd, 1.5); // only the row of the step's own worker
    const st = cli(dataDir, 'status', 'run-p');
    assert.match(st.stdout, /^policy steps: 4 in all$/m);
    assert.match(st.stdout, /^ {2}step 3 integrate t2 on integration:i1:3 /m);
    assert.strictEqual(JSON.parse(cli(dataDir, 'status', 'run-p', '--json').stdout).policy_log.steps.length, 4);
  } finally { cleanup(dir); }
});

test('status shows the newest five and the count; receipts the whole log up to its cap', async () => {
  const dir = sandbox(), dataDir = `${dir}/.belay`;
  try {
    await plant(dataDir, Array.from({ length: 8 }, (_, i) => ({ seq: i + 1, task: `t${i}`, step: 'fix', outcome: 'done', ref: `task:f${i}` })), []);
    const st = JSON.parse(cli(dataDir, 'status', 'run-p', '--json').stdout).policy_log;
    assert.deepStrictEqual([st.total, st.steps.map((s) => s.seq)], [8, [4, 5, 6, 7, 8]]);
    assert.match(cli(dataDir, 'status', 'run-p').stdout, /^policy steps: 8 in all, newest 5$/m);
    assert.strictEqual(JSON.parse(cli(dataDir, 'receipts', 'run-p', '--json').stdout).policy_log.steps.length, 8);
  } finally { cleanup(dir); }
});

test('a run with no policy step shows nothing new, and neither command writes a byte', async () => {
  const dir = sandbox(), dataDir = `${dir}/.belay`;
  try {
    await plant(dataDir, [], []);
    for (const a of [['status', 'run-p'], ['receipts', 'run-p']]) {
      assert.ok(!/policy steps/.test(cli(dataDir, ...a).stdout));
      assert.ok(!('policy_log' in JSON.parse(cli(dataDir, ...a, '--json').stdout)));
    }
    await plant(`${dir}/.belay2`, STEPS, USAGE);
    const before = tree(`${dir}/.belay2`);
    for (const a of [['status', 'run-p'], ['receipts', 'run-p'], ['receipts', 'run-p', '--json']]) cli(`${dir}/.belay2`, ...a);
    assert.deepStrictEqual(tree(`${dir}/.belay2`), before);
  } finally { cleanup(dir); }
});

test('no CLI command or status path requires the executor, the embedder or a run module', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const bad = /require\([^)]*(policy-exec|policy-steps-run|embedder|\.\.\/run\/(?!compaction)|transformers)/;
  for (const f of ['src/core/policy-log.cjs', 'src/core/status.cjs', 'src/cli/cmd-status.cjs', 'src/cli/cmd-receipts.cjs']) assert.ok(!bad.test(read(f)), `${f} reaches a forbidden module`);
  for (const f of fs.readdirSync(path.join(ROOT, 'src/cli'))) if (f.endsWith('.cjs')) assert.ok(!/require\([^)]*policy-exec/.test(read(`src/cli/${f}`)), `${f} requires policy-exec`);
});

test('ids and errors holding a double s print as they are, and the text matches the json', async () => {
  const dir = sandbox(), dataDir = `${dir}/.belay`;
  try {
    await plant(dataDir, [{ seq: 1, task: 't-class', step: 'fix', outcome: 'exception', error: 'E_ARGS: passed, missing', turn: 1 }], []);
    const j = JSON.parse(cli(dataDir, 'receipts', 'run-p', '--json').stdout).policy_log.steps[0];
    assert.deepStrictEqual([j.task_id, j.error], ['t-class', 'E_ARGS: passed, missing']);
    for (const a of ['receipts', 'status']) assert.match(cli(dataDir, a, 'run-p').stdout.replace(/\r?\n {4}/g, ' '), /step 1 fix t-class on task:t-class:3 rev 1 at \d\d:\d\d:\d\d: exception error: E_ARGS: passed, missing \(turn 1 cost not yet recorded\)/);
  } finally { cleanup(dir); }
});

test('steps with no turn, as the executor writes them today, print (no turn) in both commands', async () => {
  const dir = sandbox(), dataDir = `${dir}/.belay`;
  try {
    await plant(dataDir, [{ seq: 1, task: 't1', step: 'fix', outcome: 'done', ref: 'task:f1' }, { seq: 2, task: 't1', step: 're_review', outcome: 'done', ref: 'task:r1' }], USAGE);
    for (const a of ['receipts', 'status']) assert.strictEqual((cli(dataDir, a, 'run-p').stdout.match(/\(no turn\)/g) || []).length, 2);
    const j = JSON.parse(cli(dataDir, 'status', 'run-p', '--json').stdout).policy_log.steps;
    assert.deepStrictEqual(j.map((s) => [s.turn, s.turn_cost_usd, s.turn_cost_rows]), [[null, null, 0], [null, null, 0]]);
  } finally { cleanup(dir); }
});

test('status.get leaves policy_log out for a worker caller and keeps it for an operator', async () => {
  const dir = sandbox(), dataDir = `${dir}/.belay`;
  try {
    await plant(dataDir, STEPS, USAGE);
    const get = async (role) => {
      const c = await openCore({ dataDir, caller: { role, run_id: 'run-p', pid: process.pid, ...(role === 'worker' ? { worker_id: 'w1' } : {}) }, embed: false });
      try { return await c.status.get({ run_id: 'run-p' }); } finally { await c.close(); }
    };
    assert.strictEqual((await get('operator')).policy_log.total, 4);
    assert.ok(!('policy_log' in await get('worker')));
  } finally { cleanup(dir); }
});
