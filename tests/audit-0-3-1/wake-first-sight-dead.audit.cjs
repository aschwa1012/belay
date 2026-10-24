'use strict';
// Audit 0.3.1, run R3. The orchestrator's baseline starts empty at its own ready event (orchestrator.cjs
// `state.baseline = {}`, wake-pipe.cjs `baseline = {}`), so every row of this run is spawned after the
// baseline began. A worker that worker_spawn returned at ready and that dies before the next 1,000 ms poll
// is first seen `dead`, and diffWorkers baselines it silently: no death wake, no turn_end wake, while a
// first-sight `running` row with a turn is reported as news. Pure function; no process is started.
// Run: node --test tests/audit-0-3-1/wake-first-sight-dead.audit.cjs (npm test does not glob *.audit.cjs).

const test = require('node:test');
const assert = require('node:assert');
const { diffWorkers } = require('../../src/run/wake.cjs');

const row = (over) => ({ id: 'w1', run_id: 'run-x', state: 'running', turns: 0, seq: 7, pid: 4242, pid_alive: true, mid_turn: 1, ...over });

test('first sight of a running row that already finished a turn is news (the contrast case)', () => {
  const { events } = diffWorkers({ prev: {}, rows: [row({ turns: 1, mid_turn: 0 })], runId: 'run-x', nowMs: 1000, graceMs: 2000 });
  assert.deepEqual(events.map((e) => e.event), ['turn_end']);
});

test('first sight of a dead row of this run announces the death (and the turn it finished)', () => {
  const { events } = diffWorkers({
    prev: {}, rows: [row({ state: 'dead', turns: 1, pid_alive: false, mid_turn: 0, exit_code: 1, death_established_by: 'exit-event' })],
    runId: 'run-x', nowMs: 1000, graceMs: 2000,
  });
  console.log(JSON.stringify({ events }));
  assert.ok(events.some((e) => e.event === 'death'), 'a worker of this run that died between two polls must still wake the orchestrator');
});
