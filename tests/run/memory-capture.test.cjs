'use strict';
// memory-capture.test.cjs — ADR 0041 decisions 2, 3 and 7: the turn's event buffer and the observation row.
// The unit tests push real parser output (tests/run/fixtures/capture-claude.jsonl) through the buffer; the
// integration tests run the manager against the fake substrate and a fake core with the memory surface.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { createParser } = require('../../src/run/parsers.cjs');
const MC = require('../../src/run/memory-capture.cjs');
const TR = require('../../src/run/turn-record.cjs');
const { memoryCore } = require('./fake-memory.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const ON = { capture: true, observations: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-memory-capture-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: d.replace(/\\/g, '/'), worktree: path.join(d, 'wt').replace(/\\/g, '/') };
}
function mgr(sb, core) {
  return createRunManager({
    core, dataDir: sb.data, runId: 'run-fake',
    paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
  });
}
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
async function run(core, fn, env = {}) {
  const sb = sandbox();
  const m = mgr(sb, core);
  try { return await withEnv(env, () => fn(m, sb)); } finally {
    try { await m.shutdown(); } catch { /* best effort */ }
    cleanup(sb.data);
  }
}
async function until(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); }
  return false;
}
const observations = (core) => core.stores.filter((s) => s.type === 'observation');
const obsEvents = (core) => core.events.filter((e) => e.kind === 'observation');

// ---- the buffer, with real parser output ----

function parsedEvents(fixture) {
  const p = createParser('claude-code', { capture: true, redact: (t) => ({ text: t, redactions: [] }) });
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', fixture), 'utf8');
  return p.pushChunk(Buffer.from(text.endsWith('\n') ? text : text + '\n')).events;
}

test('buffer: parser tool events are kept per turn, keyed by the turn_end event, and taken once', () => {
  const tools = parsedEvents('capture-claude.jsonl').filter((e) => e.kind === 'tool_use' || e.kind === 'tool_result');
  assert.ok(tools.length >= 4, 'the fixture has tool events');
  const w = { parser: {} };
  const end = { kind: 'turn_end' };
  for (const e of [...tools, end]) MC.onEvent(w, e, ON);
  assert.deepStrictEqual(MC.takeTurn(w, end), tools);
  assert.deepStrictEqual(MC.takeTurn(w, end), [], 'taken once');
  assert.deepStrictEqual(w.memBuf.events, [], 'the next turn starts empty');
});

test('buffer: a turn the compaction hook swallows leaves nothing for the next turn', () => {
  const w = { parser: {} };
  const t1 = { kind: 'tool_use', tool: 'Read' };
  const end1 = { kind: 'turn_end' };
  const t2 = { kind: 'tool_use', tool: 'Edit' };
  const end2 = { kind: 'turn_end' };
  for (const e of [t1, end1, t2, end2]) MC.onEvent(w, e, ON);
  assert.deepStrictEqual(MC.takeTurn(w, end2), [t2]); // end1 was never taken
});

test('buffer: a relaunch (new parser) and a failed turn drop the partial events of the previous life', () => {
  const w = { parser: { id: 1 } };
  MC.onEvent(w, { kind: 'tool_use', tool: 'Read' }, ON);
  w.parser = { id: 2 };
  const t = { kind: 'tool_use', tool: 'Edit' };
  const end = { kind: 'turn_end' };
  MC.onEvent(w, t, ON);
  MC.onEvent(w, end, ON);
  assert.deepStrictEqual(MC.takeTurn(w, end), [t]);
  MC.onEvent(w, { kind: 'tool_use', tool: 'Read' }, ON);
  MC.onEvent(w, { kind: 'turn_failed' }, ON);
  const end2 = { kind: 'turn_end' };
  MC.onEvent(w, end2, ON);
  assert.deepStrictEqual(MC.takeTurn(w, end2), []);
});

test('buffer: with no consumer nothing is kept, and the buffer is bounded', () => {
  const w = { parser: {} };
  for (const lv of [undefined, {}, { capture: false, observations: true }, { capture: true, observations: false }]) {
    MC.onEvent(w, { kind: 'tool_use' }, lv);
  }
  assert.strictEqual(w.memBuf, undefined, 'no state without capture and a consumer');
  for (let i = 0; i < MC.MAX_TURN_EVENTS + 5; i += 1) MC.onEvent(w, { kind: 'tool_use' }, ON);
  assert.strictEqual(w.memBuf.events.length, MC.MAX_TURN_EVENTS);
  assert.strictEqual(w.memBuf.dropped, 5);
});

test('observe over real parser output: files, commands by tool_use_id and the failure type come through', () => {
  const evs = parsedEvents('capture-claude.jsonl');
  const { buildObservation } = require('../../src/run/observe.cjs');
  const o = buildObservation({ turn: 1, events: evs.filter((e) => e.kind === 'tool_use' || e.kind === 'tool_result'), final_text: 'done' });
  assert.ok(o.body.files_modified.some((f) => /a\.txt$/.test(f)));
  assert.ok(o.body.files_read.some((f) => /b\.txt$/.test(f)));
  const failed = o.body.commands.find((c) => c.command === 'node missing.js');
  assert.ok(failed, 'the failing command is recorded by its tool_use_id');
  assert.strictEqual(failed.exit_code, 127);
  assert.strictEqual(failed.exit_code_source, 'reported');
});

// ---- the observation row, through the manager ----

test('one observation per turn: embed false, source harness, task_id, the turn row alongside, and an ok event', async () => {
  const core = memoryCore({ levers: ON });
  await run(core, async (m, sb) => {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1', task_id: 't1' });
    await m._waitTurn('w1', 8000);
    assert.ok(await until(() => obsEvents(core).length === 1), 'no observation event');
    const obs = observations(core);
    assert.strictEqual(obs.length, 1);
    const o = obs[0];
    assert.strictEqual(o.body.kind, o.body.files_modified.length ? 'change' : o.body.kind, 'the class is kept in the body');
    assert.ok(['change', 'discovery', 'failure', 'turn'].includes(o.body.kind));
    assert.strictEqual(o.embed, false);
    assert.strictEqual(o.source, 'harness');
    assert.strictEqual(o.task_id, 't1');
    assert.strictEqual(o.turn, 1);
    assert.strictEqual(o.worker_id, 'w1', 'the observation names the worker it is about');
    assert.strictEqual(core.stores.find((s) => s.type === 'turn').worker_id, 'w1', 'and so does the turn row, with a lever on');
    assert.ok(o.title.startsWith('turn 1:') && /read input\.md/.test(o.title), o.title);
    assert.deepStrictEqual(o.body.files_read, ['input.md']);
    assert.strictEqual(o.body.tool_counts.Read, 1);
    assert.match(o.body.narrative, /^echo: /);
    assert.strictEqual(o.body.narrative_source, 'worker-stated');
    assert.strictEqual(core.stores.filter((s) => s.type === 'turn').length, 1, 'the turn row is unchanged');
    const ev = obsEvents(core)[0];
    assert.strictEqual(ev.ok, 1);
    assert.strictEqual(ev.worker_id, 'w1');
    assert.strictEqual(ev.task_id, 't1');
    assert.strictEqual(ev.row_ids.length, 1);
    assert.strictEqual(ev.newest_row_id, ev.row_ids[0]);
    assert.strictEqual(ev.bytes, Buffer.byteLength(o.text));
    assert.match(ev.sha256, /^[0-9a-f]{64}$/);
  });
});

test('two turns give two observations, each with only its own events', async () => {
  const core = memoryCore({ levers: ON });
  await run(core, async (m, sb) => {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    await m.message({ worker_id: 'w1', text: 'two' });
    await m._waitTurn('w1', 8000);
    assert.ok(await until(() => observations(core).length === 2), 'second observation missing');
    const [a, b] = observations(core);
    assert.deepStrictEqual([a.turn, b.turn], [1, 2]);
    assert.strictEqual(a.body.tool_counts.Read, 3);
    assert.strictEqual(b.body.tool_counts.Read, 3, 'not six: the buffer reset at the turn');
    assert.ok(!('task_id' in a), 'no task, no task_id key');
  }, { FAKE_TOOL_USES: '3' });
});

test('a failed observation store is an ok 0 event with the code, is not retried, and the turn row still lands', async () => {
  const core = memoryCore({ levers: ON, failStore: 'observation' });
  await run(core, async (m, sb) => {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    assert.ok(await until(() => obsEvents(core).length === 1));
    await sleep(300);
    assert.strictEqual(observations(core).length, 1, 'attempted exactly once');
    const ev = obsEvents(core)[0];
    assert.strictEqual(ev.ok, 0);
    assert.strictEqual(ev.code, 'E_OWNER_LOST');
    assert.strictEqual(ev.row_ids, undefined);
    assert.strictEqual(core.memories.length, 1, 'only the turn row is stored');
    assert.strictEqual(m._worker('w1').lastError.where, 'memory.store');
  });
});

test('a failed event write is named on the worker and never retried', async () => {
  const core = memoryCore({ levers: ON, failEvent: true });
  await run(core, async (m, sb) => {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    assert.ok(await until(() => core.callsTo('memory.recordEvent').length === 1));
    await sleep(300);
    assert.strictEqual(core.callsTo('memory.recordEvent').length, 1);
    assert.strictEqual(m._worker('w1').lastError.where, 'memory.recordEvent');
  });
});

test('a turn with no assistant text still gets its observation', async () => {
  const core = memoryCore({ levers: ON });
  const w = { id: 'w9', turns: 4, taskId: null, substrate: 'claude-code', lastAssistantText: '', memoryQueue: null };
  const ctx = { core, memoryLevers: ON, shutdownFlags: {} };
  const end = { kind: 'turn_end', text: '' };
  MC.onEvent(w, { kind: 'tool_use', tool: 'Read', args: { file_path: 'x.md' } }, ON);
  MC.onEvent(w, end, ON);
  TR.queueMemory(w, end, ctx, 1200, null);
  await w.memoryQueue;
  assert.strictEqual(core.stores.length, 1);
  assert.strictEqual(core.stores[0].type, 'observation');
  assert.strictEqual(core.stores[0].turn, 4);
});

test('the jobs after a turn get the turn events, the turn row id and the observation id, only when a job lever is on', async () => {
  for (const [levers, expectCalls] of [[ON, 0], [{ ...ON, summaries: 'mechanical' }, 1], [{ capture: true, cost_ledger: true }, 1]]) {
    const seen = [];
    const core = memoryCore({ levers });
    await run(core, async (m, sb) => {
      await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
      await m._waitTurn('w1', 8000);
      await sleep(300);
      m._worker('w1').ctx.modules = { jobs: { afterTurn: async (w, ctx, a) => { seen.push(a); } } };
      await m.message({ worker_id: 'w1', text: 'two' });
      await m._waitTurn('w1', 8000);
      await sleep(400);
      assert.strictEqual(seen.length, expectCalls, JSON.stringify(levers));
      if (expectCalls) {
        assert.strictEqual(seen[0].turnEvents.length, 4, 'two tool_use and two tool_result');
        assert.ok(seen[0].turnRowId, 'the turn row id is passed');
        if (levers.observations) assert.ok(seen[0].observationId, 'the observation id is passed'); else assert.strictEqual(seen[0].observationId, null);
      }
    }, { FAKE_TOOL_USES: '2' });
  }
});

test('a jobs module that throws is named on the worker and does not break the next turn', async () => {
  const core = memoryCore({ levers: { ...ON, summaries: 'mechanical' } });
  await run(core, async (m, sb) => {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    await sleep(300);
    m._worker('w1').ctx.modules = { jobs: { afterTurn: async () => { throw new Error('boom'); } } };
    await m.message({ worker_id: 'w1', text: 'two' });
    await m._waitTurn('w1', 8000);
    assert.ok(await until(() => m._worker('w1').lastError && m._worker('w1').lastError.where === 'memory.afterTurn'));
    await m.message({ worker_id: 'w1', text: 'three' });
    await m._waitTurn('w1', 8000);
    assert.ok(await until(() => observations(core).length === 3));
  });
});
