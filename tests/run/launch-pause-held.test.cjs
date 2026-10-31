'use strict';
// launch-pause-held.test.cjs — a run pause that lands while a spawn or a restart is still starting. The run pause lists rows by live pid,
// so it cannot park such a worker itself; the adapter holds the pause for the launch, and the launch answers it: refused at its last
// pre-launch check (no process, E_PAUSED), or parked once it is up and named in this pause's parks. Every seam is a deferred on a core
// call (no sleeps for correctness). Also here: a stop that overtakes a spawn (the receipt says the launch was abandoned; a failed
// preface leaves the stopped row) and a restart refused after its old process stopped (the error says so).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { createRunPauseControl } = require('../../src/run/run-pause.cjs');
const P = require('../../src/run/process.cjs');
const { cleanup } = require('../core/helpers.cjs');
const { createFakeCore, FakeCoreError } = require('./fake-core.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const fwd = (p) => p.replace(/\\/g, '/');
const CALLER = { role: 'operator', pid: 1 };

// A run manager and the real run pause control over a fake core that keeps a run row, as the owner does.
function rig() {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-launch-pause-'));
  const data = fwd(path.join(sb, 'data'));
  const worktree = fwd(path.join(sb, 'wt'));
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  const core = createFakeCore();
  const runRow = { id: 'run-fake', paused_at: null, paused_by: null, pause_parks: null };
  core.caller = { role: 'orchestrator', run_id: 'run-fake' };
  core.run = {
    assertNotPaused: async () => { if (runRow.paused_at != null) throw new FakeCoreError('E_PAUSED', `run run-fake is paused (${runRow.paused_by}), and a paused run starts no new work`, { run_id: 'run-fake', paused_by: runRow.paused_by }); return { paused: false }; },
    get: async () => ({ run: { ...runRow } }),
    setPaused: async ({ paused, at, by, parks }) => { runRow.paused_at = paused ? at : null; runRow.paused_by = by; if (parks) runRow.pause_parks = parks; return { run: { ...runRow } }; },
  };
  const list = core.worker.list;
  core.worker.list = async () => { const r = await list(); return { workers: r.workers.map((x) => ({ ...x, pid_alive: x.pid ? P.pidAlive(x.pid) : false })) }; };
  const m = createRunManager({ core, dataDir: data, runId: 'run-fake', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  let held = false;
  const hook = { pause: async () => { held = true; return { interrupt: null, timeout: null }; }, isPaused: () => held, exited: () => false, finishing: () => false };
  const pauseWorker = async (id) => { try { const r = await m.pause({ worker_id: id, by: 'operator:1' }); return { success: true, ...r }; } catch (e) { return { success: false, error: { code: e.code, message: e.message, detail: e.detail } }; } };
  const rp = createRunPauseControl({ runId: 'run-fake', core, hook, pauseWorker, resumeWorker: async () => ({ success: true }) });
  return { sb, data, worktree, core, runRow, m, rp, done: async () => { await m.shutdown(); cleanup(sb); } };
}

// Start a run pause now and return its promise once the worker holds it (the real event: `pauseOnLaunch` appears on the record).
async function pauseWhenHeld(r, id) {
  const pending = r.rp.pause({ run_id: 'run-fake', caller: CALLER });
  let settled = false; pending.then(() => { settled = true; }, () => { settled = true; });
  while (!(r.m._worker(id) && r.m._worker(id).pauseOnLaunch) && !settled) await new Promise((res) => setImmediate(res));
  assert.ok(r.m._worker(id).pauseOnLaunch, 'the worker holds the pause for its launch');
  return { pending };
}

const stateOf = (r, id) => r.core.currentWorker(id).state;
const parkedIds = (r) => ((r.runRow.pause_parks && r.runRow.pause_parks.parked) || []).map((p) => p.worker_id || p);

for (const mode of ['before', 'after']) {
  test(`a run pause landing ${mode} the spawn's pid row: the worker is parked once up and named in this pause's parks`, async () => {
    const r = rig();
    let pausePromise = null; let seen = false;
    const write = r.core.worker.write;
    try {
      // `before`: the pause starts inside the pid row's write; it cannot finish until the spawn does, so it is not awaited there.
      if (mode === 'before') {
        r.core.worker.write = async (row) => {
          if (!seen && row.state === 'starting' && row.pid) { seen = true; pausePromise = r.rp.pause({ run_id: 'run-fake', caller: CALLER }); while (!(r.m._worker('w1') && r.m._worker('w1').pauseOnLaunch)) await new Promise((res) => setImmediate(res)); }
          return write(row);
        };
      } else {
        r.core.worker.write = async (row) => {
          const out = await write(row);
          if (!seen && row.state === 'starting' && row.pid) { seen = true; pausePromise = r.rp.pause({ run_id: 'run-fake', caller: CALLER }); while (!(r.m._worker('w1') && r.m._worker('w1').pauseOnLaunch)) await new Promise((res) => setImmediate(res)); }
          return out;
        };
      }
      const res = await r.m.spawn({ substrate: 'claude-code', worktree: r.worktree, prompt: 'go', worker_id: 'w1' });
      const receipt = await pausePromise;
      assert.ok(res.parked_by_run_pause, 'the spawn reports that the run pause parked it');
      assert.deepStrictEqual(receipt.workers.map((x) => x.worker_id), ['w1'], 'the pause names the worker as paused');
      assert.deepStrictEqual(receipt.not_paused, []);
      assert.ok(parkedIds(r).includes('w1'), `in pause_parks.parked: ${JSON.stringify(r.runRow.pause_parks)}`);
      assert.strictEqual(stateOf(r, 'w1'), 'paused');
      assert.ok(!P.pidAlive(r.m._worker('w1').pid), 'the parked worker has no process');
    } finally { await r.done(); }
  });
}

test('a run pause landing before the last pre-launch check: the spawn is refused, no process starts, the pause names it refused', async () => {
  const r = rig();
  let release; const gate = new Promise((res) => { release = res; });
  let entered; const stalled = new Promise((res) => { entered = res; });
  const write = r.core.worker.write; let first = true;
  r.core.worker.write = async (row) => { const out = await write(row); if (first && row.state === 'starting' && row.pid == null) { first = false; entered(); await gate; } return out; }; // the pidless row is listable
  try {
    const sp = r.m.spawn({ substrate: 'claude-code', worktree: r.worktree, prompt: 'go', worker_id: 'w1' }).then((x) => ({ ok: x }), (e) => ({ err: e }));
    await stalled;
    const { pending: pausePromise } = await pauseWhenHeld(r, 'w1');
    release();
    const out = await sp;
    const receipt = await pausePromise;
    assert.ok(out.err && out.err.code === 'E_PAUSED', `${out.err && out.err.code}`);
    assert.strictEqual(r.core.rowsFor('w1').filter((x) => x.pid).length, 0, 'no row ever carried a pid');
    assert.deepStrictEqual(receipt.workers, []);
    const np = receipt.not_paused.find((x) => x.worker_id === 'w1');
    assert.ok(np && np.error.code === 'E_PAUSED', JSON.stringify(receipt.not_paused));
  } finally { await r.done(); }
});

async function restartRig({ stop = true } = {}) {
  const r = rig();
  await r.m.spawn({ substrate: 'claude-code', worktree: r.worktree, prompt: 'go', worker_id: 'w1', task_id: 't1' });
  if (stop) await r.m.stop({ worker_id: 'w1' });
  return r;
}

test('a run pause landing during a restart of a live worker: the pause is held, the restart is refused after the stop, and the error says stopped, not parked', async () => {
  const r = await restartRig({ stop: false });
  let release; const gate = new Promise((res) => { release = res; });
  let entered; const stalled = new Promise((res) => { entered = res; });
  const write = r.core.worker.write; let armed = true;
  r.core.worker.write = async (row) => { if (armed && row.state === 'stopping') { armed = false; entered(); await gate; } return write(row); }; // the old process is still live and listable
  try {
    const pidBefore = r.m._worker('w1').pid;
    const rs = r.m.restart({ worker_id: 'w1' }).then((x) => ({ ok: x }), (e) => ({ err: e }));
    await stalled;
    const { pending: pausePromise } = await pauseWhenHeld(r, 'w1');
    release();
    const out = await rs;
    const receipt = await pausePromise;
    assert.ok(out.err && out.err.code === 'E_PAUSED', `${out.err && out.err.code}`);
    assert.match(out.err.message, /stopped, not parked/);
    assert.strictEqual(out.err.detail.old_pid, pidBefore);
    assert.notStrictEqual(r.m._worker('w1').pid, undefined);
    assert.ok(!r.m._worker('w1').child || !P.pidAlive(r.m._worker('w1').child.pid), 'no new process was started');
    const np = receipt.not_paused.find((x) => x.worker_id === 'w1');
    assert.ok(np && np.error.code === 'E_PAUSED', JSON.stringify(receipt.not_paused));
  } finally { await r.done(); }
});

test('a run pause landing after the restart launched: the restarted worker is parked once up and named in this pause\'s parks', async () => {
  const r = await restartRig();
  const write = r.core.worker.write; let armed = true; let pausePromise = null;
  r.core.worker.write = async (row) => {
    const out = await write(row);
    if (armed && row.state === 'starting' && row.pid) {
      armed = false;
      pausePromise = r.rp.pause({ run_id: 'run-fake', caller: CALLER });
      while (!(r.m._worker('w1') && r.m._worker('w1').pauseOnLaunch)) await new Promise((res) => setImmediate(res));
    }
    return out;
  };
  try {
    const res = await r.m.restart({ worker_id: 'w1' });
    const receipt = await pausePromise;
    assert.ok(res.parked_by_run_pause, 'the restart reports that the run pause parked it');
    assert.deepStrictEqual(receipt.workers.map((x) => x.worker_id), ['w1']);
    assert.ok(parkedIds(r).includes('w1'), JSON.stringify(r.runRow.pause_parks));
    assert.strictEqual(stateOf(r, 'w1'), 'paused');
  } finally { await r.done(); }
});

test('a stop before the launch: the receipt says the launch was abandoned, the refusal names the task, and a failed preface leaves the stopped row', async () => {
  const r = rig();
  let release; const gate = new Promise((res) => { release = res; });
  let entered; const inAssign = new Promise((res) => { entered = res; });
  r.core.task.assign = async (a) => { if (!a.check_only) { entered(); await gate; throw new FakeCoreError('E_ARGS', 'task t1 cannot be assigned now', {}); } return { task_id: a.task_id }; };
  try {
    const sp = r.m.spawn({ substrate: 'claude-code', worktree: r.worktree, prompt: 'go', worker_id: 'w1', task_id: 't1' }).then((x) => ({ ok: x }), (e) => ({ err: e }));
    await inAssign;
    const rec = await r.m.stop({ worker_id: 'w1' });
    assert.strictEqual(rec.launch_abandoned, true);
    assert.match(rec.note, /launch in flight is abandoned/);
    release();
    const out = await sp;
    assert.ok(out.err, 'the spawn fails');
    const states = r.core.rowsFor('w1').map((x) => x.state);
    assert.ok(!states.includes('dead'), `the preface's failure does not write dead over the stop: ${states}`);
    assert.strictEqual(stateOf(r, 'w1'), 'stopped');
  } finally { await r.done(); }
});

// A run pause that set the run row but listed nothing, because the launching worker had no listable row yet (a restart of a stopped
// worker, or a spawn before its pid row): the launch finds the paused run right after its pid row and holds the pause for itself.
for (const kind of ['spawn', 'restart']) {
  test(`a run paused before the ${kind}'s pid row existed: the launch parks itself once up`, async () => {
    const r = kind === 'restart' ? await restartRig() : rig();
    const write = r.core.worker.write; let armed = true;
    r.core.worker.write = async (row) => {
      if (armed && row.state === 'starting' && row.pid) { armed = false; r.runRow.paused_at = Date.now(); r.runRow.paused_by = 'operator:1'; }
      return write(row);
    };
    try {
      const res = kind === 'restart' ? await r.m.restart({ worker_id: 'w1' }) : await r.m.spawn({ substrate: 'claude-code', worktree: r.worktree, prompt: 'go', worker_id: 'w1' });
      assert.ok(res.parked_by_run_pause, JSON.stringify(Object.keys(res)));
      assert.strictEqual(res.parked_by_run_pause.paused_by, 'operator:1');
      assert.strictEqual(stateOf(r, 'w1'), 'paused');
    } finally { await r.done(); }
  });
}
