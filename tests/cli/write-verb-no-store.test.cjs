'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
// write-verb-no-store.test.cjs — a write verb that acts on a row already there (memory verify, report, resolve, promote, held settle,
// restore, worker rm) finds none in a data dir that has no store yet, and is refused before its election would create the store.
// The data dir is left exactly as it was: empty. Built CLI, mkdtemp sandbox, each child waited for.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', '..', 'src', 'cli', 'belay.cjs');
const env = { ...process.env };
delete env.BELAY_WORKER_ID;

test('a refused write verb on a data dir with no store creates nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostore-')).split(path.sep).join('/');
  const data = `${dir}/data`;
  fs.mkdirSync(data);
  try {
    for (const args of [
      ['memory', 'verify', 'nosuch', '--status', 'verified', '--receipt', 'test:ok'],
      ['memory', 'report', 'nosuch', '--reason', 'r'],
      ['memory', 'resolve', 'nosuch', 'new'],
      ['memory', 'promote', 'nosuch', '--approve'],
      ['memory', 'held', 'settle', 'nosuch', '--archive', '--reason', 'r'],
      ['memory', 'restore', 'nosuch', '--reason', 'r'],
      ['worker', 'rm', 'nosuch'],
    ]) {
      const r = spawnSync(process.execPath, [CLI, ...args, '--data', data], { cwd: dir, env, encoding: 'utf8', timeout: 60000 });
      assert.strictEqual(r.status, 1, `${args.join(' ')}: exit ${r.status} ${r.stderr}`);
      assert.match(r.stderr, /no store at .*memory\.db/, args.join(' '));
      assert.deepStrictEqual(fs.readdirSync(data), [], `${args.join(' ')} left ${fs.readdirSync(data).join(', ')}`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
