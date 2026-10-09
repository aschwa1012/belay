'use strict';
// status.test.cjs — the truth ladder and its budget (api.md §4, ADR 0005 §6, §9).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { core, sandbox, cleanup, callerFor, listDataDir } = require('./helpers.cjs');

const { openCore } = core('index.cjs');
const RUNGS = ['configured', 'store-present', 'owner-alive', 'run-alive', 'worker-alive', 'worker-responsive'];

test('a dead system is a valid answer, and every rung names what established it', async () => {
  const dir = sandbox();
  try {
    const c = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
    const st = await c.status.get({});
    assert.strictEqual(st.verdict, 'stopped');
    assert.strictEqual(st.data_dir, dir, 'the data dir is echoed back in the spelling the caller passed');
    assert.ok(!st.data_dir.includes(String.fromCharCode(92)), 'forward slashes everywhere');
    assert.strictEqual(st.established_by, 'none');
    assert.deepStrictEqual(st.rungs.map(r => r.rung), RUNGS, 'the rungs come back in the order the contract fixes');
    for (const r of st.rungs) {
      assert.strictEqual(typeof r.established, 'boolean');
      assert.ok(typeof r.by === 'string' && r.by.length > 3, `rung ${r.rung} must name what established it`);
      assert.strictEqual(typeof r.ms, 'number');
      assert.ok(r.detail && typeof r.detail === 'object');
    }
    assert.strictEqual(st.rungs[0].established, true, 'the sandbox exists, so configured holds');
    assert.strictEqual(st.rungs[1].established, false, 'no memory.db yet');
    assert.strictEqual(st.run, null);
    assert.deepStrictEqual(st.workers, []);
    await c.close();
  } finally { cleanup(dir); }
});

test('status.get stays inside its 100 ms budget with no owner alive, and creates no file', async () => {
  const dir = sandbox();
  try {
    // Give it a real store and rows, so the measured path is the copy-then-read one, not an empty dir.
    const o = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
    await o.run.attach({ adapter_pid: process.pid });
    await o.worker.write({ id: 'w1', substrate: 'claude-code', pid: process.pid, state: 'running' });
    for (let i = 0; i < 50; i++) await o.memory.store({ namespace: 'bulk', text: `row ${i}`, embedding: [i, 1], embedding_model: 'm', dim: 2 });
    await o.shutdownOwner();
    await o.close();

    const before = listDataDir(dir);
    const c = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
    const times = [];
    for (let i = 0; i < 5; i++) { const t0 = process.hrtime.bigint(); await c.status.get({}); times.push(Number(process.hrtime.bigint() - t0) / 1e6); }
    times.sort((a, b) => a - b);
    const median = times[2];
    assert.ok(median < 100, `status.get median was ${median.toFixed(1)} ms, over the 100 ms budget (all: ${times.map(t => t.toFixed(1)).join(', ')})`);
    assert.deepStrictEqual(listDataDir(dir), before, 'five status calls created nothing in the data dir');
    await c.close();
  } finally { cleanup(dir); }
});

test('the ladder climbs and the verdict follows it', async () => {
  const dir = sandbox();
  let c = null; // shut down in a finally below, or a failed assertion here leaves the owner alive
  try {
    c = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
    await c.run.attach({ adapter_pid: process.pid });

    let st = await c.status.get({});
    const by = n => st.rungs.find(r => r.rung === n);
    assert.strictEqual(st.established_by, 'owner');
    assert.strictEqual(by('store-present').established, true);
    assert.ok(by('store-present').detail.bytes > 0);
    assert.strictEqual(by('owner-alive').established, true);
    assert.strictEqual(by('owner-alive').detail.pid, process.pid);
    // Amendment A3: this call's caller.pid is this very process's own pid (c is the owner, calling
    // itself in-process), so the rung must keep the in-process wording, not the remote "answered over
    // the pipe" shape a different caller pid would get.
    assert.strictEqual(by('owner-alive').detail.established_by, 'in-process');
    assert.match(by('owner-alive').by, /this process is the owner \(in-process call, no pipe round trip\)/);
    assert.strictEqual(by('run-alive').established, true);
    assert.strictEqual(by('run-alive').detail.adapter_pid_alive, true);
    assert.strictEqual(by('worker-alive').detail.checked, 0, 'no workers is nothing to check, not a failure');
    assert.strictEqual(st.verdict, 'alive', 'every rung with something to check holds');
    // Round-2 should-fix 2(a): the run block's own `alive` and `ended_at` must be pinned here too, not
    // only the run-alive rung above — this is one of the two round-1 fixes no test in this file re-
    // asserted, so a revert of src/core/status.cjs's `alive: runAdapterAlive` to a bare
    // `pidAlive(runRow.adapter_pid)` (round-1 shape) slipped past `npm test` unnoticed.
    assert.strictEqual(st.run.alive, true);
    assert.strictEqual(st.run.ended_at, null);
    assert.strictEqual(by('run-alive').established, st.run.alive, "the rung and the run block's alive must agree");

    // A worker with a live pid but no event stream is degraded, not stopped.
    await c.worker.write({ id: 'w1', substrate: 'claude-code', pid: process.pid, state: 'running' });
    st = await c.status.get({});
    assert.strictEqual(by('worker-alive').established, true);
    assert.strictEqual(by('worker-responsive').established, false);
    assert.strictEqual(by('worker-responsive').detail.workers[0].stream_present, false);
    assert.strictEqual(st.verdict, 'degraded');
    assert.strictEqual(st.workers.length, 1);
    assert.strictEqual(st.workers[0].pid_alive, true);

    // A fresh stream file makes it responsive again.
    fs.mkdirSync(path.join(dir, 'workers', 'w1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'workers', 'w1', 'stream.jsonl'), '{"type":"assistant"}\n');
    st = await c.status.get({});
    assert.strictEqual(by('worker-responsive').established, true);
    assert.ok(by('worker-responsive').detail.workers[0].last_event_age_ms < 30000);
    assert.strictEqual(st.verdict, 'alive');

    // A worker whose row says `running` but whose process has since exited is derived as not alive.
    // The row is written while the pid really is alive, exactly as the run manager would write it, and
    // then the process ends on its own: nothing about its death is self-reported.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { windowsHide: true });
    await c.worker.write({ id: 'w2', substrate: 'codex', pid: child.pid, state: 'running' });
    await new Promise(r => child.once('exit', r));
    st = await c.status.get({});
    assert.strictEqual(by('worker-alive').established, false);
    assert.strictEqual(st.verdict, 'degraded');
    assert.ok(by('worker-alive').detail.workers.some(w => w.id === 'w2' && w.pid_alive === false));

    // With the run ended, the fourth rung fails and the verdict drops to stopped. The run block must
    // agree: this process's own pid (adapter_pid) is still alive (it is the test process itself), so a
    // reverted `alive: pidAlive(runRow.adapter_pid)` would read `true` here even though the run has
    // ended — exactly the disagreement round-1 finding 4 named and this assertion pins.
    await c.run.end({ exit_reason: 'test finished' });
    st = await c.status.get({});
    assert.strictEqual(by('run-alive').established, false);
    assert.strictEqual(st.verdict, 'stopped');
    assert.strictEqual(st.run.alive, false);
    assert.strictEqual(typeof st.run.ended_at, 'number');
    assert.ok(Number.isFinite(st.run.ended_at));
    assert.strictEqual(by('run-alive').established, st.run.alive, "the rung and the run block's alive must agree");

    await c.shutdownOwner();
    await c.close();
  } finally { if (c) { try { await c.shutdownOwner(); } catch { /* best effort */ } try { await c.close(); } catch { /* best effort */ } } cleanup(dir); }
});

test('status.get names another run when asked, and its worker projection carries mid_turn and death_established_by', async () => {
  const dir = sandbox();
  // Fix round (should-fix, tests/core/status.test.cjs:152): the two cores must close and the owner
  // must stop in a finally, not inside the try — otherwise a regression that fails an assertion
  // between opening them and closing them leaves the elected owner (pipe server, owner.lock, sqlite
  // handle) alive forever, and `node --test` never exits instead of turning red.
  let a = null, b = null;
  try {
    a = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: 'run-a' }), embed: false });
    await a.run.attach({ adapter_pid: process.pid });
    await a.worker.write({ id: 'wa', substrate: 'claude-code', pid: process.pid, state: 'running', mid_turn: 1 });

    b = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: 'run-b' }), embed: false });
    await b.run.attach({ adapter_pid: process.pid });

    // b's own caller.run_id is run-b; naming run-a explicitly must report run-a's rungs, not b's own.
    const st = await b.status.get({ run_id: 'run-a' });
    const by = n => st.rungs.find(r => r.rung === n);
    assert.strictEqual(by('run-alive').detail.run_id, 'run-a');
    assert.ok(st.run && st.run.id === 'run-a');
    assert.strictEqual(st.run.alive, true);
    const w = st.workers.find(w => w.id === 'wa');
    assert.ok(w, 'the worker projection did not carry wa');
    assert.strictEqual(w.mid_turn, 1);
    assert.strictEqual(w.death_established_by, null, 'a row nothing ever wrote a death onto carries null, not undefined');

    // With no run_id argument, a caller still gets its own run — the ladder is unchanged from before
    // this step whenever the argument is absent.
    const stOwn = await b.status.get({});
    assert.strictEqual(stOwn.run.id, 'run-b');
  } finally {
    // shutdownOwner() is safe to call on either core and more than once: whichever of a/b actually won
    // the in-process election stops it directly, and the other's call finds no live lock and no-ops.
    if (a) { try { await a.shutdownOwner(); } catch { /* best effort */ } try { await a.close(); } catch { /* best effort */ } }
    if (b) { try { await b.shutdownOwner(); } catch { /* best effort */ } try { await b.close(); } catch { /* best effort */ } }
    cleanup(dir);
  }
});

test('any spelling of one data dir answers with the same canonical path', async () => {
  // The property an orchestrator depends on is not "the string round-trips" but "one directory has one
  // answer, whatever spelling reached openCore". Equality against a forward-slashed fixture alone would
  // still hold for an implementation that echoed its argument back unchanged, which is wrong for a
  // native or trailing-separator path; passing all three spellings is what pins it.
  const dir = sandbox();
  try {
    const native = path.resolve(dir);
    if (process.platform === 'win32') {
      assert.ok(native.includes(String.fromCharCode(92)), 'the fixture must really hand over a native-spelled path');
    }
    const answers = [];
    for (const spelling of [dir, native, dir + '/']) {
      const c = await openCore({ dataDir: spelling, caller: callerFor('operator'), embed: false });
      answers.push((await c.status.get({})).data_dir);
      await c.close();
    }
    assert.deepStrictEqual(answers, [dir, dir, dir], 'one directory must have one answer, whatever spelling reached openCore');
    for (const a of answers) assert.ok(!a.includes(String.fromCharCode(92)), 'forward slashes everywhere');
  } finally { cleanup(dir); }
});

test('status.get reports the store stamp from the copy it already reads, and null for an unstamped store', async () => {
  const { SCHEMA_VERSION, writtenBy } = core('schema-stamp.cjs');
  const dir = sandbox();
  try {
    const none = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
    assert.strictEqual((await none.status.get({})).store, null, 'no store file, so no store block');
    await none.close();

    const o = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
    await o.run.attach({ adapter_pid: process.pid });
    await o.shutdownOwner();
    await o.close();

    const before = listDataDir(dir);
    const c = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
    const st = await c.status.get({});
    assert.strictEqual(st.established_by, 'copy');
    assert.deepStrictEqual(st.store, { schema_version: SCHEMA_VERSION, written_by: writtenBy() });
    assert.deepStrictEqual(listDataDir(dir), before, 'reading the stamp created nothing in the data dir');
    await c.close();
  } finally { cleanup(dir); }
});
