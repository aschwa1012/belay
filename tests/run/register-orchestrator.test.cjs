'use strict';
require('../helpers/tmp.cjs');
// register-orchestrator.test.cjs — the headless orchestrator's register record is stamped while the orchestrator lives (the fix for a
// run process that dies without its exit handler: the record then closes at the last stamp, not at the spawn). The timer and the process
// object are seams; the stamp lands in a real register directory and is read back from its file.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { registerOrchestrator } = require('../../src/run/register-orchestrator.cjs');
const SR = require('../../src/core/spawn-register.cjs');

function withRegistry(fn) {
  const keep = process.env.BELAY_SPAWN_REGISTRY;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-reg-orch-'));
  process.env.BELAY_SPAWN_REGISTRY = dir;
  try { return fn(dir); } finally { process.env.BELAY_SPAWN_REGISTRY = keep; fs.rmSync(dir, { recursive: true, force: true }); }
}

test('registerOrchestrator writes the record, stamps it while the hook says the child lives, and stops at the run process\'s exit', () => withRegistry((dir) => {
  const pid = 7301;
  const file = path.join(dir, `${pid}.json`);
  const seen = () => JSON.parse(fs.readFileSync(file, 'utf8')).seen_at;
  const proc = new EventEmitter();
  let tick = null; let cleared = 0; let exited = null;
  const clock = { t: 0 };
  const h = { pid, exited: () => exited };
  registerOrchestrator(h, {
    dataDir: dir, proc, createdOf: async () => null,
    stampOpts: { every: 30000, touch: (p) => SR.touch(p, clock.t), setTimer: (fn, ms) => { tick = fn; assert.strictEqual(ms, 30000); return 't'; }, clearTimer: () => { cleared += 1; } },
  });
  assert.ok(fs.existsSync(file), 'the record is written');
  assert.ok(tick, 'a stamp timer was started');
  const at = JSON.parse(fs.readFileSync(file, 'utf8')).at;
  clock.t = at + 3 * 3600000; tick();
  assert.strictEqual(seen(), at + 3 * 3600000, 'stamped hours in, with no row or event of any kind');
  exited = { ended_by: 'exit' }; clock.t = at + 4 * 3600000; tick();
  assert.strictEqual(seen(), at + 3 * 3600000, 'the hook says it exited: no further stamp');
  proc.emit('exit');
  assert.strictEqual(cleared, 1, 'the timer is cleared');
  assert.ok(!fs.existsSync(file), 'and the record is unregistered');
}));

test('no pid, no record and no timer; cmd-run hands the hook itself, not its pid, so the stamp can see the exit', () => withRegistry((dir) => {
  let started = false;
  assert.strictEqual(registerOrchestrator({ pid: null }, { dataDir: dir, stamp: () => { started = true; } }), null);
  assert.strictEqual(started, false);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  const src = fs.readFileSync(path.join(__dirname, '../../src/cli/cmd-run.cjs'), 'utf8');
  assert.match(src, /registerOrchestrator\(h\)/);
  assert.match(src, /register-orchestrator\.cjs/);
}));

test('a hook without exited() is refused loudly, and nothing is registered', () => withRegistry((dir) => {
  assert.throws(() => registerOrchestrator({ pid: 7302 }, { dataDir: dir, proc: new EventEmitter() }), /no exited\(\) function/);
  assert.throws(() => registerOrchestrator({ pid: 7302, exit: () => null }, { dataDir: dir, proc: new EventEmitter() }), /no exited\(\) function/, 'a renamed key');
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'no record that nothing would stamp');
}));

// The record is written with no creation time; the orchestrator's is read once the snapshot has it, so a process that reuses the pid
// inside an intact chain is not taken for it (a record with no creation time matches by pid alone).
async function withRegistryAsync(fn) {
  const keep = process.env.BELAY_SPAWN_REGISTRY;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-reg-orch-'));
  process.env.BELAY_SPAWN_REGISTRY = dir;
  try { return await fn(dir); } finally { process.env.BELAY_SPAWN_REGISTRY = keep; fs.rmSync(dir, { recursive: true, force: true }); }
}
function lived(h, opts) {
  const proc = new EventEmitter();
  const created = [];
  registerOrchestrator(h, { dataDir: 'A:/store', proc, stampOpts: { every: 3600000 }, onCreated: (c) => created.push(c), ...opts });
  return { proc, created };
}
const tick = () => new Promise((r) => setImmediate(r));

test('registerOrchestrator fills the creation time on the record and tells the run, once the reading lands', () => withRegistryAsync(async (dir) => {
  const pid = 7311;
  const file = path.join(dir, `${pid}.json`);
  const { proc, created } = lived({ pid, exited: () => null }, { createdOf: async () => ({ created: Date.now() + 5 }), schedule: [0] });
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).created, null, 'written at once, without it');
  await tick(); await tick();
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Number.isFinite(rec.created), 'the record now carries the creation time');
  assert.deepStrictEqual(created, [rec.created]);
  assert.strictEqual(rec.kind, 'orchestrator');
  proc.emit('exit');
}));

test('registerOrchestrator takes no reading from before the spawn or after the child exited, and retries a missing one', () => withRegistryAsync(async (dir) => {
  const pid = 7312;
  const file = path.join(dir, `${pid}.json`);
  let calls = 0;
  const answers = [null, { created: 5 }, { created: Date.now() + 5 }]; // missing; a process older than the spawn; the right one
  const timers = [];
  const realSet = global.setTimeout;
  global.setTimeout = (fn) => { timers.push(fn); return { unref() {} }; };
  try {
    const { proc, created } = lived({ pid, exited: () => null }, { createdOf: async () => answers[calls++], schedule: [0, 10, 20] });
    await tick(); await tick();
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).created, null);
    timers.shift()(); await tick(); await tick();
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).created, null, 'a reading older than the spawn is refused');
    timers.shift()(); await tick(); await tick();
    assert.strictEqual(created.length, 1, 'the third reading is taken');
    proc.emit('exit');
  } finally { global.setTimeout = realSet; }
  let exited = null; const pid2 = 7313;
  const late = lived({ pid: pid2, exited: () => exited }, { createdOf: async () => { exited = { ended_by: 'exit' }; return { created: Date.now() + 5 }; }, schedule: [0] });
  await tick(); await tick();
  assert.deepStrictEqual(late.created, [], 'the child had exited: its pid may belong to another process now');
  late.proc.emit('exit');
}));
