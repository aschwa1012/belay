'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// unknown-run.test.cjs — workers, tasks, diff and usage refuse a run id with no run row, as receipts does
// (exit 1, the fact and the next step), instead of answering an empty result with exit 0. The built CLI is
// spawned on an empty sandbox with no store; the data dir listing is compared before and after.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { ROOT, CLI, sandbox, cleanup, listRecursive } = require('./stop-helpers.cjs');

for (const cmd of ['workers', 'tasks', 'diff', 'usage', 'receipts']) {
  test(`${cmd}: an unknown run id is refused with exit 1 and a next step`, () => {
    const dir = sandbox();
    const dataDir = `${dir}/.belay`;
    try {
      const before = listRecursive(dir);
      const r = spawnSync(process.execPath, [CLI, cmd, 'no-such-run', '--data', dataDir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
      assert.strictEqual(r.status, 1, `${r.stdout} / ${r.stderr}`);
      assert.match(r.stdout + r.stderr, new RegExp(`belay ${cmd}: no run row exists for no-such-run`));
      if (cmd !== 'receipts') assert.match(r.stdout + r.stderr, /belay status/, 'names the next step');
      assert.deepStrictEqual(listRecursive(dir), before, 'reading never writes');
    } finally { cleanup(dir); }
  });
}
