'use strict';
require('../helpers/tmp.cjs');
// policy-exec-start.test.cjs — a plan-first orchestrator's first turn calls task_create and nothing that opens the run manager. The policy
// executor lives beside the run manager, so it must start when the adapter attaches to a run with a plan, or its builds wait for a worker
// tool call that never comes. The REAL core and the REAL adapter; the orchestrator calls task_create only.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor, sleep } = require('../core/helpers.cjs');
const { launch } = require('./rpc.cjs');

const { openCore } = core('index.cjs');
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };
const RUN = 'start-run';

async function plannedBuild(t, { defaultPlan, taskPlan }) {
  const dir = sandbox();
  const data = `${dir}/data`;
  const wt = `${dir}/wt`; fs.mkdirSync(wt, { recursive: true });
  const operator = await openCore({ dataDir: data, caller: { ...callerFor('operator'), run_id: RUN }, embed: false });
  await operator.run.attach({ adapter_pid: process.pid, ...(defaultPlan ? { policy_default: { build: { worker: 'b1' } } } : {}) });
  const fake = path.join(__dirname, '..', 'run', 'fakes', 'fake-claude.cjs').split(path.sep).join('/');
  const orch = launch({ role: 'orchestrator', run: RUN, data, fake: false, noEmbed: true, cwd: wt, env: { BELAY_CLAUDE_EXE: fake, BELAY_POLICY_TICK_MS: '200' } });
  t.after(async () => {
    await orch.close(); orch.kill();
    try { await operator.shutdownOwner(); } finally { await operator.close(); cleanup(dir, { skipInvariants: { rules: ['done_evidence'], reason: 'the test stops mid-plan' } }); }
  });
  await orch.initialize();
  const made = await orch.call('task_create', { id: 'ps-1', spec: 'build me', acceptance: PASS, ...(taskPlan ? { policy: { build: { worker: 'b1' } } } : {}) });
  assert.ok(!made.isError, JSON.stringify(made));
  let steps = [];
  for (let i = 0; i < 100 && !steps.some((s) => s.step === 'build' && s.task_id === 'ps-1'); i++) {
    await sleep(200);
    steps = ((await operator.policy.list({})) || {}).rows || [];
  }
  assert.ok(steps.some((s) => s.step === 'build' && s.task_id === 'ps-1'), `the executor claimed the build: ${JSON.stringify(steps)}\n${orch.stderr.slice(-600)}`);
}

test('a task_create alone, under the plan in force plan, gets its build claimed by the executor with no worker tool call', { timeout: 90000 }, (t) => plannedBuild(t, { defaultPlan: true }));
test('a task_create that states a plan opens the executor too, once the row is written', { timeout: 90000 }, (t) => plannedBuild(t, { taskPlan: true }));
