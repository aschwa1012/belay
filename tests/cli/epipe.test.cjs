'use strict';
require('../helpers/tmp.cjs');
// epipe.test.cjs — a reader that closes the CLI's stdout before it writes (`belay help | head`) must not crash it with an unhandled
// EPIPE: no stack trace on stderr, and the command's own exit code. The read end is destroyed right after the spawn, before the
// child has loaded, so the child's first write meets a closed pipe without any wait.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', '..', 'src', 'cli', 'belay.cjs');

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => { err += d; });
    child.stdout.destroy();
    child.on('error', reject);
    child.on('close', code => resolve({ code, err }));
  });
}

test('help with stdout closed early exits 0 with nothing on stderr', async () => {
  const r = await run(['help']);
  assert.strictEqual(r.err, '');
  assert.strictEqual(r.code, 0);
});

test('a usage error with stderr unread keeps its exit code and prints no stack', async () => {
  const r = await run(['no-such-command']);
  assert.doesNotMatch(r.err, /EPIPE|at .*\(.*\.cjs/);
  assert.notStrictEqual(r.code, 0);
});
