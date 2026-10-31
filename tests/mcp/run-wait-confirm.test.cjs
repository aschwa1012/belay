'use strict';
require('../helpers/tmp.cjs');
// run-wait-confirm.test.cjs — the adapter writes a worker_wait reply and then confirms the claim it made (call-signal.cjs, belay-mcp.cjs). Two real
// adapters on one sandbox store: the first delivers the digest of a policy step and is killed by its exact pid; the second, at its start, releases
// the unconfirmed claims of a dead adapter. A delivered reply was confirmed, so it stands; one whose confirmation is missing (the reply was lost
// with the adapter) is released and offered again, once.

const { test: nodeTest } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { core, sandbox, callerFor } = require('../core/helpers.cjs');
const { guarded } = require('../core/worktree-helpers.cjs');
const { createPolicyExecutor } = require('../../src/run/policy-exec.cjs');
const D = require('../../src/run/run-digest.cjs');
const { launch } = require('./rpc.cjs');

const test = guarded(nodeTest);
const { openCore } = core('index.cjs');
const RUN = 'test-run';
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };
const ENV = { BELAY_RUN_WAIT_POLL_MS: '100' };

// A store with a planned task, a refuted review and the policy fix step that answers it (one finished step), closed again.
async function seed(dir) {
  const orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  const h = orch.harness();
  const workers = [];
  const handBack = async (id, task, result) => {
    await orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: `s-${id}`, last_event_at: Date.now(), worktree: dir });
    const w = await openCore({ dataDir: `${dir}/data`, caller: callerFor('worker', { worker_id: id }), embed: false });
    workers.push(w);
    const a = await orch.task.assign({ task_id: task.id, worker_id: id });
    await w.lease.release({ lease_id: a.new_lease.id, reason: 'done', result });
    return h.task.evaluate({ task_id: task.id, worktree: dir, trigger: 'release' });
  };
  try {
    const work = await orch.task.create({ spec: 'work', acceptance: PASS, policy: { fix: 'builder' } });
    await handBack('builder-1', work, { branch: 'b', head: 'h' });
    const review = await orch.task.create({ spec: 'review', depends_on: [work.id], acceptance: { verdict: true } });
    await handBack('judge-1', review, { verdict: 'refuted', summary: 'no', findings: [{ severity: 'blocking', clause: 'a', note: 'x' }] });
    const exec = createPolicyExecutor({ core: h, runId: RUN, assignFor: (stepCore) => async (a) => stepCore.task.assign(a), closeWaitMs: 0, identity: { pid: process.pid, created: 'own' } });
    exec.arm();
    assert.deepStrictEqual((await exec.tick()).steps.map((s) => [s.step, s.outcome]), [['fix', 'done']]);
  } finally {
    for (const w of workers) await w.close();
    try { await orch.shutdownOwner(); } finally { await orch.close(); }
  }
}

const start = async (dir) => { const a = launch({ role: 'orchestrator', run: RUN, data: `${dir}/data`, fake: false, env: ENV }); await a.initialize(); return a; };
const waitCall = async (a) => (await a.call('worker_wait', { timeout_ms: 700 }, 30000)).structuredContent;
const kill = async (a) => { a.kill(); await a.exited; };

test('a delivered wait reply is confirmed and survives the next adapter; an unconfirmed one is released and offered once', async () => {
  const dir = sandbox();
  await seed(dir);
  const data = `${dir}/data`;
  const a1 = await start(dir);
  try {
    const r1 = await waitCall(a1);
    assert.strictEqual(r1.digest && r1.digest.steps, 1, JSON.stringify(r1) + a1.stderr.slice(-1500));
    assert.strictEqual(D.readDigests(data, RUN).length, 1);
    const ok = `${data}/run-wait/${RUN}/d1.json.ok`;
    for (let i = 0; i < 50 && !fs.existsSync(ok); i += 1) await new Promise((r) => setTimeout(r, 20)); // the confirm follows the write of the reply
    assert.ok(fs.existsSync(ok), 'the reply was written, so the adapter confirmed the claim');
  } finally { await kill(a1); }

  // A second adapter starts: the dead one's claim is confirmed, so it stands and the step is not offered again.
  const a2 = await start(dir);
  try {
    const r2 = await waitCall(a2);
    assert.strictEqual(r2.digest, undefined, JSON.stringify(r2));
    assert.strictEqual(D.readDigests(data, RUN).length, 1);
    // The reply to a2's own wait claimed nothing new. Now the case the confirmation exists for: a claim whose confirmation is missing.
    fs.unlinkSync(`${data}/run-wait/${RUN}/d1.json.ok`);
  } finally { await kill(a2); }

  const a3 = await start(dir);
  try {
    const r3 = await waitCall(a3);
    assert.strictEqual(r3.digest && r3.digest.steps, 1, `the unconfirmed claim of a dead adapter is released and offered again: ${JSON.stringify(r3)}`);
    const r4 = await waitCall(a3);
    assert.strictEqual(r4.digest, undefined, 'and only once');
  } finally { await kill(a3); }
});
