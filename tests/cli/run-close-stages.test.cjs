'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// run-close-stages.test.cjs — `belay run` and the run-close stages: what cmd-run hands the stages (through the closeStagesModule seam, so
// nothing is spawned), when it does so (after the worker close, before run.end), that a stage can never change the exit code, and that
// a console closing (SIGHUP) tells the stages to spawn nothing. Headless and interactive, both in this process.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const H = require('./stop-helpers.cjs');
const cmdRun = require('../../src/cli/cmd-run.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { start, withRun } = require('./run-interactive-helpers.cjs');
const { ROOT, sandbox, cleanup, makeSpec, waitUntil, releaseCore, currentRunRow } = H;

const FAKE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const NOTES = { project: 'p', notes: true };

async function headless(over, module) {
  const dir = sandbox();
  const saved = process.env.BELAY_CLAUDE_EXE;
  process.env.BELAY_CLAUDE_EXE = FAKE;
  try {
    const { specPath, wt } = makeSpec(dir, { timeout_ms: 4000, ...over });
    const res = await cmdRun.run({ argv: [specPath], cwd: ROOT, dataDir: `${dir}/.belay`, json: true, closeStagesModule: module });
    return { res, wt, dir };
  } finally { if (saved === undefined) delete process.env.BELAY_CLAUDE_EXE; else process.env.BELAY_CLAUDE_EXE = saved; }
}

test('headless: the stages get the harness core, the worktree, the goal and the notes levers, before run.end, and the receipt carries what they returned', async () => {
  const seen = [];
  const mod = { closeStages: async (a) => { seen.push({ runId: a.runId, worktree: a.worktree, goal: a.goal, notes: a.levers.notes, fast: a.fast(), log: typeof a.log, ended: (await a.core.run.get()).run.ended_at, who: a.core.caller }); return { scrub: { ran: false, reason: 'seam' }, review: null }; } };
  const { res, wt, dir } = await headless({ memory: NOTES }, mod);
  try {
    assert.strictEqual(res.code, 0, res.json.ended_by);
    assert.strictEqual(seen.length, 1);
    const s = seen[0];
    assert.deepStrictEqual([s.runId, s.worktree, s.goal, s.notes, s.fast, s.log, s.ended], [res.json.run_id, wt, 'line one of the prompt\nline two of the prompt\n', true, false, 'function', null], 'the run row is still open when the stages run');
    assert.strictEqual(s.who.channel, 'harness');
    assert.deepStrictEqual(res.json.close_stages, { scrub: { ran: false, reason: 'seam' }, review: null });
    assert.ok(res.json.store.ended, 'run.end followed');
  } finally { cleanup(dir); }
});

test('headless: a stage that throws, or a child that survived its kill, never turns a clean run into a crash; the survivor is named', async () => {
  const thrown = await headless({ memory: NOTES }, { closeStages: async () => { throw new Error('the stage blew up'); } });
  try {
    assert.strictEqual(thrown.res.code, 0, 'a stage failure is not the run\'s failure');
    assert.match(thrown.res.json.close_stages.error, /stage blew up/);
  } finally { cleanup(thrown.dir); }
  const alive = await headless({ memory: NOTES }, { closeStages: async () => ({ scrub: { ran: true, survivor: 4242 }, review: null }) });
  try {
    assert.strictEqual(alive.res.code, 1);
    assert.match(alive.res.json.ended_by, /run-close stage child \(pid 4242\) is still alive/);
  } finally { cleanup(alive.dir); }
});

test('headless: with notes off the stages are not even asked, and the receipt has no close_stages', async () => {
  const mod = { closeStages: async () => assert.fail('no stage with notes off') };
  const { res, dir } = await headless({}, mod);
  try {
    assert.strictEqual(res.code, 0);
    assert.ok(!('close_stages' in res.json));
  } finally { cleanup(dir); }
});

test('interactive: the same call, with fast() false at a normal exit', async (t) => withRun(t, async (dir) => {
  const seen = [];
  const mod = { closeStages: async (a) => { seen.push({ worktree: a.worktree, fast: a.fast && a.fast(), ended: (await a.core.run.get()).run.ended_at }); return { scrub: null, review: null }; } };
  const r = start(dir, { specOverrides: { memory: NOTES }, ctxExtra: { closeStagesModule: mod } });
  const res = await r.done;
  assert.strictEqual(res.code, 0, res.json.ended_by);
  assert.deepStrictEqual(seen.map((x) => [x.worktree, x.fast, x.ended]), [[r.wt, false, null]]);
  assert.deepStrictEqual(res.json.close_stages, { scrub: null, review: null });
}));

test('interactive fast close: after a SIGHUP the stages are told so (fast() true), and a stage that returns at once is not a fast-close failure', async (t) => withRun(t, async (dir) => {
  const seen = [];
  const mod = { closeStages: async (a) => { seen.push(a.fast && a.fast()); return { scrub: { ran: false, reason: 'fast close' }, review: { ran: false, reason: 'fast close' } }; } };
  const r = start(dir, { env: { FAKE_HOLD_MS: '800' }, specOverrides: { memory: NOTES }, ctxExtra: { closeStagesModule: mod } });
  let core;
  try {
    assert.ok(await waitUntil(() => r.record(), 15000));
    core = await openCore({ dataDir: r.dataDir, caller: { role: 'orchestrator', run_id: r.runId, pid: process.pid } });
    assert.ok(await waitUntil(async () => (await core.run.get()).run, 15000));
    process.emit('SIGHUP');
    const res = await r.done;
    assert.deepStrictEqual(seen, [true]);
    assert.strictEqual(res.json.ended_by, 'console closed (fast close)', 'no "deadline passed during the run-close stages" was chained on');
    const row = currentRunRow(r.dataDir, r.runId);
    assert.ok(row.ended_at != null);
    assert.ok(!fs.existsSync(`${r.dataDir}/owner.lock`));
  } finally { await releaseCore(core); }
}));

test('Ctrl-C during the stages (SIGINT, SIGBREAK) is a console close: fast() turns true, the listeners go away afterwards, and the run still ends', async () => {
  for (const sig of ['SIGINT', 'SIGBREAK']) {
    const before = process.listenerCount(sig);
    const seen = [];
    const mod = { closeStages: async (a) => { seen.push(a.fast()); process.emit(sig); seen.push(a.fast()); return { scrub: null, review: null }; } };
    const { res, dir } = await headless({ memory: NOTES }, mod);
    try {
      assert.deepStrictEqual(seen, [false, true], sig);
      assert.strictEqual(res.code, 0, res.json.ended_by);
      assert.ok(res.json.store.ended, 'run.end followed');
      assert.strictEqual(process.listenerCount(sig), before, 'the listener is removed');
    } finally { cleanup(dir); }
  }
});

test('a stage cut off by the fast close deadline still names the children that survived', async () => {
  const { runCloseStages } = require('../../src/cli/run-close-stages.cjs');
  const { TIMED_OUT } = require('../../src/run/orchestrator-interactive.cjs');
  const ce = { hupSeen: () => true, bound: async () => TIMED_OUT };
  const late = [];
  const out = await runCloseStages({ core: {}, runId: 'r', levers: { memory_levers: { notes: true } }, dataDir: 'd', ce, late: (m) => late.push(m), stages: { closeStages: (a) => { a.sink.survivors.push(4321); return new Promise(() => {}); } } });
  assert.deepStrictEqual(out, { cut: true, survivors: [4321] });
  assert.match(late[0], /run-close stages/);
});

test('a stage cut off while a child is starting: its pid, recorded at spawn, is found, killed by pid, and a survivor is named', async () => {
  const { runCloseStages } = require('../../src/cli/run-close-stages.cjs');
  const { TIMED_OUT } = require('../../src/run/orchestrator-interactive.cjs');
  const { spawn } = require('node:child_process');
  const { pidAlive } = require('../../src/core/lock.cjs');
  const sleeper = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const ce = { hupSeen: () => true, bound: async () => TIMED_OUT };
  const a = sleeper(), b = sleeper();
  try {
    const killed = [];
    const killPid = async (core, rec) => { killed.push(rec.pid); if (rec.pid === a.pid) a.kill(); }; // b resists
    const stages = { closeStages: (x) => { x.sink.pids.push({ worker_id: 'scrub-r-a', pid: a.pid }, { worker_id: 'archreview-r-b', pid: b.pid }); return new Promise(() => {}); } };
    const out = await runCloseStages({ core: {}, runId: 'r', levers: { memory_levers: { notes: true } }, dataDir: 'd', ce, late: () => {}, stages, killPid });
    assert.deepStrictEqual(killed.sort(), [a.pid, b.pid].sort(), 'every recorded child that was alive was killed by its pid');
    assert.ok(!pidAlive(a.pid));
    assert.deepStrictEqual(out, { cut: true, survivors: [b.pid] }, 'only the one still alive is named');
  } finally { require('../crash.cjs').crash(a); require('../crash.cjs').crash(b); }
});
