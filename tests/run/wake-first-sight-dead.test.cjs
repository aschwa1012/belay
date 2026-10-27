'use strict';
// A worker of this run first seen `dead` by the wake poll is news when it died after the baseline began: worker_spawn returned at
// ready, and a worker that crashed or was killed before the next poll must still wake the orchestrator. A death from before the
// baseline (a run id run again, a publisher started late) stays history. Pure function; no process is started.

const test = require('node:test');
const assert = require('node:assert');
const { diffWorkers } = require('../../src/run/wake.cjs');

const row = (over) => ({ id: 'w1', run_id: 'run-x', state: 'running', turns: 0, seq: 7, pid: 4242, pid_alive: true, mid_turn: 1, ...over });
const dead = (over) => row({ state: 'dead', turns: 1, pid_alive: false, mid_turn: 0, exit_code: 1, death_established_by: 'exit-event', ...over });

test('first sight of a running row that already finished a turn is news (the contrast case)', () => {
  const { events } = diffWorkers({ prev: {}, rows: [row({ turns: 1, mid_turn: 0 })], runId: 'run-x', nowMs: 1000, graceMs: 2000 });
  assert.deepEqual(events.map((e) => e.event), ['turn_end']);
});

test('first sight of a dead row of this run announces the turn it finished and the death', () => {
  const { events, next, pending_deaths } = diffWorkers({ prev: {}, rows: [dead({ exited_at: 6000 })], runId: 'run-x', nowMs: 1000, graceMs: 2000, sinceAt: 5000 });
  assert.deepEqual(events.map((e) => e.event), ['turn_end', 'death']);
  assert.deepEqual(events[1], { worker_id: 'w1', event: 'death', turn: 1, seq: 7, exit_code: 1, exit_signal: null, death_established_by: 'exit-event' });
  assert.deepEqual(pending_deaths, []);
  assert.deepEqual(next.w1, { turns: 1, state: 'dead' });
  const again = diffWorkers({ prev: next, rows: [dead({ exited_at: 6000 })], runId: 'run-x', nowMs: 2000, graceMs: 2000, sinceAt: 5000 });
  assert.deepEqual(again.events, [], 'announced once');
});

test('without a baseline time every first-sight death of this run is news', () => {
  const { events } = diffWorkers({ prev: {}, rows: [dead({})], runId: 'run-x', nowMs: 1000, graceMs: 2000 });
  assert.ok(events.some((e) => e.event === 'death'));
});

test('a dead row with no exit time is news; one that died before the baseline began is history', () => {
  assert.ok(diffWorkers({ prev: {}, rows: [dead({ exited_at: null })], runId: 'run-x', nowMs: 1, graceMs: 1, sinceAt: 5000 }).events.some((e) => e.event === 'death'));
  assert.deepEqual(diffWorkers({ prev: {}, rows: [dead({ exited_at: 4999 })], runId: 'run-x', nowMs: 1, graceMs: 1, sinceAt: 5000 }).events, []);
  assert.deepEqual(diffWorkers({ prev: {}, rows: [dead({ exited_at: 9000, run_id: 'run-other' })], runId: 'run-x', nowMs: 1, graceMs: 1, sinceAt: 5000 }).events, [], 'another run');
});
