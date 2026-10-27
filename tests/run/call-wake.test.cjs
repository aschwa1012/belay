'use strict';
// call-wake.test.cjs — an integrate or task_evaluate that answered still_running holds the headless run open while it runs and
// wakes the orchestrator with its result when it lands (src/run/call-wake.cjs, read from the ledger events the adapter writes).
// Over the fakes: no Claude Code, no model.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runOrchestrator } = require('../../src/run/orchestrator.cjs');
const { createCallWatcher } = require('../../src/run/call-wake.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const fwd = (p) => String(p).split(path.sep).join('/');
const FAKE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
const RUN = 'run-call';

const detached = (key, tool, ids, startedAt) => ({ id: `d-${key}`, seq: 1, kind: 'call_detached', key, ok: 1, row_ids: ids, message: JSON.stringify({ tool, started_at: startedAt }) });
const ended = (key, ids, extra = {}) => ({ id: `e-${key}`, seq: 2, kind: 'call_ended', key, ok: 1, row_ids: ids, message: '{}', ...extra });

test('the headless run stays open while a detached task_evaluate runs, and the orchestrator is woken with its result', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-call-wake-'));
  const sb = { worktree: fwd(path.join(root, 'wt')), dataDir: fwd(path.join(root, '.belay')), orchestratorDir: fwd(path.join(root, 'orch')) };
  fs.mkdirSync(sb.worktree, { recursive: true });
  fs.mkdirSync(sb.dataDir, { recursive: true });
  const core = createFakeCore();
  const startedAt = Date.now();
  let reads = 0;
  core.memory = { ...(core.memory || {}), events: async () => {
    reads += 1;
    if (reads < 2) return { events: [] };
    return { events: reads < 6 ? [detached('k1', 'task_evaluate', ['t1'], startedAt)] : [detached('k1', 'task_evaluate', ['t1'], startedAt), ended('k1', ['t1'])] };
  } };
  core.task = { ...(core.task || {}), list: async () => ({ tasks: [] }), get: async () => ({ id: 't1', run_id: RUN, state: 'open', results: { evaluated_at: startedAt + 5, passed: false, executable: true, checks: [{ kind: 'command', argv: ['npm', 'test'], passed: false, exit_code: 1 }] } }) };
  const savedExe = process.env.BELAY_CLAUDE_EXE;
  process.env.BELAY_CLAUDE_EXE = FAKE;
  try {
    const out = await runOrchestrator({ core, runId: RUN, dataDir: sb.dataDir, onAttached: async () => ({ ok: true }), spec: {
      worktree: sb.worktree, promptText: 'hello', orchestratorDir: sb.orchestratorDir, model: 'claude-sonnet-5', allowedTools: null,
      startupTimeoutMs: 8000, timeoutMs: 60000, mcpToolTimeoutMs: 60000, pollMs: 50, closeGraceMs: 3000,
    } });
    assert.ok(reads >= 6, `the run stayed open until the call ended (${reads} ledger reads)`);
    assert.ok(out.holds.some((h) => JSON.stringify(h).includes('call:k1')), 'the detached call held the idle close');
    const woke = out.wakes.filter((w) => w.worker_id === 'call:k1');
    assert.strictEqual(woke.length, 1, `one wake carries the result: ${JSON.stringify(out.wakes)}`);
    assert.ok(woke[0].bytes <= 400, 'inside the hook byte budget');
  } finally {
    if (savedExe === undefined) delete process.env.BELAY_CLAUDE_EXE; else process.env.BELAY_CLAUDE_EXE = savedExe;
    cleanup(root);
  }
});

test('the wake text is facts: an evaluation result, an integration with a conflict, a refusal, and a call that wrote nothing new', async () => {
  const startedAt = 1000;
  const evs = [
    detached('a', 'task_evaluate', ['t1'], startedAt), ended('a', ['t1']),
    detached('b', 'integrate', ['t1', 't2'], startedAt), ended('b', ['t1', 't2'], { newest_row_id: 'i1' }),
    detached('c', 'task_evaluate', ['t3'], startedAt), ended('c', ['t3'], { ok: 0, code: 'E_BUSY', message: JSON.stringify({ error: 'waited too long for a slot' }) }),
    detached('d', 'task_evaluate', ['t4'], startedAt), ended('d', ['t4']),
  ].map((e, i) => ({ ...e, id: `${e.id}-${i}`, seq: i + 1 }));
  const core = {
    memory: { events: async () => ({ events: evs }) },
    task: { get: async ({ task_id }) => (task_id === 't1'
      ? { id: 't1', state: 'open', results: { evaluated_at: 2000, executable: true, passed: false, checks: [{ kind: 'command', argv: ['npm', 'test'], passed: false, exit_code: 1 }] } }
      : { id: task_id, state: 'done', results: { evaluated_at: 5, executable: true, passed: true, checks: [] } }) },
    integration: { get: async () => ({ id: 'i1', state: 'conflict', passed: null, conflict: { task_id: 't2', files: ['x.js', 'y.js'] }, checks: [] }) },
  };
  const w = createCallWatcher({ core, runId: RUN, now: () => 3000 });
  const wakes = await w.poll();
  const text = (id) => wakes.find((x) => x.worker_id === `call:${id}`).text;
  assert.match(text('a'), /task_evaluate of t1 ended: not done; failing: command npm test exit 1/);
  assert.match(text('b'), /integrate of t1, t2 ended: conflict; conflict on task t2 \(2 files\)/);
  assert.match(text('c'), /failed: E_BUSY, waited too long for a slot; nothing was written/);
  assert.match(text('d'), /ended with no new result; the task is done/);
  assert.deepStrictEqual(w.holds(), [], 'every call ended, so nothing holds the close');
  for (const x of wakes) assert.ok(Buffer.byteLength(x.text) <= 221, x.text);
  assert.deepStrictEqual(await w.poll(), [], 'a wake is sent once');
});

test('a call whose adapter died holds the close only until the pending bound, and an unreadable ledger wakes nothing', async () => {
  const RE = require('../../src/run/release-eval.cjs');
  let now = 10000;
  const core = { memory: { events: async () => ({ events: [detached('z', 'integrate', ['t1'], 10000)] }) } };
  const w = createCallWatcher({ core, runId: RUN, now: () => now });
  assert.deepStrictEqual(await w.poll(), []);
  assert.deepStrictEqual(w.holds(), ['call:z']);
  now += RE.PENDING_MAX_MS + 1;
  assert.deepStrictEqual(w.holds(), [], 'past the bound the hold is released');
  const broken = createCallWatcher({ core: { memory: { events: async () => { throw new Error('store gone'); } } }, runId: RUN });
  assert.deepStrictEqual(await broken.poll(), []);
});
