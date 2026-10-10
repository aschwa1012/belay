'use strict';
// memory-preface.test.cjs — ADR 0042 decisions 2 and 3: the first message's memory index, inject-once on a
// relaunch, and the rule that with the levers off the first message is today's, byte for byte. The run
// manager runs against the fake substrate and a fake core extended with the four memory methods it calls.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const MP = require('../../src/run/memory-preface.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const RL = 'task t1 state assigned; next step: (stated) none yet';
const PROMPT = 'implement the thing';

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-memory-preface-'));
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
const received = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text) : []);

// The fake core plus run.get (levers) and the memory methods the preface calls. `rows` is what memory.index
// would rank; it honours exclude_ids as the real method does and returns a fixed text for what is left.
function memoryCore({ levers = null, rows = [], failIndex = false, failEvents = false } = {}) {
  const core = createFakeCore({ runId: 'run-fake', resumeLineText: RL });
  const events = [];
  core.run = { get: async () => ({ run: { memory_levers: levers === null ? null : JSON.stringify(levers) } }) };
  core.memory.index = async (a) => {
    core.calls.push({ method: 'memory.index', args: a });
    if (failIndex) { const e = new Error('index down'); e.code = 'E_OWNER_LOST'; throw e; }
    const left = rows.filter((r) => !(a.exclude_ids || []).includes(r));
    const text = left.length ? `INDEX ${left.join(' ')}` : '';
    return { text, bytes: Buffer.byteLength(text), row_ids: left, dropped: 0, over_budget: false, sha256: 'f'.repeat(64), considered: rows.length, excluded_already_injected: rows.length - left.length };
  };
  core.memory.events = async (a) => {
    core.calls.push({ method: 'memory.events', args: a });
    if (failEvents) { const e = new Error('events down'); e.code = 'E_OWNER_LOST'; throw e; }
    return { events: events.filter((e) => e.worker_id === a.worker_id && (!a.kinds || a.kinds.includes(e.kind))) };
  };
  core.memory.recordEvent = async (a) => {
    core.calls.push({ method: 'memory.recordEvent', args: a });
    const ev = { ...a, ok: a.ok === undefined ? (a.code ? 0 : 1) : a.ok };
    events.push(ev);
    return ev;
  };
  core.events = events;
  return core;
}
const memCalls = (core) => core.calls.filter((c) => /^memory\.(index|events|recordEvent)$/.test(c.method));

async function run(core, fn) {
  const sb = sandbox();
  const m = mgr(sb, core);
  try { return await fn(m, sb); } finally {
    try { await m.shutdown(); } catch { /* best effort */ }
    cleanup(sb.data);
  }
}

test('levers off: the first message is the resume line then the prompt, byte for byte, and no memory call is made', async () => {
  for (const core of [
    createFakeCore({ runId: 'run-fake', resumeLineText: RL }),                          // a test double with no run.get
    memoryCore({ levers: null }),                                                         // a run row with no memory block
    memoryCore({ levers: { capture: true, first_message_index: false }, rows: ['a'] }),   // other levers on, this one off
  ]) {
    await run(core, async (m, sb) => {
      const recv = path.join(sb.data, 'recv.jsonl');
      await withEnv({ FAKE_RECV_FILE: recv }, async () => {
        await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: PROMPT, worker_id: 'w1', task_id: 't1' });
        await m._waitTurn('w1', 8000);
      });
      const expected = `${RL}\n\n${PROMPT}`;
      assert.strictEqual(m._worker('w1').firstMessage, expected);
      assert.deepStrictEqual(received(recv), [expected], 'the bytes on stdin');
      assert.strictEqual(Buffer.byteLength(received(recv)[0]), Buffer.byteLength(expected));
      assert.deepStrictEqual(memCalls(core), [], 'no index, events or ledger call');
    });
  }
});

test('levers off: a worker with no task is sent exactly its prompt', async () => {
  const core = memoryCore({ levers: null });
  await run(core, async (m, sb) => {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: PROMPT, worker_id: 'w2' });
    assert.strictEqual(m._worker('w2').firstMessage, PROMPT);
    assert.deepStrictEqual(memCalls(core), []);
  });
});

test('levers on: the resume line, then the index, then the prompt, with an index_injected receipt', async () => {
  const core = memoryCore({ levers: { first_message_index: true, index_bytes: 900 }, rows: ['mem-a', 'mem-b'] });
  await run(core, async (m, sb) => {
    const recv = path.join(sb.data, 'recv.jsonl');
    await withEnv({ FAKE_RECV_FILE: recv }, async () => {
      await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: PROMPT, worker_id: 'w3', task_id: 't1' });
      await m._waitTurn('w3', 8000);
    });
    const expected = `${RL}\n\nINDEX mem-a mem-b\n\n${PROMPT}`;
    assert.strictEqual(m._worker('w3').firstMessage, expected);
    assert.deepStrictEqual(received(recv), [expected]);
    const idx = core.calls.find((c) => c.method === 'memory.index');
    assert.deepStrictEqual(idx.args, { task_id: 't1', worker_id: 'w3', max_bytes: 900, exclude_ids: [] });
    assert.strictEqual(core.events.length, 1);
    assert.deepStrictEqual(
      { kind: core.events[0].kind, ok: core.events[0].ok, worker_id: core.events[0].worker_id, task_id: core.events[0].task_id, row_ids: core.events[0].row_ids, bytes: core.events[0].bytes, sha256: core.events[0].sha256, dropped: core.events[0].dropped, over_budget: core.events[0].over_budget },
      { kind: 'index_injected', ok: 1, worker_id: 'w3', task_id: 't1', row_ids: ['mem-a', 'mem-b'], bytes: 'INDEX mem-a mem-b'.length, sha256: 'f'.repeat(64), dropped: 0, over_budget: 0 },
    );
  });
});

test('levers on, no rows: nothing is injected and the event records zero bytes', async () => {
  const core = memoryCore({ levers: { first_message_index: true }, rows: [] });
  await run(core, async (m, sb) => {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: PROMPT, worker_id: 'w4', task_id: 't1' });
    assert.strictEqual(m._worker('w4').firstMessage, `${RL}\n\n${PROMPT}`);
    assert.strictEqual(core.events.length, 1);
    assert.strictEqual(core.events[0].bytes, 0);
    assert.strictEqual(core.events[0].ok, 1);
  });
});

test('a failed index leaves the spawn as it would be with the lever off, plus an ok 0 event naming the code', async () => {
  const core = memoryCore({ levers: { first_message_index: true }, rows: ['x'], failIndex: true });
  await run(core, async (m, sb) => {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: PROMPT, worker_id: 'w5', task_id: 't1' });
    assert.strictEqual(m._worker('w5').firstMessage, `${RL}\n\n${PROMPT}`);
    assert.strictEqual(core.events.length, 1);
    assert.strictEqual(core.events[0].kind, 'index_injected');
    assert.strictEqual(core.events[0].ok, 0);
    assert.strictEqual(core.events[0].code, 'E_OWNER_LOST');
    assert.strictEqual(m._worker('w5').lastError.where, 'memory.index');
  });
});

test('a failed read of the earlier events is also a failed index: nothing is injected twice by guessing', async () => {
  const core = memoryCore({ levers: { first_message_index: true }, rows: ['x'], failEvents: true });
  await run(core, async (m, sb) => {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: PROMPT, worker_id: 'w6', task_id: 't1' });
    assert.strictEqual(m._worker('w6').firstMessage, `${RL}\n\n${PROMPT}`);
    assert.strictEqual(core.calls.filter((c) => c.method === 'memory.index').length, 0);
    assert.strictEqual(core.events[0].ok, 0);
  });
});

test('a relaunch excludes the rows the worker was already shown, and shows only new ones', async () => {
  const core = memoryCore({ levers: { first_message_index: true }, rows: ['mem-a', 'mem-b'] });
  await run(core, async (m, sb) => {
    const recv = path.join(sb.data, 'recv.jsonl');
    await withEnv({ FAKE_RECV_FILE: recv }, async () => {
      await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: PROMPT, worker_id: 'w7', task_id: 't1' });
      await m._waitTurn('w7', 8000);
      const r = await m.restart({ worker_id: 'w7', first_turn_timeout_ms: 8000 });
      assert.strictEqual(r.branch, 'resume');
    });
    const second = core.calls.filter((c) => c.method === 'memory.index')[1];
    assert.deepStrictEqual(second.args.exclude_ids.sort(), ['mem-a', 'mem-b']);
    const texts = received(recv);
    assert.ok(texts[0].includes('INDEX mem-a mem-b'));
    assert.ok(!texts[1].includes('INDEX'), 'the relaunch text carries no second copy of the index');
    assert.strictEqual(core.events.length, 2);
    assert.deepStrictEqual(core.events[1].row_ids, []);
    assert.strictEqual(core.events[1].bytes, 0);
  });
});

test('a relaunch shows a row that appeared since, after the relaunch text', async () => {
  const rows = ['mem-a'];
  const core = memoryCore({ levers: { first_message_index: true }, rows });
  await run(core, async (m, sb) => {
    const recv = path.join(sb.data, 'recv.jsonl');
    await withEnv({ FAKE_RECV_FILE: recv }, async () => {
      await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: PROMPT, worker_id: 'w8', task_id: 't1' });
      await m._waitTurn('w8', 8000);
      rows.push('mem-new');
      await m.restart({ worker_id: 'w8', first_turn_timeout_ms: 8000 });
    });
    const texts = received(recv);
    assert.match(texts[1], /^You were interrupted and resumed\./);
    assert.ok(texts[1].endsWith('\n\nINDEX mem-new'), texts[1]);
  });
});

test('the capture lever reaches the parser; off, the parser keeps no capture state', async () => {
  for (const [levers, want] of [[{ capture: true }, true], [null, false]]) {
    const core = memoryCore({ levers });
    await run(core, async (m, sb) => {
      await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: PROMPT, worker_id: 'wc' });
      assert.strictEqual(m._worker('wc').parser.capture !== null, want);
    });
  }
});

test('ask: lever off is E_LEVER_OFF and loads nothing; on, it hands the manager to the knowledge module', async () => {
  const off = memoryCore({ levers: null });
  await run(off, async (m) => {
    await assert.rejects(m.ask({ question: 'why?' }), (e) => e.code === 'E_LEVER_OFF');
  });
  const ctx = { core: memoryCore({ levers: { knowledge_agent: true } }), runId: 'run-fake', modules: {} };
  const seen = [];
  ctx.modules.knowledge = { ask: async (manager, c, a) => { seen.push([manager, c, a]); return { answer: 'because' }; } };
  const manager = { name: 'm' };
  assert.deepStrictEqual(await MP.ask(manager, ctx, { question: 'why?' }), { answer: 'because' });
  assert.strictEqual(seen[0][0], manager);
  assert.strictEqual(seen[0][1], ctx);
  assert.deepStrictEqual(seen[0][2], { question: 'why?' });
});

test('runEnd: does nothing with the job levers off; calls atRunEnd when one is on; a failure never throws', async () => {
  let called = 0;
  const jobs = { atRunEnd: async () => { called += 1; } };
  await MP.runEnd({ core: memoryCore({ levers: { first_message_index: true, capture: true } }), runId: 'r', modules: { jobs } });
  assert.strictEqual(called, 0);
  await MP.runEnd({ core: memoryCore({ levers: { cost_ledger: true } }), runId: 'r', modules: { jobs } });
  assert.strictEqual(called, 1);
  const ctx = { core: memoryCore({ levers: { wrapup: true } }), runId: 'r', modules: { jobs: { atRunEnd: async () => { throw Object.assign(new Error('boom'), { code: 'E_X' }); } } } };
  await MP.runEnd(ctx);
  assert.strictEqual(ctx.runEndError.code, 'E_X');
});

test('the prompt reaches memory.index as its relevance query; without one no query is sent', async () => {
  const core = memoryCore({ levers: { first_message_index: true }, rows: ['mem-a'] });
  const ctx = { core, runId: 'run-fake' };
  const spec = 'Add a --since <date> option to tally report; dates are UTC days';
  assert.strictEqual(await MP.memoryPreface({ id: 'wq', taskId: 't1' }, ctx, spec), 'INDEX mem-a\n\n');
  const idx = () => core.calls.filter((c) => c.method === 'memory.index');
  assert.deepStrictEqual(idx()[0].args, { task_id: 't1', worker_id: 'wq', max_bytes: 1200, exclude_ids: [], query: spec });
  // A relaunch has no prompt: the core ranks by the task's spec on its own, so no query key is sent.
  await MP.relaunch({ id: 'wr', taskId: 't1' }, ctx, 'resumed');
  assert.ok(!('query' in idx()[1].args), JSON.stringify(idx()[1].args));
  // A blank prompt is no query, and a very long one is cut to what the core accepts.
  await MP.memoryPreface({ id: 'ws' }, ctx, '   ');
  assert.ok(!('query' in idx()[2].args));
  await MP.memoryPreface({ id: 'wt' }, ctx, 'x'.repeat(40000));
  assert.strictEqual(idx()[3].args.query.length, 16384);
  // preface passes its third argument through.
  await MP.preface({ id: 'wu' }, ctx, 'through preface');
  assert.strictEqual(idx()[4].args.query, 'through preface');
});

test('the preface text holds no clock under two Date.now values', async () => {
  const core = memoryCore({ levers: { first_message_index: true }, rows: ['mem-a'] });
  const w = { id: 'wx', taskId: 't1' };
  const ctx = { core, runId: 'run-fake' };
  const real = Date.now;
  let a, b;
  try {
    Date.now = () => 1_700_000_000_000; a = await MP.memoryPreface(w, ctx);
    core.events.length = 0;
    Date.now = () => 1_900_000_000_000; b = await MP.memoryPreface(w, ctx);
  } finally { Date.now = real; }
  assert.strictEqual(a, b);
  assert.strictEqual(a, 'INDEX mem-a\n\n');
});
