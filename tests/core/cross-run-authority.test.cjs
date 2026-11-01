'use strict';
// cross-run-authority.test.cjs — what an orchestrator or a worker of one live run may not do to another live run's work: lease
// its task to a worker of that run, cut or remove its task tree, take its tree through a fix or tree_of, and use a lease held
// under the other run by worker id alone. Real engine over a sandbox store, two live runs ra and rb (this process is both
// adapters); each refusal is checked to have written nothing.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { core, sandbox, cleanup } = require('./helpers.cjs');
const WH = require('./worktree-helpers.cjs');
const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');

const O = (run) => ({ role: 'orchestrator', run_id: run, pid: process.pid });
const Wk = (run, id) => ({ role: 'worker', run_id: run, worker_id: id, pid: process.pid });
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };

let dir, store, E, repo;
const call = (caller, m, args = {}) => E.handle(m, { caller, ...args });
const code = (want) => (e) => { assert.strictEqual(e.code, want, `${e.code}: ${e.message}`); return true; };
const idle = (id, run, extra = {}) => ({ id, substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: `s-${id}`, last_event_at: Date.now(), ...(run ? { run_id: run } : {}), ...extra });

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  repo = WH.makeRepo(dir);
  await call(O('ra'), 'run.attach', { adapter_pid: process.pid, project_dir: repo, fix_hard_cap: 3 });
  await call(O('rb'), 'run.attach', { adapter_pid: process.pid, project_dir: repo, fix_hard_cap: 3 });
});
after(() => { try { store.close(); } catch { /* closed */ } cleanup(dir); });

test('task.assign of rb work to a worker of live run ra is refused, with or without files', async () => {
  await call(O('ra'), 'worker.write', idle('x-assign', 'ra', { state: 'running' }));
  for (const files of [['assign.js'], undefined]) {
    const t = await call(O('rb'), 'task.create', { spec: 'rb work', acceptance: PASS, ...(files ? { files_owned: files } : {}) });
    await assert.rejects(call(O('rb'), 'task.assign', { task_id: t.id, worker_id: 'x-assign' }), (e) => { code('E_ROLE')(e); assert.strictEqual(e.detail.worker_run_id, 'ra'); return true; });
    const after = await call(O('rb'), 'task.get', { task_id: t.id });
    assert.strictEqual(after.run_id, 'rb');
    assert.strictEqual(after.seq, t.seq, 'the task row was not written');
    assert.strictEqual(after.state, 'open');
  }
});

test('task.assign to a worker of a run that has ended still works', async () => {
  await call(O('rold'), 'run.attach', { adapter_pid: process.pid });
  await call(O('rold'), 'worker.write', idle('x-old', 'rold', { state: 'running' }));
  await call(O('rold'), 'run.end', { exit_reason: 'test' });
  const t = await call(O('rb'), 'task.create', { spec: 'rb work', acceptance: PASS });
  const r = await call(O('rb'), 'task.assign', { task_id: t.id, worker_id: 'x-old' });
  assert.strictEqual(r.new_lease.holder, 'x-old');
});

test('task_worktree create and remove on a task of live run ra, from rb, are refused and change nothing', { timeout: 240000 }, async () => {
  const open = await call(O('ra'), 'task.create', { spec: 'ra open', acceptance: PASS, files_owned: ['src/o.cjs'] });
  await assert.rejects(call(O('rb'), 'task.worktreeCreate', { task_id: open.id }), code('E_ROLE'));
  assert.strictEqual(WH.git(repo, 'branch', '--list', `belay/${open.id}`), '', 'no branch was cut');
  assert.strictEqual((await call(O('ra'), 'task.get', { task_id: open.id })).seq, open.seq);

  let ta = await call(O('ra'), 'task.create', { spec: 'ra work', acceptance: PASS, files_owned: ['src/a.cjs'] });
  ta = await call(O('ra'), 'task.worktreeCreate', { task_id: ta.id });
  const wt = ta.worktree.path;
  WH.write(wt, 'src/uncommitted.txt', 'not committed\n');
  await assert.rejects(call(O('rb'), 'task.worktreeRemove', { task_id: ta.id, force: true }), code('E_ROLE'));
  assert.ok(fs.existsSync(`${wt}/src/uncommitted.txt`), 'the tree and its uncommitted work are intact');
  assert.strictEqual((await call(O('ra'), 'task.get', { task_id: ta.id })).seq, ta.seq);
  const own = await call(O('ra'), 'task.worktreeRemove', { task_id: ta.id, force: true });
  assert.ok(own.worktree.removed_at, 'its own run still removes it');
});

test('worktreeRemove by an orchestrator is refused for a tree in a repository that is not its run repository', { timeout: 240000 }, async () => {
  const other = WH.makeRepo(dir);
  await call(O('rc'), 'run.attach', { adapter_pid: process.pid, project_dir: other });
  const tc = await call(O('rc'), 'task.create', { spec: 'rc work', acceptance: PASS, files_owned: ['src/c.cjs'] });
  // the operator may name another repository for the task's tree; rc's orchestrator then may not remove it
  const made = await call({ role: 'operator', run_id: 'cli', pid: process.pid }, 'task.worktreeCreate', { task_id: tc.id, repo });
  await assert.rejects(call(O('rc'), 'task.worktreeRemove', { task_id: tc.id }), code('E_ROLE'));
  assert.ok(fs.existsSync(made.worktree.path), 'the tree is intact');
});

test('fixFromReview and tree_of on another live run work are refused', { timeout: 240000 }, async () => {
  let w = await call(O('ra'), 'task.create', { spec: 'ra work', acceptance: PASS, files_owned: ['src/w.cjs'] });
  w = await call(O('ra'), 'task.worktreeCreate', { task_id: w.id });
  await assert.rejects(call(O('rb'), 'task.create', { spec: 'rb in ra tree', acceptance: PASS, tree_of: w.id }), code('E_ROLE'));
  const hand = async (taskId, wid, wtree, result) => {
    await call(O('ra'), 'worker.write', idle(wid, 'ra', { worktree: wtree }));
    const a = await call(O('ra'), 'task.assign', { task_id: taskId, worker_id: wid });
    await call(Wk('ra', wid), 'lease.release', { lease_id: a.new_lease.id, reason: 'done', result });
  };
  WH.write(w.worktree.path, 'src/w.cjs', 'work\n'); WH.commit(w.worktree.path, 'work');
  await hand(w.id, 'c-w', w.worktree.path, { branch: w.worktree.branch });
  await call(O('ra'), 'task.evaluate', { task_id: w.id });
  const rv = await call(O('ra'), 'task.create', { spec: 'review w', depends_on: [w.id], acceptance: { verdict: true } });
  await hand(rv.id, 'j-w', dir, { verdict: 'refuted', summary: 's', findings: [] });
  await call(O('ra'), 'task.evaluate', { task_id: rv.id, worktree: dir });
  const before = (await call(O('ra'), 'task.list', {})).tasks.length;
  await assert.rejects(call(O('rb'), 'task.fixFromReview', { review_id: rv.id }), code('E_ROLE'));
  assert.strictEqual((await call(O('ra'), 'task.list', {})).tasks.length, before, 'no fix task was made');
});

test('a worker of ra cannot renew, release or checkpoint a lease granted under live run rb', async () => {
  // rb leases its task to x-lease, whose row names no run; a worker of that id under run ra then calls the lease.
  await call(O('rb'), 'worker.write', idle('x-lease', null, { state: 'running' }));
  const t = await call(O('rb'), 'task.create', { spec: 'rb work', acceptance: PASS });
  const a = await call(O('rb'), 'task.assign', { task_id: t.id, worker_id: 'x-lease' });
  assert.strictEqual(a.new_lease.run_id, 'rb');
  const lease = a.new_lease;
  const ra = Wk('ra', 'x-lease');
  await assert.rejects(call(ra, 'lease.renew', { lease_id: lease.id }), code('E_NOT_HOLDER'));
  await assert.rejects(call(ra, 'lease.release', { lease_id: lease.id, result: { summary: 'from ra' } }), code('E_NOT_HOLDER'));
  await assert.rejects(call(ra, 'continuity.checkpoint', { task_id: t.id, summary: 's' }), code('E_NO_LEASE'));
  const task = await call(O('rb'), 'task.get', { task_id: t.id });
  assert.strictEqual(task.state, 'assigned');
  assert.ok(!task.handoff, 'no hand-back was written');
  // the same id called as run rb is the holder
  const renewed = await call(Wk('rb', 'x-lease'), 'lease.renew', { lease_id: lease.id });
  assert.strictEqual(renewed.run_id, 'rb');
  // a death of a worker of that id under run ra releases nothing of rb's (the release is keyed by the dying row's run too)
  const LHD = core('lease-holder-dead.cjs');
  assert.deepStrictEqual(store.tx(() => LHD.releaseForDeadHolder(store, 'x-lease', 'test', Date.now(), 'ra')), []);
  const held = (await call(O('rb'), 'task.list', {})).tasks.find((x) => x.id === t.id).lease;
  assert.ok(held && held.released_at == null, 'the lease of the other live run is not released');
});

// A task whose policy step holds a live worker lease answers its own run's asks as a standing lease, but another run's orchestrator
// still gets the cross-run refusal: the standing answer must not run before the guard. Own sandbox, through the public core.
test('task.assign by another run over a policy-granted live lease is refused E_ROLE, not answered as existing', async () => {
  const { openCore } = core('index.cjs');
  const d2 = sandbox();
  const C = (run) => ({ role: 'orchestrator', run_id: run, pid: process.pid });
  const ra = await openCore({ dataDir: `${d2}/data`, caller: C('ra'), embed: false });
  await ra.run.attach({ adapter_pid: process.pid });
  const rb = await openCore({ dataDir: `${d2}/data`, caller: C('rb'), embed: false });
  await rb.run.attach({ adapter_pid: process.pid });
  try {
    const h = ra.harness();
    await ra.worker.write({ id: 'wk-a', substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: 's-a', last_event_at: Date.now(), worktree: d2 });
    const t = await ra.task.create({ spec: 'ra work' });
    const seq = (await h.policy.claim({ step: 'fix', trigger: { table: 'task', id: t.id, seq: (await ra.task.get({ task_id: t.id })).seq }, task_id: t.id })).row.seq;
    await h.policyAs(seq).task.assign({ task_id: t.id, worker_id: 'wk-a' });
    await assert.rejects(rb.task.assign({ task_id: t.id, worker_id: 'wk-a' }), code('E_ROLE'));
    const again = await ra.task.assign({ task_id: t.id, worker_id: 'wk-a' }); // the same run still gets the standing answer
    assert.strictEqual(again.existing, true);
  } finally { await rb.close(); try { await ra.shutdownOwner(); } finally { await ra.close(); cleanup(d2); } }
});

// The wider pre-fix hole: a policy step's caller was answered by ANY live worker lease on the task, so run rb's own policy step
// handed back ra's standing lease as success. The cross-run guard must refuse it first, and the refusal must write nothing.
test('task.assign by run rb\'s policy step over run ra\'s task with a standing lease is refused E_ROLE and writes nothing', async () => {
  const { openCore } = core('index.cjs');
  const d2 = sandbox();
  const C = (run) => ({ role: 'orchestrator', run_id: run, pid: process.pid });
  const ra = await openCore({ dataDir: `${d2}/data`, caller: C('ra'), embed: false });
  await ra.run.attach({ adapter_pid: process.pid });
  const rb = await openCore({ dataDir: `${d2}/data`, caller: C('rb'), embed: false });
  await rb.run.attach({ adapter_pid: process.pid });
  try {
    const worker = (id) => ({ id, substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: `s-${id}`, last_event_at: Date.now(), worktree: d2 });
    await ra.worker.write(worker('wk-a'));
    await rb.worker.write(worker('wk-b'));
    const ta = await ra.task.create({ spec: 'ra work' });
    const tb = await rb.task.create({ spec: 'rb work' });
    const claim = async (core, t) => (await core.harness().policy.claim({ step: 'fix', trigger: { table: 'task', id: t.id, seq: (await core.task.get({ task_id: t.id })).seq }, task_id: t.id })).row.seq;
    await ra.harness().policyAs(await claim(ra, ta)).task.assign({ task_id: ta.id, worker_id: 'wk-a' });
    const state = async () => {
      const t = await ra.task.get({ task_id: ta.id });
      return { seq: t.seq, state: t.state, lease: t.lease ? { id: t.lease.id, holder: t.lease.holder, expires_at: t.lease.expires_at } : null,
        workers: [(await ra.worker.get({ worker_id: 'wk-a' })).seq, (await rb.worker.get({ worker_id: 'wk-b' })).seq] };
    };
    const before = await state();
    assert.ok(before.lease && before.lease.holder === 'wk-a' && Number.isFinite(Number(before.lease.expires_at)), 'ra holds a standing lease');
    const stepB = rb.harness().policyAs(await claim(rb, tb));
    await assert.rejects(stepB.task.assign({ task_id: ta.id, worker_id: 'wk-b' }), code('E_ROLE'));
    assert.deepStrictEqual(await state(), before, 'the refusal wrote no task, lease or worker row');
    const again = await ra.task.assign({ task_id: ta.id, worker_id: 'wk-a' });
    assert.strictEqual(again.existing, true);
  } finally { await rb.close(); try { await ra.shutdownOwner(); } finally { await ra.close(); cleanup(d2); } }
});
