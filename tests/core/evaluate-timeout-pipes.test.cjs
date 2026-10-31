'use strict';
// A command that times out while a process outside the killed tree holds its pipes. The tree kill is stubbed (the seam is
// PROC.killTree, read at call time): it stops the direct child by its handle and reports ok, as a real kill does when the
// holder was reparented away from the tree. runCommand must still resolve, with its ends of the pipes dropped. The holder lives
// only while a flag file exists and is never signalled.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PROC = require('../../src/core/process.cjs');
const { core } = require('./helpers.cjs');
const { runCommand } = core('evaluate.cjs');

const FIXTURE = path.join(__dirname, '..', 'run', 'fixtures', 'leak-parent.cjs');

for (const kill of [{ ok: true }, { ok: false, error: 'refused (test)' }]) {
  test(`a timeout whose tree kill reports ok=${kill.ok} still resolves and drops the pipes of a holder outside the tree`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-eval-pipes-'));
    const flag = path.join(dir, 'alive');
    fs.writeFileSync(flag, '');
    const real = PROC.killTree;
    let child = null, up = null;
    PROC.killTree = async (c) => { await up; c.kill(); return kill; }; // by handle; waits until the holder exists
    t.after(() => { PROC.killTree = real; fs.rmSync(flag, { force: true }); fs.rmSync(dir, { recursive: true, force: true }); });
    const r = await runCommand([process.execPath, FIXTURE, flag, 'hold'], undefined, 100, {
      onChild: (c) => { child = c; up = new Promise((res) => c.stdout.on('data', (d) => { if (String(d).includes('up')) res(); })); },
    });
    assert.strictEqual(r.timed_out, true);
    assert.strictEqual(child.stdout.destroyed, true, 'stdout dropped');
    assert.strictEqual(child.stderr.destroyed, true, 'stderr dropped');
  });
}
