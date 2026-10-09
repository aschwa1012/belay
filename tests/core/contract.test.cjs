'use strict';
// contract.test.cjs — two properties the row shapes cannot show on their own: that `task.assign` decides
// and writes inside one transaction, and that a timed-out acceptance command dies as a tree rather than
// as one process. Both are about what happens between two moments, so both are measured, not inspected.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor, FIXTURES, sleep, startOwnerProcess, stopOwnerProcesses } = require('./helpers.cjs');

const { openCore, pidAlive } = core('index.cjs');
const { Engine } = core('engine.cjs');
const { Store } = core('store.cjs');
const { withCopy } = core('copy-read.cjs');

// A real store that also records, for every statement it runs, whether a transaction was open at the
// time. Nothing is stubbed: every call reaches the real database and the rows written are real rows, so
// a test can assert where a read happened without changing what it read.
function recordingStore(dbPath) {
  const real = new Store(dbPath);
  let depth = 0;
  const seen = [];
  return {
    seen,
    get db() { return real.db; },
    get dbPath() { return real.dbPath; },
    p(sql) {
      const stmt = real.p(sql);
      const note = () => seen.push({ sql, in_tx: depth > 0 });
      return {
        run: (...a) => { note(); return stmt.run(...a); },
        get: (...a) => { note(); return stmt.get(...a); },
        all: (...a) => { note(); return stmt.all(...a); },
      };
    },
    tx(fn) { depth++; try { return real.tx(fn); } finally { depth--; } },
    close: () => real.close(),
  };
}

const TOUCHES = /\b(?:FROM|INTO)\s+(?:task|lease|worker)\b/i;

test('task.assign does every read that authorises it inside the transaction that writes', async () => {
  const dir = sandbox();
  const store = recordingStore(path.join(dir, 'memory.db'));
  try {
    const E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
    const caller = callerFor('orchestrator');
    await E.handle('worker.write', { caller, id: 'w1', substrate: 'claude-code', pid: process.pid, state: 'running' });
    const t = await E.handle('task.create', { caller, spec: 'assigned inside one transaction' });

    store.seen.length = 0;
    const a = await E.handle('task.assign', { caller, task_id: t.id, worker_id: 'w1' });
    assert.strictEqual(a.task.state, 'assigned');
    assert.strictEqual(a.new_lease.holder, 'w1');

    // The task row, the current lease and the worker row are what the grant rests on; the lease row and
    // the task row are what it writes. If any of those five sits outside the transaction, the state the
    // refusal was computed against is not the state the grant was committed against.
    const touched = store.seen.filter(s => TOUCHES.test(s.sql));
    assert.ok(touched.length >= 5, `assign must read the task, its lease and the worker and write two rows; saw ${touched.length}`);
    assert.deepStrictEqual(touched.filter(s => !s.in_tx), [],
      'every read and write of task.assign belongs to one transaction, so the check and the write cannot be separated');
  } finally { store.close(); cleanup(dir); }
});

test('a refused assign commits nothing at all', async () => {
  const dir = sandbox();
  const store = recordingStore(path.join(dir, 'memory.db'));
  try {
    const E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
    const caller = callerFor('orchestrator');
    await E.handle('worker.write', { caller, id: 'w-gone', substrate: 'codex', pid: process.pid, state: 'stopped' });
    const t = await E.handle('task.create', { caller, spec: 'never assigned' });

    await assert.rejects(E.handle('task.assign', { caller, task_id: t.id, worker_id: 'w-gone' }), e => {
      assert.strictEqual(e.code, 'E_WORKER_NOT_LIVE');
      return true;
    });
    const after = await E.handle('task.get', { caller, task_id: t.id });
    assert.strictEqual(after.state, 'open', 'a refusal leaves the task where it was');
    assert.strictEqual(after.lease, null, 'a refusal grants no lease');
    assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM lease').get().n, 0);
  } finally { store.close(); cleanup(dir); }
});

test('a timed-out acceptance command takes its grandchildren with it', async () => {
  const dir = sandbox();
  const orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  let gpid = 0;
  try {
    const pidFile = path.join(dir, 'grandchild.pid');
    const t = await orch.task.create({
      spec: 'a command that is a tree, not a process',
      acceptance: { commands: [{ argv: [process.execPath, path.join(FIXTURES, 'spawns-a-child.cjs'), pidFile], timeout_ms: 1000 }] },
    });
    const r = await orch.task.evaluate({ task_id: t.id, worktree: dir });
    const check = r.results.checks[0];
    assert.strictEqual(check.detail.timed_out, true, 'the command must actually have hit its deadline');
    assert.strictEqual(check.passed, false);
    assert.notStrictEqual(r.state, 'done');
    if (process.platform === 'win32') {
      // The receipt is the point. A grandchild also dies with its parent through this host's ambient
      // job binding (ADR 0011 §1), so its absence alone would not prove belay killed it; what proves it
      // is that taskkill walked the tree and said so. Issued after process.kill it answers
      // "ERROR: The process not found", exit 128, and terminates nothing.
      const tk = check.detail.tree_kill;
      assert.ok(tk, 'the check must carry a receipt for the kill it performed');
      assert.strictEqual(tk.tool, 'process.kill'); // ADR 0039: the snapshot tree kill, no taskkill /T
      assert.deepStrictEqual(tk.identity, { via: 'handle' });
      assert.strictEqual(tk.ok, true, `the tree kill reported ${JSON.stringify(tk)}`);
      assert.strictEqual(tk.exit_code, 0);
      assert.ok(tk.terminated >= 2, `the tree kill must reach past the direct child, and it named ${tk.terminated} process(es): ${tk.output}`);
    }

    gpid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.ok(gpid > 0, 'the fixture must have recorded the pid of the child it spawned');
    let alive = pidAlive(gpid);
    for (let i = 0; i < 30 && alive; i++) { await sleep(100); alive = pidAlive(gpid); }
    assert.strictEqual(alive, false, `the grandchild (pid ${gpid}) outlived the command that spawned it`);
    gpid = 0;
  } finally {
    if (gpid) { try { process.kill(gpid); } catch { /* already gone */ } }
    await orch.shutdownOwner();
    await orch.close();
    cleanup(dir);
  }
});

test('copy-then-read survives an owner that has the -shm file mapped', async (t) => {
  const dir = sandbox();
  t.after(async () => { await stopOwnerProcesses(dir); cleanup(dir); });
  const owner = await startOwnerProcess(dir);
  assert.ok(owner.info.pid);

  const c = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await c.run.attach({ adapter_pid: process.pid });
  await c.memory.store({ namespace: 'busy', text: 'written while an owner holds the mapping', embedding: [1, 0], embedding_model: 'm', dim: 2 });

  // A live owner holds -shm as a memory mapping, and on Windows copying a mapped file fails EBUSY often
  // enough to have made this intermittent rather than absent. A read must answer or raise a Core error;
  // throwing a filesystem errno out of the read path is neither. Repeated, because it is a race.
  for (let i = 0; i < 25; i++) {
    const rows = await withCopy(dir, async (dbPath, establishedBy) => {
      assert.strictEqual(establishedBy, 'copy');
      const store = new Store(dbPath);
      try { return store.list({ namespace: 'busy' }); } finally { store.close(); }
    });
    assert.strictEqual(rows.length, 1, `copy ${i} lost the row the owner had committed`);
    assert.strictEqual(rows[0].text, 'written while an owner holds the mapping');
  }
  await c.close();
});
