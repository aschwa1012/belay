'use strict';
// run-live.cjs: whose is the pid a run row names? Snapshot seams stand in for the process table.

const { test } = require('node:test');
const assert = require('node:assert');
const { core } = require('./helpers.cjs');

const { adapterState, liveMessage, unverifiedWarning } = core('run-live.cjs');

const mine = { adapter_pid: process.pid, epoch: 3 };
const snapOf = (created) => async () => new Map([[process.pid, { created, image: 'node.exe', ppid: 1 }]]);
const WIN = 'win32';

test('a pid that is not running is dead', async () => {
  const r = await adapterState({ adapter_pid: 2147483000, adapter_pid_created: 5 });
  assert.strictEqual(r.state, 'dead');
});

test('a running pid with the recorded creation time is live; another creation time is dead; none recorded is unverifiable', async () => {
  assert.strictEqual((await adapterState({ ...mine, adapter_pid_created: 100 }, { snapshot: snapOf(100), platform: WIN })).state, 'live');
  assert.strictEqual((await adapterState({ ...mine, adapter_pid_created: 100 }, { snapshot: snapOf(200), platform: WIN })).state, 'dead');
  assert.strictEqual((await adapterState({ ...mine, adapter_pid_created: null }, { snapshot: snapOf(200), platform: WIN })).state, 'unverifiable');
});

test('an unreadable snapshot is unverifiable, and off Windows nothing is verified', async () => {
  assert.strictEqual((await adapterState({ ...mine, adapter_pid_created: 100 }, { snapshot: async () => null, platform: WIN })).state, 'unverifiable');
  assert.strictEqual((await adapterState({ ...mine, adapter_pid_created: 100 }, { platform: 'linux' })).state, 'unverifiable');
});

test('a pid that exits between the liveness check and the snapshot is dead (absent from the snapshot)', async () => {
  const none = async () => new Map();
  assert.strictEqual((await adapterState({ ...mine, adapter_pid_created: 100 }, { snapshot: none, platform: WIN })).state, 'dead');
  assert.strictEqual((await adapterState({ ...mine, adapter_pid_created: null }, { snapshot: none, platform: WIN })).state, 'dead');
});

test('no recorded creation time: being born after the run began is not proof (the run\'s own MCP adapter is), so it stays unverifiable', async () => {
  const row = { ...mine, adapter_pid_created: null, started_at: 1000 };
  assert.strictEqual((await adapterState(row, { snapshot: snapOf(2000), platform: WIN })).state, 'unverifiable');
  assert.strictEqual((await adapterState(row, { snapshot: snapOf(500), platform: WIN })).state, 'unverifiable');
});

test('the refusal names the pid and the other-run-id escape; the warning names the pid and why it could not be verified', () => {
  const m = liveMessage('r1', mine);
  assert.ok(m.includes(`pid ${process.pid}`) && m.includes('another run id'), m);
  const w = unverifiedWarning('r1', mine, { state: 'unverifiable', detail: 'why' });
  assert.ok(w.includes(`pid ${process.pid}`) && w.includes('why') && /attaching anyway/.test(w), w);
});
