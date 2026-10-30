'use strict';
// policy-stamp-bound.test.cjs -- ADR 0072 decision 3 over the owner `belay run` really uses: a bound owner rebuilds a keyed request's caller
// from the bind's identity, so the step the run manager acts for must survive that admission, and only for the orchestrator's harness bind.
// A real Owner over a real pipe in a sandbox and a raw socket carrying the orchestrator's key, as ticket-bound.test.cjs does.

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { core, sandbox, cleanup } = require('./helpers.cjs');

const { Owner } = core('owner.cjs');
const { claimBind } = core('bind.cjs');

const RUN = 'run-bound-step';
const operatorCaller = { role: 'operator', run_id: RUN, pid: process.pid };

function rawCall(pipe, method, params, key) {
  return new Promise((resolve, reject) => {
    const s = net.connect(pipe);
    let buf = '';
    const timer = setTimeout(() => { s.destroy(); reject(new Error(`no answer to ${method}`)); }, 15000);
    s.on('data', (d) => {
      buf += d.toString('utf8');
      if (buf.indexOf('\n') < 0) return;
      clearTimeout(timer); s.destroy();
      resolve(JSON.parse(buf.split('\n')[0]));
    });
    s.on('error', (e) => { clearTimeout(timer); reject(e); });
    s.on('connect', () => s.write(JSON.stringify({ id: 1, method, params, ...(key ? { key } : {}) }) + '\n'));
  });
}

test('a bound owner keeps the policy step of the orchestrator\'s harness bind: stamped, superseded and refused as in process', async () => {
  const dir = sandbox();
  const o = new Owner(dir, { embed: false, mode: 'bound', operatorCheck: async () => ({ ok: false, reason: 'no operator here' }) });
  await o.start();
  try {
    const orch = await claimBind((await o.bindCall('bind.open', { identity: { role: 'orchestrator', run_id: RUN } }, operatorCaller)).pipe);
    const call = async (method, params, caller = {}) => {
      const r = await rawCall(o.pipe, method, { ...params, caller }, orch.key);
      if (r.error) { const e = new Error(r.error.message); e.code = r.error.code; throw e; }
      return r.result;
    };
    const harness = (step) => ({ channel: 'harness', ...(step === undefined ? {} : { policy_step: step }) });
    await call('run.attach', { adapter_pid: process.pid });
    await call('worker.write', { id: 'wk-b', substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: 's-wk-b', last_event_at: Date.now(), worktree: dir });
    const claim = async (task) => (await call('policy.claim', { step: 'fix', trigger: { table: 'task', id: task.id, seq: task.seq }, policy_rev: 5 }, harness())).row.seq;

    // the step reaches the core: the lease is the step's
    const t1 = await call('task.create', { spec: 'bound one' });
    const seq1 = await claim(t1);
    const first = await call('task.assign', { task_id: t1.id, worker_id: 'wk-b' }, harness(seq1));
    assert.deepStrictEqual([first.new_lease.acted_by, first.new_lease.policy_rev, first.new_lease.trigger], ['policy', 5, { table: 'task', id: t1.id, seq: t1.seq }]);
    assert.strictEqual(first.task.policy_rev, null, 'a task\'s policy_rev is the plan\'s, not the claim\'s');

    // the orchestrator acted first: the step is superseded, not a second lease
    const t2 = await call('task.create', { spec: 'bound two' });
    const seq2 = await claim(t2);
    const mine = await call('task.assign', { task_id: t2.id, worker_id: 'wk-b' }, {});
    assert.strictEqual(mine.new_lease.acted_by, null);
    const late = await call('task.assign', { task_id: t2.id, worker_id: 'wk-b' }, harness(seq2));
    assert.deepStrictEqual([late.existing, late.superseded, late.new_lease.id], [true, true, mine.new_lease.id]);

    // a step's merge is refused for any branch but the run's own, and without the step the same request is a plain orchestrator call
    await assert.rejects(call('integration.merge', { task_ids: ['no-such-task'], into: 'main' }, harness(seq1)), (e) => e.code === 'E_ARGS' && /policy step/.test(e.message));
    await assert.rejects(call('integration.merge', { task_ids: ['no-such-task'], force: true, reason: 'x' }, harness(seq1)), (e) => e.code === 'E_ARGS' && /policy step/.test(e.message));
    await assert.rejects(call('integration.merge', { task_ids: ['no-such-task'], into: 'main' }, harness()), (e) => e.code === 'E_NOT_FOUND');

    // a step that is not an open claim of this run, or is not an integer, is refused or dropped
    await assert.rejects(call('task.assign', { task_id: t1.id, worker_id: 'wk-b' }, harness(999999)), (e) => e.code === 'E_ARGS');
    const tool = await call('task.assign', { task_id: t1.id, worker_id: 'wk-b' }, { channel: 'tool', policy_step: seq1 });
    assert.strictEqual(tool.existing, true, 'a tool-channel request carries no step: it is the orchestrator\'s call');
    assert.strictEqual(tool.superseded, undefined);
  } finally { await o.stop().catch(() => {}); cleanup(dir); }
});
