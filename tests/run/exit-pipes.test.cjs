'use strict';
// A worker that exits while a descendant still holds its inherited stdout and stderr: settle() must drop the adapter's ends of
// those pipes (destroyed === true), not keep them for the life of the adapter. The 2,000 ms close bound is advanced by the mock
// clock, so nothing here waits on wall time. The descendant is stopped by its exact pid.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');
const W = require('../../src/run/worker.cjs');
const EX = require('../../src/run/exit.cjs');

test('settle drops the pipes of an exited worker whose descendant still holds them', async (t) => {
  const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'leak-parent.cjs')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let gcPid = null;
  try {
    let seen = '';
    await new Promise((resolve) => child.stdout.on('data', (d) => { seen += d; if (/gc (\d+)\n/.test(seen)) resolve(); }));
    gcPid = Number(/gc (\d+)/.exec(seen)[1]);
    await new Promise((resolve) => child.once('exit', resolve));
    assert.strictEqual(child.stdout.destroyed, false, 'precondition: the descendant keeps the pipe open, so no close yet');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const w = W.newWorkerRecord({ id: 'w-leak', substrate: 'claude-code', worktree: 'C:/x', dataDir: 'C:/x', captureBase: false });
    w.child = child;
    w.pid = child.pid;
    EX.settle(w, 0, null, 'exit', { writeRow: async () => null });
    t.mock.timers.tick(EX.EXIT_CLOSE_BOUND_MS);
    assert.strictEqual(child.stdout.destroyed, true, 'stdout dropped');
    assert.strictEqual(child.stderr.destroyed, true, 'stderr dropped');
    assert.strictEqual(child.stdin.destroyed, true, 'stdin dropped');
  } finally {
    t.mock.timers.reset();
    if (gcPid) { try { process.kill(gcPid); } catch { /* already gone */ } }
    child.stdout.destroy(); child.stderr.destroy();
  }
});
