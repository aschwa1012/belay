'use strict';
// policy-matrix-env.cjs — the seeded exception matrix's shared setup (build package F). Not a *.test.cjs file, so the runner does not run it.
// An in-process Engine on a sandbox store (the real core), the orchestrator's harness view, an operator core, workers that hand back through
// their own cores, the real policy executor and the real policy watcher. No model, no process, no sleep: a condition is seeded by the rows the
// core itself writes. BELAY_KEEP_SANDBOX=<dir> keeps each case's store (a copy, after the owner stopped) and the run receipt the case's wakes
// make, at <dir>/<label>, for the R1 checkers (h3.cjs, h4.cjs).

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('../core/helpers.cjs');
const { createPolicyExecutor } = require('../../src/run/policy-exec.cjs');
const PW = require('../../src/run/policy-wakes.cjs');
const { wakeRecord } = require('../../src/run/wake-record.cjs');
const RE = require('../../src/run/release-eval.cjs');

const { openCore } = core('index.cjs');
const RUN = 'test-run';
const B = (s) => Buffer.byteLength(s, 'utf8');
const PLAN = { review: { worker: 'rv' }, fix: 'builder', re_review: 'refuter', integrate: 'on_hold' };
const without = (plan, ...keys) => { const p = { ...plan }; for (const k of keys) delete p[k]; return p; };
const exits = (code) => ({ commands: [{ argv: [process.execPath, '-e', `process.exit(${code})`], timeout_ms: 20000 }] });
const PASS = exits(0);
const FAIL = exits(1);

async function env({ label = 'case', attach = {} } = {}) {
  const dir = sandbox();
  const orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid, ...attach });
  const op = await openCore({ dataDir: `${dir}/data`, caller: { role: 'operator', run_id: 'cli', pid: process.pid }, embed: false });
  const e = { dir, orch, op, h: orch.harness(), workers: new Map(), wakes: [], label };
  e.raw = (sql, ...a) => orch.owner.engine.store.p(sql).all(...a);
  e.worker = async (id, worktree = dir) => {
    if (e.workers.has(id)) return e.workers.get(id);
    await orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: `s-${id}`, last_event_at: Date.now(), worktree });
    const c = await openCore({ dataDir: `${dir}/data`, caller: callerFor('worker', { worker_id: id }), embed: false });
    e.workers.set(id, c);
    return c;
  };
  // The adapter's task_assign over the stamped view, without the message to a process (no process runs).
  e.exec = (extra = {}, c = e.h) => { const x = createPolicyExecutor({ core: c, runId: RUN, assignFor: (stepCore) => async (a) => stepCore.task.assign(a), closeWaitMs: 0, identity: { pid: process.pid, created: 'own' }, ...extra }); x.arm(); return x; };
  e.x = e.exec();
  e.tick = () => e.x.tick();
  // The policy watcher both wake paths hold; every wake it sends is kept for the run receipt.
  e.watcher = PW.createPolicyWatcher({ core: e.h, runId: RUN, enabled: true });
  e.poll = async () => { const w = await e.watcher.poll({}); e.wakes.push(...w); return w; };
  e.receipt = () => ({ run_id: RUN, wakes: e.wakes.map((w, i) => wakeRecord(w, w.text, 1000 + i, true)) });
  e.close = async () => {
    for (const c of e.workers.values()) await c.close();
    await op.close();
    try { await orch.shutdownOwner(); } finally {
      await orch.close();
      const keep = process.env.BELAY_KEEP_SANDBOX;
      if (keep) { const to = path.join(keep, label); fs.cpSync(`${dir}/data`, to, { recursive: true }); fs.writeFileSync(path.join(to, 'receipt.json'), JSON.stringify(e.receipt(), null, 2)); }
      cleanup(dir);
    }
  };
  return e;
}

const rowsOf = async (e) => (await e.h.task.list({})).tasks;
const rowOf = async (e, id) => (await rowsOf(e)).find((t) => t.id === id);
const leaseOf = (e, taskId) => e.raw('SELECT id, holder FROM lease WHERE task_id = ? ORDER BY seq DESC LIMIT 1', taskId)[0];
const fixesOf = (e, workId) => e.raw('SELECT DISTINCT id FROM task WHERE repairs = ? ORDER BY id', workId);
const stepsOf = (e) => e.raw('SELECT seq, step, outcome, row_ref, error, trigger_table, trigger_id, trigger_seq, task_id FROM policy_step ORDER BY seq');
const evaluate = (e, taskId, tree = null) => e.h.task.evaluate({ task_id: taskId, ...(tree ? {} : { worktree: e.dir }), trigger: 'release' });

// A task the orchestrator assigns by hand, which the worker hands back and belay evaluates as the run manager does (trigger 'release').
async function handBack(e, workerId, task, result = { branch: 'b', head: 'h' }, tree = null) {
  const w = await e.worker(workerId, tree || e.dir);
  const a = await e.orch.task.assign({ task_id: task.id, worker_id: workerId });
  await w.lease.release({ lease_id: a.new_lease.id, reason: 'done', result });
  return evaluate(e, task.id, tree);
}
// A task a policy step already assigned: the worker releases the lease the step wrote.
async function handBackLeased(e, taskId, result = { branch: 'b', head: 'h2' }) {
  const l = leaseOf(e, taskId);
  const w = await e.worker(l.holder);
  await w.lease.release({ lease_id: l.id, reason: 'done', result });
  return evaluate(e, taskId);
}
// Work under `plan`, handed back by `by`. -> the task row after its release evaluation.
async function workDone(e, label, { plan = PLAN, acceptance = PASS, by = `build-${label}`, tree = null, create = {} } = {}) {
  const t = await e.orch.task.create({ spec: `${label} work`, acceptance, policy: plan, ...create });
  const row = await handBack(e, by, t, undefined, tree);
  return { task: t, row, builder: by };
}
// A review of `work`, judged by `judge`.
async function reviewed(e, work, label, verdict, { findings = null, judge = `judge-${label}` } = {}) {
  const review = await e.orch.task.create({ spec: `${label} review`, depends_on: [work.id], acceptance: { verdict: true } });
  const fs_ = findings || (verdict === 'refuted' ? [{ severity: 'blocking', clause: 'a', note: `${label} finding` }] : []);
  const row = await handBack(e, judge, review, { verdict, summary: `${label} ${verdict}`, findings: fs_ });
  return { review, row, judge };
}

// The one wake of a case: its exception, plan field, root work task, trigger row and fact key, and the text's shape. `trigger` is the row the
// wake names as { table, id }, its seq read from the store; `key` the fact's key.
function expectOne(wakes, { exception, field, task_id, trigger, key, halted = null }) {
  assert.strictEqual(wakes.length, 1, `exactly one wake: ${JSON.stringify(wakes)}`);
  const [w] = wakes;
  assert.strictEqual(w.exception, exception);
  assert.strictEqual(w.field, field);
  assert.strictEqual(w.task_id, task_id);
  assert.strictEqual(w.key, key);
  assert.match(w.trigger, new RegExp(`^${trigger.table}:${trigger.id}:\\d+$`), w.trigger);
  if (trigger.seq != null) assert.strictEqual(w.trigger, `${trigger.table}:${trigger.id}:${trigger.seq}`);
  assert.strictEqual(w.event, 'evaluated');
  assert.strictEqual(w.worker_id, `policy:${exception}:${field}:${task_id}`);
  assert.ok(B(w.text) <= RE.WAKE_TEXT_MAX, `${B(w.text)} bytes`);
  assert.ok(w.text.startsWith(`belay: exception ${exception}, task ${task_id}, trigger ${w.trigger}, field ${field}.`), w.text);
  const halts = halted != null ? halted : ['E1', 'E2', 'E3', 'E5', 'E6', 'E7', 'E8'].includes(exception);
  assert.strictEqual(w.text.endsWith(' Halted.'), halts, w.text);
  return w;
}
const evaluatedAt = async (e, id) => (await rowOf(e, id)).results.evaluated_at;
const tref = async (e, id) => { const r = await rowOf(e, id); return { table: 'task', id, seq: r.seq }; };

// What the exception halts: the executor takes no step on the root and its fixes. -> the halted set.
async function halted(e) { const tasks = await rowsOf(e); return PW.haltedIds(e.watcher.active(), tasks); }
// The wake is level-triggered and sent once: a second poll, and one after a pass of the executor, send nothing more.
async function assertOnce(e) {
  assert.deepStrictEqual(await e.poll(), [], 'not sent again');
  await e.tick();
  assert.deepStrictEqual(await e.poll(), [], 'nor after a pass of the executor');
}

module.exports = { env, RUN, PLAN, without, PASS, FAIL, exits, B, rowsOf, rowOf, leaseOf, fixesOf, stepsOf, evaluate, handBack, handBackLeased, workDone, reviewed, expectOne, evaluatedAt, tref, halted, assertOnce, PW };
