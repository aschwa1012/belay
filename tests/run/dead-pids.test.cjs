'use strict';
// The run's dead-pid memory (src/run/dead-pids.cjs): what it holds dead, what it forgets, and what it never remembers.
const test = require('node:test');
const assert = require('node:assert');
const { createDeadPids } = require('../../src/run/dead-pids.cjs');

const row = (o) => ({ id: 'w', run_id: 'r', state: 'running', pid: 4242, pid_created: null, seq: 5, pid_alive: true, ...o });

test('a relaunch of the same id with the same pid and no creation time reads alive', () => {
  const m = createDeadPids();
  m.apply([row({ pid_alive: false })]);
  assert.strictEqual(m.apply([row({ pid_alive: true })])[0].pid_alive, false, 'same life, number reused: held dead');
  const relaunch = m.apply([row({ pid_alive: true, state: 'starting', seq: 9 })])[0]; // a new row seq: a new life
  assert.strictEqual(relaunch.pid_alive, true);
  assert.strictEqual(m.apply([row({ pid_alive: true, state: 'running', seq: 10 })])[0].pid_alive, true, 'and stays alive');
});

test('a different pid or creation time is a different process', () => {
  const m = createDeadPids();
  m.apply([row({ pid_alive: false, pid_created: 111 })]);
  assert.strictEqual(m.apply([row({ pid_created: 222 })])[0].pid_alive, true);
  m.apply([row({ pid_alive: false })]);
  assert.strictEqual(m.apply([row({ pid: 5000 })])[0].pid_alive, true);
});

test('only life-claiming states are remembered; a terminal or parked row is never seeded', () => {
  for (const state of ['dead', 'stopped', 'paused', 'idle']) {
    const m = createDeadPids();
    m.apply([row({ state, pid_alive: false })]);
    assert.strictEqual(m.apply([row({ state, pid_alive: true })])[0].pid_alive, true, state);
  }
  const m = createDeadPids();
  m.apply([row({ pid_alive: false })]);
  m.apply([row({ state: 'dead', pid_alive: false })]); // the detector's row ends the life and clears the memory
  assert.strictEqual(m.apply([row({ pid_alive: true })])[0].pid_alive, true);
  for (const state of ['starting', 'running', 'stopping']) {
    const s = createDeadPids();
    s.apply([row({ state, pid_alive: false })]);
    assert.strictEqual(s.apply([row({ state, pid_alive: true })])[0].pid_alive, false, state);
  }
});

test('a row without a pid, or a pid_alive that is not a boolean, is passed through', () => {
  const m = createDeadPids();
  const a = row({ pid: null, pid_alive: false }); const b = row({ pid_alive: undefined });
  assert.deepStrictEqual(m.apply([a, b]), [a, b]);
});
