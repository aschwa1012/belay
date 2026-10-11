'use strict';
// memory-off-identity.test.cjs — off means byte-identical (BUILD-PLAN rule 3). The same script (a spawn with a
// task, two messages) runs on the fake-claude fixture against four cores: the plain fake core the base suites
// use, and cores whose run row carries no memory block, the explicit defaults, and levers that feed nothing
// on the turn path. With every capture, observation and job lever off the store calls, the rows and the bytes
// written to stdin must be what the base build produced, and no memory method beyond the base turn store may
// be called. The run manager is handed its levers the way the orchestrator adapter hands them (from the row its
// own run.attach returned), so it makes no read of its own: the core methods called are the base build's, run.get
// included.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { DEFAULTS, leversOfRow } = require('../../src/run/memory-levers.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { memoryCore } = require('./fake-memory.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const RL = 'task t1 state assigned; next step: (stated) none yet';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-memory-off-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: d.replace(/\\/g, '/'), worktree: path.join(d, 'wt').replace(/\\/g, '/') };
}

// The script, and everything it leaves that the memory work could change.
async function runScript(core, { handLevers = true } = {}) {
  const sb = sandbox();
  const m = createRunManager({
    core, dataDir: sb.data, runId: 'run-fake', memoryLevers: handLevers && core.runRow ? leversOfRow(core.runRow) : null,
    paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
  });
  const recv = path.join(sb.data, 'recv.jsonl');
  const saved = { FAKE_RECV_FILE: process.env.FAKE_RECV_FILE, FAKE_TOOL_USES: process.env.FAKE_TOOL_USES };
  process.env.FAKE_RECV_FILE = recv;
  process.env.FAKE_TOOL_USES = '2';
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1', task_id: 't1' });
    await m._waitTurn('w1', 8000);
    await m.message({ worker_id: 'w1', text: 'two' });
    await m._waitTurn('w1', 8000);
    await sleep(500); // the turn memory writes are off the turn path
    const w = m._worker('w1');
    const stdin = fs.readFileSync(recv, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text);
    return {
      stdin,
      memoryCalls: core.calls.filter((c) => /^memory\./.test(c.method)).map((c) => ({ method: c.method, args: { ...c.args, provenance: String(c.args.provenance).replace(/[0-9a-f-]{36}/, '<id>') } })),
      allMethods: [...new Set(core.calls.map((c) => c.method))].sort(),
      states: core.rowsFor('w1').map((r) => r.state),
      turns: w.turns,
      memBuf: w.memBuf,
      lastError: w.lastError,
    };
  } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    try { await m.shutdown(); } catch { /* best effort */ }
    cleanup(sb.data);
  }
}

test('levers off: stdin bytes, memory store calls and rows equal the base build on the fake-claude fixture', async () => {
  const base = await runScript(createFakeCore({ runId: 'run-fake', resumeLineText: RL }));
  // The base build's behaviour, stated outright so the comparison is not only against a copy of the same code.
  assert.deepStrictEqual(base.stdin, [`${RL}\n\none`, 'two']);
  assert.deepStrictEqual(base.memoryCalls.map((c) => c.method), ['memory.store', 'memory.store']);
  for (const c of base.memoryCalls) {
    assert.deepStrictEqual(Object.keys(c.args).sort(), ['provenance', 'tags', 'text', 'type']);
    assert.strictEqual(c.args.type, 'turn');
  }

  const variants = {
    'no memory block': memoryCore({ levers: null, resumeLineText: RL }),
    'explicit defaults': memoryCore({ levers: DEFAULTS, resumeLineText: RL }),
    // Levers that exist but feed nothing on the turn path: capture alone has no consumer, and the others act elsewhere.
    'capture only': memoryCore({ levers: { capture: true }, resumeLineText: RL }),
    'delivery levers only': memoryCore({ levers: { first_message_index: false, bottle: true, knowledge_agent: true }, resumeLineText: RL }),
  };
  for (const [name, core] of Object.entries(variants)) {
    const got = await runScript(core);
    assert.deepStrictEqual(got.stdin, base.stdin, `${name}: stdin bytes`);
    assert.deepStrictEqual(got.memoryCalls, base.memoryCalls, `${name}: memory calls`);
    assert.deepStrictEqual(got.states, base.states, `${name}: worker rows`);
    assert.strictEqual(got.turns, base.turns, `${name}: turns`);
    assert.strictEqual(got.memBuf, undefined, `${name}: nothing buffered`);
    assert.strictEqual(got.lastError, base.lastError, `${name}: no error noted`);
    // Everything the run called, run.get included: the levers came in with the manager, so nothing read them.
    assert.deepStrictEqual(got.allMethods, base.allMethods, `${name}: core methods called`);
    assert.ok(!got.allMethods.includes('run.get'), `${name}: no run.get`);
    assert.deepStrictEqual(core.events, [], `${name}: no memory_event`);
  }
});

test('a manager handed its levers makes no core call at shutdown when nothing was spawned; one not handed them reads once', async () => {
  const plain = createFakeCore({ runId: 'run-fake' });
  const psb = sandbox();
  try { await createRunManager({ core: plain, dataDir: psb.data, runId: 'run-fake', paths: { claudeExe: FAKE } }).shutdown(); } finally { cleanup(psb.data); }
  const baseCalls = plain.calls.map((c) => c.method);
  for (const hand of [true, false]) {
    const core = memoryCore({ levers: DEFAULTS, resumeLineText: RL });
    const sb = sandbox();
    const m = createRunManager({ core, dataDir: sb.data, runId: 'run-fake', memoryLevers: hand ? leversOfRow(core.runRow) : null, paths: { claudeExe: FAKE } });
    try { await m.shutdown(); } finally { cleanup(sb.data); }
    // The base build's own shutdown calls, and, only for a manager not handed its levers, the one read.
    assert.deepStrictEqual(core.calls.map((c) => c.method), hand ? baseCalls : ['run.get', ...baseCalls], `handed ${hand}`);
  }
  // Not handed the levers, a spawn costs exactly the one run.get on top of the base calls, and nothing else changes.
  const base = await runScript(createFakeCore({ runId: 'run-fake', resumeLineText: RL }));
  const core = memoryCore({ levers: null, resumeLineText: RL });
  const got = await runScript(core, { handLevers: false });
  assert.deepStrictEqual(got.stdin, base.stdin);
  assert.deepStrictEqual(got.allMethods, [...base.allMethods, 'run.get'].sort());
  assert.strictEqual(core.calls.filter((c) => c.method === 'run.get').length, 1);
});

test('levers on is observably different (the identity test would notice): an observation store and an event appear', async () => {
  const core = memoryCore({ levers: { capture: true, observations: true }, resumeLineText: RL });
  const got = await runScript(core);
  assert.deepStrictEqual(got.stdin, [`${RL}\n\none`, 'two'], 'the bytes on stdin do not change either way');
  assert.strictEqual(got.memoryCalls.filter((c) => c.args.type === 'observation').length, 2);
  assert.strictEqual(core.events.filter((e) => e.kind === 'observation').length, 2);
});
