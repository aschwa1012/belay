'use strict';
// core-fake-tasks.cjs — ADR 0031 decision 6 fixture. The real openCore, wrapped so task.list answers what
// FAKE_TASKS_MODE says: `reviews` returns three of this run's tasks (two review tasks, one work task) and
// one review task of another run; `reject` rejects. The fake orchestrator cannot call task_create, so this is
// the closest a spawned-process test gets. Confined to tests/, per src/cli/cmd-run.cjs's BELAY_FAKE_CORE guard.

const real = require('../../../src/core/index.cjs');
const { err } = require('../../../src/core/errors.cjs');

async function openCore(opts) {
  const core = await real.openCore(opts);
  const runId = opts.caller.run_id;
  core.task.list = async () => {
    if (process.env.FAKE_TASKS_MODE === 'reject') throw err('E_INTERNAL', 'PROBE: task.list rejected by the core-fake-tasks.cjs fixture');
    return {
      tasks: [
        { id: 't-work', run_id: runId, acceptance: { commands: [] } },
        { id: 't-rev-1', run_id: runId, acceptance: { verdict: true } },
        { id: 't-rev-2', run_id: runId, acceptance: JSON.stringify({ verdict: true }) },
        { id: 't-other', run_id: 'some-other-run', acceptance: { verdict: true } },
      ],
    };
  };
  return core;
}

module.exports = { openCore };
