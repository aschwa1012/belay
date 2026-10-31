'use strict';
// A command that times out while the tree kill is refused: runCommand drops its ends of the pipes rather than holding them.
// The kill is stubbed (the seam is PROC.killTree, read at call time); the child is stopped by its own handle.

const { test } = require('node:test');
const assert = require('node:assert');
const PROC = require('../../src/core/process.cjs');
const { core } = require('./helpers.cjs');
const { runCommand } = core('evaluate.cjs');

test('a timeout whose tree kill is refused destroys the child pipes', async (t) => {
  const real = PROC.killTree;
  let child = null;
  PROC.killTree = async (c) => { return { ok: false, error: 'refused (test)' }; };
  t.after(() => { PROC.killTree = real; });
  const done = runCommand([process.execPath, '-e', 'setTimeout(() => {}, 120000)'], undefined, 200, { onChild: (c) => { child = c; } });
  // the stub has answered once both streams are destroyed; wait on that event, then stop the child by its handle
  await new Promise((resolve) => { const i = setInterval(() => { if (child && child.stdout.destroyed && child.stderr.destroyed) { clearInterval(i); resolve(); } }, 20); t.after(() => clearInterval(i)); });
  assert.strictEqual(child.stdout.destroyed, true);
  assert.strictEqual(child.stderr.destroyed, true);
  child.kill();
  const r = await done;
  assert.strictEqual(r.timed_out, true);
});
