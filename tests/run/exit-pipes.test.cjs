'use strict';
// A worker that exits while a descendant still holds its inherited stdout and stderr: settle() must drop the adapter's ends of
// those pipes (destroyed === true), not keep them for the life of the adapter. The 2,000 ms close bound is advanced by the mock
// clock, so nothing here waits on wall time. The descendant is never signalled: it lives only while a flag file exists, and the
// test removes the file.
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const W = require('../../src/run/worker.cjs');
const EX = require('../../src/run/exit.cjs');

test('settle drops the pipes of an exited worker whose descendant still holds them', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-exit-pipes-'));
  const flag = path.join(dir, 'alive');
  fs.writeFileSync(flag, '');
  const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'leak-parent.cjs'), flag, 'exit'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', () => {}); // flowing, as the adapter's reader is
  child.stderr.on('data', () => {});
  const bound = () => ({ signal: AbortSignal.timeout(20000) });
  try {
    await once(child, 'exit', bound());
    assert.strictEqual(child.stdout.destroyed, false, 'precondition: the descendant keeps the pipe open, so no close yet');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const w = W.newWorkerRecord({ id: 'w-leak', substrate: 'claude-code', worktree: 'C:/x', dataDir: 'C:/x', captureBase: false });
    w.child = child;
    w.pid = child.pid;
    EX.settle(w, 0, null, 'exit', { writeRow: async () => null });
    t.mock.timers.tick(EX.EXIT_CLOSE_BOUND_MS);
    // the drop runs one setImmediate after the bound, so a read already pending is taken first; wait on the real close events
    await Promise.all([once(child.stdout, 'close', bound()), once(child.stderr, 'close', bound())]);
    assert.strictEqual(child.stdout.destroyed, true, 'stdout dropped');
    assert.strictEqual(child.stderr.destroyed, true, 'stderr dropped');
    assert.strictEqual(child.stdin.destroyed, true, 'stdin dropped');
  } finally {
    t.mock.timers.reset();
    fs.rmSync(flag, { force: true }); // the descendant exits on its own within 100 ms
    child.stdout.destroy(); child.stderr.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
