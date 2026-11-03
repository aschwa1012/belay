'use strict';
// run-end-pid-reuse.test.cjs — run.end decides a worker row's death before its bounded git call and re-reads the row after it.
// A pid that answers again by then is the row's process only if a snapshot says so (ADR 0039): Windows hands a freed pid out
// within seconds, so another process can take a dead worker's pid while git runs, and judged by the pid alone the row stayed
// `running` for good. The seam: the pid check answers for the row's pid once the git call has started, as it does when another
// process took the number meanwhile. It is installed before the core is loaded, because the modules under test bind both
// functions when they load.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const L = require('../../src/core/lock.cjs');
const EV = require('../../src/core/evaluate.cjs');
for (const m of ['run-close-rows.cjs', 'live-as.cjs']) {
  assert.ok(!Object.keys(require.cache).some((k) => k.endsWith(m)), `${m} was loaded before the seam was installed`);
}
// worktree -> pid: once git runs in that worktree, the pid answers; before, it does not (the row's process was gone when run.end looked).
const reusedIn = new Map();
const answering = new Set();
const realPidAlive = L.pidAlive;
L.pidAlive = (pid) => {
  const n = Number(pid);
  if (answering.has(n)) return true;
  if ([...reusedIn.values()].includes(n)) return false;
  return realPidAlive(pid);
};
const realRunCommand = EV.runCommand;
EV.runCommand = (argv, cwd, ...rest) => { if (reusedIn.has(cwd)) answering.add(reusedIn.get(cwd)); return realRunCommand(argv, cwd, ...rest); };

const { core, sandbox, cleanup, callerFor, deadPid, ownSpawnRegistry } = require('./helpers.cjs');
const { openCore } = core('index.cjs');

const plainDir = () => String(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-close-plain-'))).replace(/\\/g, '/');

test('run.end closes a row whose pid another process took during its git call, and leaves one whose pid came back as recorded', async () => {
  const reg = ownSpawnRegistry();
  const dir = sandbox();
  const orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  const dirs = [plainDir(), plainDir()];
  try {
    await orch.run.attach({ adapter_pid: process.pid });
    const mine = await require('../../src/core/proc-identity.cjs').createdOf(process.pid, { kind: 'test' });
    assert.ok(mine && Number.isFinite(mine.created), "this process's creation time is readable");
    const gone = deadPid(); // no process holds it: a snapshot taken after git finds nothing there
    const t = Date.now() - 60000;
    await orch.worker.write({ id: 'w-taken', substrate: 'claude-code', pid: gone, pid_created: t, pid_image: 'node.exe', state: 'starting', worktree: dirs[0], started_at: t });
    // A pid that answers after git as the very process the row recorded: the snapshot proves it, so the row is left as it is.
    await orch.worker.write({ id: 'w-back', substrate: 'claude-code', pid: process.pid, pid_created: mine.created, state: 'running', worktree: dirs[1], started_at: t });
    reusedIn.set(dirs[0], gone); reusedIn.set(dirs[1], process.pid); // from here, neither pid answers until git runs in its worktree
    const ended = await orch.run.end({ exit_reason: 'test end' });
    assert.deepStrictEqual([...answering].sort(), [gone, process.pid].sort(), 'run.end did not run its git call in both worktrees');
    assert.deepStrictEqual(ended.workers_marked_dead.map((m) => m.worker_id), ['w-taken'], JSON.stringify(ended.workers_marked_dead));
    const taken = await orch.worker.get({ worker_id: 'w-taken' });
    assert.strictEqual(taken.state, 'dead', 'a pid another process took during the git call kept the row claiming a life');
    assert.strictEqual((await orch.worker.get({ worker_id: 'w-back' })).state, 'running', 'a pid the snapshot after git proves to be the recorded process was closed');
  } finally {
    reusedIn.clear(); answering.clear();
    await orch.shutdownOwner();
    await orch.close();
    cleanup(dir);
    for (const d of dirs) cleanup(d);
    reg.remove();
  }
});
