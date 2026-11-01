'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// fix-flag.test.cjs — --fix belongs to belay doctor. Any other command refuses it as a usage error (exit 2)
// instead of ignoring it, and the help text states the data directory default as the code computes it.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { ROOT, CLI, sandbox, cleanup, listRecursive } = require('./stop-helpers.cjs');

const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });

test('status --fix is a usage error, writes nothing, and says what --fix is for', () => {
  const dir = sandbox();
  try {
    const before = listRecursive(dir);
    const r = cli(['status', '--fix', '--data', `${dir}/.belay`]);
    assert.strictEqual(r.status, 2, `${r.stdout} / ${r.stderr}`);
    assert.match(r.stderr, /belay status: --fix is an option of belay doctor only/);
    assert.match(r.stderr, /belay doctor --fix/);
    assert.deepStrictEqual(listRecursive(dir), before);
  } finally { cleanup(dir); }
});

test('help states the data directory default including the config file, and lists --fix', () => {
  const r = cli(['--help']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /else \.belay beside the config file/);
  assert.match(r.stdout, /--fix .*belay doctor only/);
});
