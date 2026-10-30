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
    dataDir: dir, proc,
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
