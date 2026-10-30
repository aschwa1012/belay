'use strict';
// status-in-flight.test.cjs — `belay status` shows a live worker's turn that has not ended as "in flight (estimate)", apart from the
// worker's reported cost, and the budget line labels the in-flight figure as counted or not. The built CLI in text mode over a store
// planted by a core that is shut down first (the copy path); the worker is a pid the test owns and kills by exact pid.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');

const P = require('../../src/run/process.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { ROOT, CLI, sandbox, cleanup } = require('./stop-helpers.cjs');

let dir, dataDir, liveProc;
const msg = (id) => JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: 0, output_tokens: 100000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });

before(async () => {
  dir = sandbox();
  dataDir = `${dir}/.belay`;
  liveProc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve) => liveProc.once('spawn', resolve));
  let c = null;
  try {
    c = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-fl', pid: process.pid } });
    await c.run.attach({ adapter_pid: liveProc.pid, budget_usd: 20 });
    fs.mkdirSync(`${dataDir}/workers/w1`, { recursive: true });
    fs.writeFileSync(`${dataDir}/workers/w1/stream.jsonl`, `${msg('m1')}\n${msg('m2')}\n`);
    await c.worker.write({ id: 'w1', substrate: 'claude-code', pid: liveProc.pid, pid_image: 'node.exe', state: 'running', turns: 1, mid_turn: 1, cost_usd: 0.25, started_at: Date.now() });
  } finally {
    if (c) { try { await c.shutdownOwner(); } catch { /* best effort */ } try { await c.close(); } catch { /* best effort */ } }
  }
});

after(() => {
  if (liveProc && P.pidAlive(liveProc.pid)) { try { require('../crash.cjs').crash(liveProc); } catch { /* best effort */ } }
  if (dir) cleanup(dir);
});

test('status text names the worker in-flight estimate apart from its reported cost, and the budget line says it is not counted', () => {
  const r = spawnSync(process.execPath, [CLI, 'status', 'run-fl', '--data', dataDir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${r.stdout} / ${r.stderr}`);
  assert.match(r.stdout, /^worker w1: \$2\.00 in flight \(estimate\), not in its reported cost \$0\.25$/m);
  assert.match(r.stdout, /^budget: .*of \$20\.00 reported.*\$2\.00 in flight \(estimate\), not counted/m);
  const j = JSON.parse(spawnSync(process.execPath, [CLI, 'status', 'run-fl', '--data', dataDir, '--json'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' }).stdout);
  assert.strictEqual(j.workers[0].cost_in_flight_usd, 2);
  assert.strictEqual(j.run.budget.in_flight.counted, false);
});
