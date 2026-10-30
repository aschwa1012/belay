'use strict';
// read-one-copy.test.cjs — a read command with no live owner reads a copy of the store. `agents`, `diff` and `memory proposals` make
// several core reads; each is one readBatch, so the command copies the store once, not once per read. Built CLI as a child with a
// --require hook that counts the copies (tests/cli/fakes/count-copies.cjs); the store is planted in a sandbox and its owner shut down.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sandbox, cleanup } = require('./stop-helpers.cjs');
const { openCore } = require('../../src/core/index.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const HOOK = `${ROOT}/tests/cli/fakes/count-copies.cjs`;

test('agents, diff and memory proposals copy the store once each', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    const plant = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-a', pid: process.pid } });
    try {
      await plant.run.attach({ adapter_pid: process.pid });
      await plant.worker.write({ id: 'w1', substrate: 'claude-code', state: 'stopped', turns: 1, started_at: Date.now() });
      await plant.task.create({ spec: 'do it' });
    } finally { await plant.shutdownOwner(); await plant.close(); }
    const env = { ...process.env, COPY_COUNT_FILE: `${dir}/count.txt` };
    delete env.BELAY_WORKER_ID;
    for (const args of [['agents', 'run-a'], ['diff', 'run-a'], ['memory', 'proposals']]) {
      fs.rmSync(`${dir}/count.txt`, { force: true });
      const r = spawnSync(process.execPath, ['--require', HOOK, CLI, ...args, '--data', dataDir, '--json'], { cwd: dir, env, encoding: 'utf8', timeout: 60000 });
      assert.strictEqual(r.status, 0, `${args.join(' ')}: ${r.stderr.slice(0, 300)}`);
      assert.strictEqual(fs.readFileSync(`${dir}/count.txt`, 'utf8'), '1', `${args.join(' ')} copied the store more than once`);
    }
  } finally { cleanup(dir); }
});
