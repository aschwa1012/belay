'use strict';
// check-flake-show.test.cjs -- item J: `belay status` and `belay receipts` show the checks that flipped on one tree, as facts (counts,
// last outcome, overlap), and show nothing when no key has flipped. Rows are planted through check-flake.record on a stopped store;
// the commands are driven as subprocesses.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { openCore } = require('../../src/core/index.cjs');
const { Store } = require('../../src/core/store.cjs');
const F = require('../../src/core/check-flake.cjs');
const { ROOT, CLI, sandbox, cleanup } = require('./stop-helpers.cjs');

const chk = (passed, concurrent) => ({ kind: 'command', argv: ['node', '--test'], executable: true, passed, ...(concurrent ? { concurrent: [{ task_id: 'x', overlap_ms: 3 }] } : {}), detail: { cwd: '/w' } });

async function plant(dataDir, flip) {
  const orch = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-f', pid: process.pid } });
  try { await orch.run.attach({ adapter_pid: process.pid }); } finally { await orch.shutdownOwner(); await orch.close(); }
  const s = new Store(path.join(dataDir, 'memory.db'), { stamp: true });
  try {
    F.record(s, [chk(true)], { tree_sha: 'abcdef0123456789' }, 1);
    if (flip) F.record(s, [chk(false, true)], { tree_sha: 'abcdef0123456789' }, 2);
  } finally { s.close(); }
}
const cli = (dataDir, ...a) => spawnSync(process.execPath, [CLI, ...a, '--data', dataDir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });

test('a flipped key shows in status and in receipts, with the overlap beside the counts', async () => {
  const dir = sandbox(), dataDir = `${dir}/.belay`;
  try {
    await plant(dataDir, true);
    const st = cli(dataDir, 'status', '--json');
    const k = JSON.parse(st.stdout).check_flake;
    assert.deepStrictEqual([k.length, k[0].pass_n, k[0].fail_n, k[0].flips, k[0].last_concurrent], [1, 1, 1, 1, true]);
    assert.match(cli(dataDir, 'status').stdout, /flaky check: node --test {2}on tree abcdef012345: 1 pass, 1 fail, 1 flip, last fail \(overlapped another evaluation\)/);
    const rc = cli(dataDir, 'receipts', 'run-f', '--json');
    assert.strictEqual(JSON.parse(rc.stdout).flaky_checks[0].flips, 1);
    assert.match(cli(dataDir, 'receipts', 'run-f').stdout, /flaky check: node --test/);
  } finally { cleanup(dir); }
});

test('a key that never flipped is not shown', async () => {
  const dir = sandbox(), dataDir = `${dir}/.belay`;
  try {
    await plant(dataDir, false);
    assert.strictEqual(JSON.parse(cli(dataDir, 'status', '--json').stdout).check_flake, undefined);
    assert.doesNotMatch(cli(dataDir, 'status').stdout, /flaky check/);
    assert.deepStrictEqual(JSON.parse(cli(dataDir, 'receipts', 'run-f', '--json').stdout).flaky_checks, []);
  } finally { cleanup(dir); }
});
