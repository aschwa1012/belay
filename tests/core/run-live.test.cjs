'use strict';
// run-live.cjs: whose is the pid a run row names? Snapshot seams stand in for the process table.

const { test } = require('node:test');
const assert = require('node:assert');
const { core } = require('./helpers.cjs');

const { adapterState, liveMessage } = core('run-live.cjs');

const mine = { adapter_pid: process.pid, epoch: 3 };
const snapOf = (created) => async () => new Map([[process.pid, { created, image: 'node.exe', ppid: 1 }]]);

test('a pid that is not running is dead', async () => {
  const r = await adapterState({ adapter_pid: 2147483000, adapter_pid_created: 5 });
  assert.strictEqual(r.state, 'dead');
});

test('a running pid with the recorded creation time is live; another creation time is dead; none recorded is unverifiable', async () => {
  assert.strictEqual((await adapterState({ ...mine, adapter_pid_created: 100 }, { snapshot: snapOf(100), platform: 'win32' })).state, 'live');
  assert.strictEqual((await adapterState({ ...mine, adapter_pid_created: 100 }, { snapshot: snapOf(200), platform: 'win32' })).state, 'dead');
  assert.strictEqual((await adapterState({ ...mine, adapter_pid_created: null }, { snapshot: snapOf(200), platform: 'win32' })).state, 'unverifiable');
});

test('an unreadable snapshot is unverifiable, and elsewhere than Windows a running pid is live', async () => {
  assert.strictEqual((await adapterState({ ...mine, adapter_pid_created: 100 }, { snapshot: async () => null, platform: 'win32' })).state, 'unverifiable');
  assert.strictEqual((await adapterState({ ...mine, adapter_pid_created: 100 }, { platform: 'linux' })).state, 'live');
});

test('the refusal names the pid and the other-run-id escape in each case', () => {
  for (const state of ['live', 'unverifiable']) {
    const m = liveMessage('r1', mine, { state, detail: 'why' });
    assert.ok(m.includes(`pid ${process.pid}`) && m.includes('another run id'), m);
  }
});
