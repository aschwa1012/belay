'use strict';
// sent-log.test.cjs — ADR 0042 decision 4, the sent record: what the harness writes to a worker's stdin is
// recorded in workers/<id>/sent.jsonl only with memory.bottle on, numbered by the turn it starts or is
// folded into, redacted before it is written, and a failure to record never fails the write it records.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const shim = require('./redact-shim.cjs');
shim.install();
const SL = require('../../src/run/sent-log.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const fwd = (p) => p.replace(/\\/g, '/');
const tmp = () => fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-sent-log-')));
const rows = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const RESULT = JSON.stringify({ type: 'result', subtype: 'success' }) + '\n';
const ctxOn = (extra = {}) => ({ memoryLevers: { bottle: true }, ...extra });

function worker(dir) {
  return { id: 'w1', taskId: 't1', dir, streamPath: fwd(path.join(dir, 'stream.jsonl')) };
}

test('lever off or levers unread: nothing is read, written or created', () => {
  const dir = tmp();
  try {
    const w = worker(dir);
    for (const ctx of [{}, { memoryLevers: { bottle: false } }, undefined]) {
      assert.strictEqual(SL.record(w, ctx, 'task', 'the spec'), null);
    }
    assert.deepStrictEqual(fs.readdirSync(dir), [], 'no file in the worker directory');
    assert.strictEqual(w.lastError, undefined);
    assert.strictEqual(w.sentSeq, undefined, 'not even a counter');
  } finally { cleanup(dir); }
});

test('on: one line per message with seq, turn, kind and text; turn counts the results the stream holds', () => {
  const dir = tmp();
  try {
    const w = worker(dir);
    const ctx = ctxOn();
    // No stream yet: the first message starts turn 1.
    assert.deepStrictEqual(SL.record(w, ctx, 'task', 'the spec'), { seq: 1, turn: 1, kind: 'task', text: 'the spec' });
    fs.appendFileSync(w.streamPath, JSON.stringify({ type: 'assistant', message: { content: [] } }) + '\n' + RESULT);
    assert.strictEqual(SL.record(w, ctx, 'message', 'second').turn, 2, 'after one result');
    // A second message with no result between is folded into the same turn.
    assert.strictEqual(SL.record(w, ctx, 'message', 'folded').turn, 2, 'folded into the running turn');
    // A result line whose newline has not been written yet is not counted (the replay rule), then is.
    fs.appendFileSync(w.streamPath, RESULT.trimEnd());
    assert.strictEqual(SL.record(w, ctx, 'wake', 'partial').turn, 2);
    fs.appendFileSync(w.streamPath, '\n');
    assert.strictEqual(SL.record(w, ctx, 'resume', 'after').turn, 3);
    // A tool_result that mentions "result" in its text is not a result line.
    fs.appendFileSync(w.streamPath, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: '{"type":"result"}' }] } }) + '\n');
    assert.strictEqual(SL.record(w, ctx, 'message', 'still three').turn, 3);

    const got = rows(SL.sentPath(w));
    assert.deepStrictEqual(got.map((r) => [r.seq, r.turn, r.kind]), [[1, 1, 'task'], [2, 2, 'message'], [3, 2, 'message'], [4, 2, 'wake'], [5, 3, 'resume'], [6, 3, 'message']]);
    assert.deepStrictEqual(Object.keys(got[0]), ['seq', 'turn', 'kind', 'text']);
  } finally { cleanup(dir); }
});

test('a relaunch or an adopted worker continues the numbering from the file', () => {
  const dir = tmp();
  try {
    const ctx = ctxOn();
    SL.record(worker(dir), ctx, 'task', 'one');
    SL.record(worker(dir), ctx, 'message', 'two');
    const again = worker(dir); // a fresh in-memory worker over the same directory
    assert.strictEqual(SL.record(again, ctx, 'resume', 'three').seq, 3);
  } finally { cleanup(dir); }
});

test('text is redacted before it is written; a redactor that answers wrongly writes nothing and is named', () => {
  const dir = tmp();
  try {
    const w = worker(dir);
    const row = SL.record(w, ctxOn(), 'message', `use the key ${shim.SECRET} please`);
    assert.ok(row.text.includes('[REDACTED:'));
    assert.ok(!fs.readFileSync(SL.sentPath(w), 'utf8').includes(shim.SECRET), 'the secret is not on disk');

    const bad = ctxOn({ modules: { redact: () => ({}) } });
    assert.strictEqual(SL.record(w, bad, 'message', 'x'), null);
    assert.strictEqual(rows(SL.sentPath(w)).length, 1, 'nothing was appended');
    assert.strictEqual(w.lastError.where, 'sent-log');
    assert.strictEqual(w.lastError.code, 'E_REDACT');
  } finally { cleanup(dir); }
});

test('a failed append never throws; it lands on lastError and flush records it as a bottle event with ok 0', async () => {
  const dir = tmp();
  try {
    const w = worker(dir);
    fs.mkdirSync(SL.sentPath(w)); // a directory where the file should be: appendFileSync fails
    const ctx = ctxOn();
    let out;
    assert.doesNotThrow(() => { out = SL.record(w, ctx, 'task', 'spec'); });
    assert.strictEqual(out, null);
    assert.strictEqual(w.lastError.where, 'sent-log');
    assert.strictEqual(w.sentFailures.length, 1);

    const events = [];
    ctx.core = { memory: { recordEvent: async (a) => { events.push(a); return a; } } };
    assert.strictEqual(await SL.flush(w, ctx), 1);
    assert.strictEqual(events[0].kind, 'bottle');
    assert.strictEqual(events[0].ok, 0);
    assert.strictEqual(events[0].code, 'E_SENT_LOG');
    assert.strictEqual(events[0].worker_id, 'w1');
    assert.strictEqual(await SL.flush(w, ctx), 0, 'flushed once');
  } finally { cleanup(dir); }
});

// ---- through the run manager, on the fake substrate -------------------------------------------------------

function memoryCore(levers) {
  const core = createFakeCore({ runId: 'run-fake' });
  core.run = { get: async () => ({ run: { memory_levers: levers === null ? null : JSON.stringify(levers) } }) };
  return core;
}
async function withManager(levers, fn) {
  const data = tmp();
  fs.mkdirSync(path.join(data, 'wt'), { recursive: true });
  const m = createRunManager({
    core: memoryCore(levers), dataDir: data, runId: 'run-fake',
    paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
  });
  try { return await fn(m, { data, worktree: fwd(path.join(data, 'wt')), sent: (id) => path.join(data, 'workers', id, 'sent.jsonl') }); } finally {
    try { await m.shutdown(); } catch { /* best effort */ }
    cleanup(data);
  }
}

test('manager, lever off: a spawn and a message create no sent.jsonl', async () => {
  for (const levers of [null, { bottle: false, capture: true }]) {
    await withManager(levers, async (m, sb) => {
      await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'the spec', worker_id: 'w1' });
      await m._waitTurn('w1', 8000);
      await m.message({ worker_id: 'w1', text: 'later' });
      await m._waitTurn('w1', 8000);
      assert.ok(!fs.existsSync(sb.sent('w1')));
    });
  }
});

test('manager, lever on: the task, then a message, each on the turn it starts, with the secret redacted', async () => {
  await withManager({ bottle: true }, async (m, sb) => {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'build the thing', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    await m.message({ worker_id: 'w1', text: `note: ${shim.SECRET}` });
    await m._waitTurn('w1', 8000);
    const got = rows(sb.sent('w1'));
    assert.deepStrictEqual(got.map((r) => [r.seq, r.turn, r.kind]), [[1, 1, 'task'], [2, 2, 'message']]);
    assert.strictEqual(got[0].text, 'build the thing');
    assert.ok(got[1].text.startsWith('note: [REDACTED:'));
    assert.ok(!JSON.stringify(got).includes(shim.SECRET));
  });
});

test('the harness /compact is recorded as kind compact, and the bottle shows it as generated, never as the orchestrator', () => {
  const dir = tmp();
  try {
    const w = worker(dir);
    const ctx = ctxOn();
    SL.record(w, ctx, 'task', 'the spec');
    fs.appendFileSync(w.streamPath, RESULT);
    const row = SL.record(w, ctx, 'compact', '/compact keep the plan');
    assert.deepStrictEqual([row.kind, row.turn], ['compact', 2]);
    // compaction.cjs's own write goes through the same record with the same kind.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'run', 'compaction.cjs'), 'utf8');
    assert.match(src, /record\(w, ctx, 'compact', text\)/);
    const { buildBottle } = require('../../src/run/bottle.cjs');
    const b = buildBottle({ streamPath: path.join(__dirname, 'fixtures', 'claude-stream.jsonl'), sentPath: SL.sentPath(w), redact: (t) => ({ text: t, redactions: [] }) });
    assert.ok(b.text.includes('user (generated, compact): /compact keep the plan'));
    assert.ok(!b.text.includes('user: /compact'));
  } finally { cleanup(dir); }
});
