'use strict';
// compaction-turns.test.cjs � build 12 wave 3, ADR 0007 decision 3: the compaction turn as seen by the worker and the
// orchestrator (refusal of a message during a /compact, swallow, the waiter, receipts). Split from compaction.test.cjs
// (500-line cap); same helpers, same fakes.


const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const CP = require('../../src/run/compaction.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-compact-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: d.replace(/\\/g, '/'), worktree: path.join(d, 'wt').replace(/\\/g, '/') };
}
function mgr(sb, core, compactAtTokens) {
  return createRunManager({
    core, dataDir: sb.data, runId: 'run-compact-test', compactAtTokens,
    paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
  });
}
// The fake reads its knobs from the environment the worker inherits; set for one test and always restored.
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
async function teardown(m, sb) {
  if (m) { try { await m.shutdown(); } catch { /* best effort */ } }
  cleanup(sb.data);
}
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
async function until(fn, ms = 30000) { // the fake runs each hook as a node process; a loaded host takes seconds per compaction
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}
const records = (sb, id) => lines(`${sb.data}/workers/${id}/compactions.jsonl`);

// ---- afterTurn's guards, on stub records: each one is a case in which a /compact must not be sent.
function stubWorker(over = {}) {
  const writes = [];
  const w = {
    id: 'ws', substrate: 'claude-code', taskId: null, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'belay-stub-')),
    child: { stdin: { destroyed: false, write: (l) => writes.push(l) } }, settled: false, stopRequested: false,
    parkRequested: null, paused: null, turnEnded: true, parser: { noteStdinWrite: () => 7 }, ...over,
  };
  return { w, writes };
}
// The stand-in for worker.cjs's turnStarted: runs the sender synchronously and clears turnEnded.
const turnStarted = (w, ctx, send) => { const sent = send(); w.turnEnded = false; return Promise.resolve({ sent }); };


// ---- fix round 1 (review-1.md)

test('BL1: a message during a harness /compact is refused E_BUSY and written nowhere; after its turn ends it is accepted', async () => {
  const sb = sandbox();
  const recv = `${sb.data}/recv.jsonl`;
  const core = createFakeCore();
  const m = mgr(sb, core, 1000);
  try {
    await withEnv({ FAKE_CTX_START: '1200', FAKE_CTX_STEP: '0', FAKE_RECV_FILE: recv, FAKE_COMPACT_DELAY_MS: '1200' }, async () => {
      await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'wb' });
      // No turn wait here: a wait that starts once the harness's /compact is sent waits the compaction out (it is
      // invisible as a turn), which on a slow host ate the window this test needs. The /compact arriving is the signal.
      await until(() => lines(recv).some((r) => r.text.startsWith('/compact')));
      await assert.rejects(m.message({ worker_id: 'wb', text: 'two' }), (e) => {
        assert.strictEqual(e.code, 'E_BUSY');
        assert.strictEqual(e.detail.op, 'compact');
        assert.match(e.detail.compaction_started_at, /^\d{4}-\d\d-\d\dT/);
        assert.match(e.message, /compacting.*started .*retry/);
        return true;
      });
      assert.ok(!lines(recv).some((r) => r.text === 'two'), 'nothing written');
      assert.strictEqual((await core.worker.get({ worker_id: 'wb' })).turns, 1, 'the row never counted the compaction');
      const res = await m.wait({ worker_ids: ['wb'], timeout_ms: 8000 }); // invisible as a turn: the last real turn
      assert.strictEqual(res.event, 'turn_end');
      assert.strictEqual(res.turn, 1);
      await until(() => records(sb, 'wb').length === 1);
      const ok = await m.message({ worker_id: 'wb', text: 'two' });
      assert.strictEqual(ok.channel, 'stdin');
      assert.strictEqual(ok.turn, 2, 'the compaction was no turn');
      await until(() => lines(recv).some((r) => r.text === 'two'));
      assert.deepStrictEqual(lines(recv).map((r) => r.text).filter((t) => !t.startsWith('/compact')), ['one', 'two']);
    });
  } finally { await teardown(m, sb); }
});

test('BL1: a pause during a harness /compact leaves no stranded state: resume works and messages go straight through', async () => {
  const sb = sandbox();
  const recv = `${sb.data}/recv.jsonl`;
  const m = mgr(sb, createFakeCore(), 1000);
  try {
    await withEnv({ FAKE_CTX_START: '1200', FAKE_CTX_STEP: '0', FAKE_RECV_FILE: recv, FAKE_COMPACT_DELAY_MS: '1500' }, async () => {
      await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'wp' });
      // No turn wait here: a wait that starts once the harness's /compact is sent waits the compaction out (it is
      // invisible as a turn), which on a slow host ate the window this test needs. The /compact arriving is the signal.
      await until(() => lines(recv).some((r) => r.text.startsWith('/compact')));
      await assert.rejects(m.message({ worker_id: 'wp', text: 'A' }), (e) => e.code === 'E_BUSY');
      await m.pause({ worker_id: 'wp', by: 'operator:1' });
      await assert.rejects(m.message({ worker_id: 'wp', text: 'A' }), (e) => e.code === 'E_PAUSED');
      await m.resume({ worker_id: 'wp', by: 'operator:1' });
      const b = await m.message({ worker_id: 'wp', text: 'B' });
      assert.strictEqual(b.channel, 'stdin');
      await until(() => lines(recv).some((r) => r.text === 'B'));
      assert.ok(!lines(recv).some((r) => r.text === 'A'), 'the refused message was never delivered, now or later');
    });
  } finally { await teardown(m, sb); }
});

function swallowStub(inflight, over = {}) {
  return { id: 'wsw', substrate: 'claude-code', parkRequested: null, turnEnded: false, turns: 3, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, pendingTurnEnd: {}, turnWaiters: [], cp: { inflight, pending: null, hookLines: 0, sent: 1, records: [] }, ...over };
}
test('swallow: the compaction turn is accounted without being a turn, and S4: it clears on any terminal end of that turn', () => {
  const ctx = { compactAt: 100 };
  const usage = { input_tokens: 5, output_tokens: 6 };
  for (const [name, e] of [['its own answers_write', { answers_write: 7 }], ['no answers_write (an error or an unmatched end)', { answers_write: null }]]) {
    const w = swallowStub({ at: Date.now(), idx: 7, boundary: false });
    assert.strictEqual(CP.swallow(w, { usage, cost_usd: 0.5, ...e }, ctx), true, name);
    assert.strictEqual(w.turns, 3, 'turns untouched');
    assert.strictEqual(w.turnEnded, true);
    assert.strictEqual(w.cp.inflight, null);
    assert.deepStrictEqual([w.inputTokens, w.outputTokens, w.costUsd], [5, 6, 0.5]);
    assert.strictEqual(w.pendingTurnEnd, null);
  }
  const bound = swallowStub({ at: Date.now(), idx: 7, boundary: true });
  assert.strictEqual(CP.swallow(bound, { usage, answers_write: 12 }, ctx), true, 'a boundary was seen: this end closes it');
  const stuck = swallowStub({ at: Date.now() - 10 * 60 * 1000, idx: 7, boundary: false });
  assert.strictEqual(CP.swallow(stuck, { usage, answers_write: 12 }, ctx), true, 'past the timeout any end closes it');
  const other = swallowStub({ at: Date.now(), idx: 7, boundary: false });
  assert.strictEqual(CP.swallow(other, { usage, answers_write: 3 }, ctx), false, 'an end answering another write is a real turn');
  assert.ok(other.cp.inflight);
  const parked = swallowStub({ at: Date.now(), idx: 7, boundary: false }, { parkRequested: { at: 1 } });
  assert.strictEqual(CP.swallow(parked, { usage, answers_write: 7 }, ctx), false, 'a pause reads that result itself');
  assert.strictEqual(CP.swallow(swallowStub(null), { usage }, ctx), false, 'nothing in flight');
  assert.strictEqual(CP.swallow(swallowStub({ at: Date.now(), idx: 7 }), { usage, answers_write: 7 }, { compactAt: null }), false, 'lever null');
  // refuseIfCompacting: only while in flight; an expired flag releases.
  const fail = (code, msg, detail) => { throw Object.assign(new Error(msg), { code, detail }); };
  CP.refuseIfCompacting({ id: 'x', turns: 1, cp: { inflight: null } }, fail);
  CP.refuseIfCompacting({ id: 'x', turns: 1 }, fail);
  const live = { id: 'x', turns: 1, cp: { inflight: { at: Date.now() } } };
  assert.throws(() => CP.refuseIfCompacting(live, fail), (e) => e.code === 'E_BUSY' && e.detail.op === 'compact');
  const exp = { id: 'x', turns: 1, cp: { inflight: { at: 1 } } };
  CP.refuseIfCompacting(exp, fail);
  assert.strictEqual(exp.cp.inflight, null);
});

test('SF-b: the harness compaction own end is swallowed by its write index: under a park, and past the 5-minute expiry', () => {
  const ctx = { compactAt: 100 };
  const usage = { input_tokens: 5 };
  // A park under way: the end is not a turn, the park still sees its result, the waiter is told it was paused.
  const answers = [];
  const park = swallowStub({ at: Date.now(), idx: 7, boundary: false }, { parkRequested: { interruptAt: 0, resultsSeen: [] }, turnWaiters: [(v) => answers.push(v)] });
  park.cp.sentIdx = new Set([7]);
  assert.strictEqual(CP.swallow(park, { usage, answers_write: 7, subtype: 'error_during_execution', at: 10 }, ctx), true);
  assert.strictEqual(park.turns, 3, 'no turn counted');
  assert.deepStrictEqual(park.parkRequested.resultsSeen, ['error_during_execution']);
  assert.strictEqual(answers.length, 1);
  assert.strictEqual(answers[0].paused, true);
  assert.strictEqual(park.cp.sentIdx.size, 0);
  // Without the mark a park still reads an unmatched end itself (the old rule).
  const other = swallowStub({ at: Date.now(), idx: 7, boundary: false }, { parkRequested: { interruptAt: 0, resultsSeen: [] } });
  other.cp.sentIdx = new Set([7]);
  assert.strictEqual(CP.swallow(other, { usage, answers_write: 3, at: 10 }, ctx), false, 'another write is a real turn');
  // Past the expiry the flag was cleared, yet the compaction's own end is still swallowed; a real turn is not.
  const late = swallowStub(null);
  late.cp.sentIdx = new Set([7]);
  assert.strictEqual(CP.swallow(late, { usage, answers_write: 9 }, ctx), false, 'a real turn after the expiry');
  assert.strictEqual(CP.swallow(late, { usage, answers_write: 7 }, ctx), true, 'the late /compact answer');
  assert.strictEqual(late.turns, 3);
  assert.strictEqual(late.cp.sentIdx.size, 0);
  // A newer compaction's flag is not cleared by an older one's late end.
  const newer = swallowStub({ at: Date.now(), idx: 12, boundary: false });
  newer.cp.sentIdx = new Set([7, 12]);
  assert.strictEqual(CP.swallow(newer, { usage, answers_write: 7 }, ctx), true);
  assert.ok(newer.cp.inflight);
});

test('SF-c: a /compact end swallowed after a later message was written does not answer the later message waiter; a parked worker gets no row write', async () => {
  const ctx = { compactAt: 100 };
  const answers = [];
  const w = swallowStub(null, { turnWaiters: [(v) => answers.push(v)], parser: { writeIndex: 8 } });
  w.cp.sentIdx = new Set([7]);
  assert.strictEqual(CP.swallow(w, { usage: {}, answers_write: 7 }, ctx), true, 'still not a turn');
  assert.strictEqual(answers.length, 0, 'the waiter is the later message');
  assert.strictEqual(w.turnWaiters.length, 1);
  const idle = swallowStub(null, { turnWaiters: [(v) => answers.push(v)], parser: { writeIndex: 7 } });
  idle.cp.sentIdx = new Set([7]);
  CP.swallow(idle, { usage: {}, answers_write: 7 }, ctx);
  assert.strictEqual(answers.length, 1, 'no later write: answered with the last real turn');
  const rows = [];
  await CP.afterCompact({ parkRequested: { at: 1 } }, { writeRow: async (...a) => rows.push(a) });
  assert.strictEqual(rows.length, 0, 'parked: no row');
  await CP.afterCompact({ parkRequested: null }, { writeRow: async (...a) => rows.push(a) });
  assert.strictEqual(rows.length, 1);
});

test('SF-b (real): a pause during a /compact does not count the compaction as a turn', async () => {
  const sb = sandbox();
  const recv = `${sb.data}/recv.jsonl`;
  const core = createFakeCore();
  const m = mgr(sb, core, 1000);
  try {
    await withEnv({ FAKE_CTX_START: '1200', FAKE_CTX_STEP: '0', FAKE_RECV_FILE: recv, FAKE_COMPACT_DELAY_MS: '1500' }, async () => {
      await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'wq' });
      await m._waitTurn('wq', 8000);
      await until(() => lines(recv).some((r) => r.text.startsWith('/compact')));
      await m.pause({ worker_id: 'wq', by: 'operator:1' });
      assert.strictEqual((await core.worker.get({ worker_id: 'wq' })).turns, 1, 'the compaction was no turn');
    });
  } finally { await teardown(m, sb); }
});

test('S2: afterTurn after shutdown reads no store and sends nothing', async () => {
  let reads = 0;
  const { w, writes } = stubWorker({ taskId: 'T-1' });
  try {
    const ctx = { compactAt: 10, shutdownFlags: { closed: true }, core: { continuity: { resumeLine: async () => { reads += 1; return { text: 'x' }; } } } };
    await CP.afterTurn(w, { kind: 'turn_end', context_tokens: 50, is_error: false }, ctx, turnStarted);
    assert.strictEqual(reads, 0);
    assert.strictEqual(writes.length, 0);
  } finally { cleanup(w.dir); }
});

test('S3: the resume line is refreshed at every turn end, under the lever too', async () => {
  let n = 0;
  const { w, writes } = stubWorker({ taskId: 'T-1' });
  try {
    const ctx = { compactAt: 1000, core: { continuity: { resumeLine: async () => { n += 1; return { text: `line ${n}` }; } } } };
    for (let i = 0; i < 3; i += 1) await CP.afterTurn(w, { kind: 'turn_end', context_tokens: 10, is_error: false }, ctx, turnStarted);
    assert.strictEqual(n, 3, 'one store read per turn end');
    assert.strictEqual(fs.readFileSync(path.join(w.dir, CP.RESUME_FILE), 'utf8'), 'line 3');
    assert.strictEqual(writes.length, 0);
  } finally { cleanup(w.dir); }
});

test('S5: the steering text is generic and within the hook budget', () => {
  assert.ok(Buffer.byteLength(CP.STEER) <= CP.HOOK_MAX_BYTES);
  assert.ok(!/passphrase|ledger/i.test(CP.STEER + CP.INSTRUCTIONS));
  for (const word of ['task', 'decisions', 'findings', 'files touched', 'next step']) assert.ok(CP.STEER.includes(word), word);
});

test('S6: a worker with compactions is summarised for belay receipts, one without has no summary', async () => {
  const sb = sandbox();
  const m = mgr(sb, createFakeCore(), 1000);
  try {
    assert.strictEqual(CP.summarize(sb.data, 'nobody'), null);
    await withEnv({ FAKE_CTX_START: '1200', FAKE_CTX_STEP: '0' }, async () => {
      await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'ws6' });
      await m._waitTurn('ws6', 8000);
      await until(() => records(sb, 'ws6').length === 1);
    });
    const s = CP.summarize(sb.data, 'ws6');
    assert.deepStrictEqual(s, { count: 1, harness: 1, auto: 0, last_pre_tokens: 1200, last_post_tokens: 900, max_hook_bytes: s.max_hook_bytes });
    assert.ok(s.max_hook_bytes > 0 && s.max_hook_bytes <= CP.HOOK_MAX_BYTES);
  } finally { await teardown(m, sb); }
});

// ---- fix round 2 (review-2.md)

test('SF2: a wait registered during a compaction on an idle worker answers with the last real turn when it ends', () => {
  const answers = [];
  const w = swallowStub({ at: Date.now(), idx: 7, boundary: false }, { turnWaiters: [(v) => answers.push(v)], lastTurnUsage: { input_tokens: 1 }, lastCheckpointId: 'cp-3' });
  assert.strictEqual(CP.swallow(w, { usage: {}, answers_write: 7 }, { compactAt: 100 }), true);
  assert.deepStrictEqual(answers, [{ usage: { input_tokens: 1 }, checkpoint_id: 'cp-3', is_error: false, paused: false }]);
  assert.strictEqual(w.turnWaiters.length, 0);
});

test('SF2 (real): worker_wait on an idle worker during a slow compaction answers when the compaction ends, not at its timeout', async () => {
  const sb = sandbox();
  const recv = `${sb.data}/recv.jsonl`;
  const m = mgr(sb, createFakeCore(), 1000);
  try {
    await withEnv({ FAKE_CTX_START: '1200', FAKE_CTX_STEP: '0', FAKE_RECV_FILE: recv, FAKE_COMPACT_DELAY_MS: '1000' }, async () => {
      await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w2' });
      await m._waitTurn('w2', 8000);
      await until(() => lines(recv).some((r) => r.text.startsWith('/compact')));
      const t0 = Date.now();
      const res = await m.wait({ worker_ids: ['w2'], timeout_ms: 20000 });
      assert.strictEqual(res.timed_out, false);
      assert.strictEqual(res.event, 'turn_end');
      assert.strictEqual(res.turn, 1, 'the last real turn');
      assert.ok(Date.now() - t0 < 10000, 'answered when the compaction ended');
    });
  } finally { await teardown(m, sb); }
});

test('summarize: a malformed line in compactions.jsonl is skipped, not fatal', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-sum-'));
  try {
    fs.mkdirSync(`${d}/workers/w`, { recursive: true });
    const good = { requested_by: 'harness', trigger: 'manual', pre_tokens: 9, post_tokens: 2, max_hook_bytes: 160 };
    fs.writeFileSync(`${d}/workers/w/${CP.RECORDS_LOG}`, `${JSON.stringify(good)}\n{ torn\n\n${JSON.stringify({ ...good, trigger: 'auto', requested_by: 'substrate' })}\n`);
    assert.deepStrictEqual(CP.summarize(d, 'w'), { count: 2, harness: 1, auto: 1, last_pre_tokens: 9, last_post_tokens: 2, max_hook_bytes: 160 });
    fs.writeFileSync(`${d}/workers/w/${CP.RECORDS_LOG}`, '{ torn\n');
    assert.strictEqual(CP.summarize(d, 'w'), null);
  } finally { cleanup(d); }
});
