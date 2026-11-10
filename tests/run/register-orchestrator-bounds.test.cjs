'use strict';
require('../helpers/tmp.cjs');
// register-orchestrator-bounds.test.cjs — when the headless orchestrator's creation time is read for its spawn-register record: against a
// lower bound taken before the spawn call (a slow registration must not refuse the true reading), never after the child has exited, and
// with one line when the bounded readings are used up.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { registerOrchestrator } = require('../../src/run/register-orchestrator.cjs');

async function withRegistry(fn) {
  const keep = process.env.BELAY_SPAWN_REGISTRY;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-reg-orch-'));
  process.env.BELAY_SPAWN_REGISTRY = dir;
  try { return await fn(dir); } finally { process.env.BELAY_SPAWN_REGISTRY = keep; fs.rmSync(dir, { recursive: true, force: true }); }
}
const tick = () => new Promise((r) => setImmediate(r));
function lived(h, opts) {
  const proc = new EventEmitter();
  const created = [];
  registerOrchestrator(h, { dataDir: 'A:/store', proc, stampOpts: { every: 3600000 }, onCreated: (c) => created.push(c), ...opts });
  return { proc, created };
}

test('the lower bound is the time taken before the spawn call, not the registration', () => withRegistry(async (dir) => {
  const pid = 7321;
  const before = Date.now() - 5000; // the spawner's reading, long before a slow registration
  const { proc, created } = lived({ pid, exited: () => null, spawnStartedAt: before }, { createdOf: async () => ({ created: before + 3000 }), schedule: [0] });
  await tick(); await tick();
  assert.deepStrictEqual(created, [before + 3000], 'a creation 2 s before the registration is the true one');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, `${pid}.json`), 'utf8')).created, before + 3000);
  proc.emit('exit');
}));

test('no reading is asked for once the child has exited, and the last failed reading is said once', () => withRegistry(async () => {
  let asked = 0;
  const gone = lived({ pid: 7322, exited: () => ({ ended_by: 'exit' }) }, { createdOf: async () => { asked += 1; return null; }, schedule: [0, 10] });
  await tick(); await tick();
  assert.strictEqual(asked, 0, 'no snapshot is paid for a child that has exited');
  gone.proc.emit('exit');
  const logs = []; const timers = [];
  const realSet = global.setTimeout;
  global.setTimeout = (fn) => { timers.push(fn); return { unref() {} }; };
  try {
    const { proc } = lived({ pid: 7323, exited: () => null }, { createdOf: async () => null, schedule: [0, 10, 20], log: (m) => logs.push(m) });
    await tick(); await tick();
    timers.shift()(); await tick(); await tick();
    assert.strictEqual(logs.length, 0, 'still trying');
    timers.shift()(); await tick(); await tick();
    assert.strictEqual(logs.length, 1, 'said once when the last reading failed');
    assert.match(logs[0], /pid 7323.*pid-only/);
    assert.strictEqual(timers.length, 0);
    proc.emit('exit');
  } finally { global.setTimeout = realSet; }
}));
