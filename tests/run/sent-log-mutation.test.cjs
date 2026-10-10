'use strict';
// sent-log-mutation.test.cjs — claims of sent-log.cjs that a mutation run showed no other test pins down: a
// replaced stream starts the turn count again, the kind is checked, every failure carries a named code and a
// message cut at 300, and a failed receipt lands on lastError.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const shim = require('./redact-shim.cjs');
shim.install();
const SL = require('../../src/run/sent-log.cjs');
const { cleanup } = require('../core/helpers.cjs');

const fwd = (p) => p.replace(/\\/g, '/');
const tmp = () => fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-sent-log-mut-')));
const RESULT = JSON.stringify({ type: 'result', subtype: 'success' }) + '\n';
const ctxOn = (extra = {}) => ({ memoryLevers: { bottle: true }, ...extra });
const worker = (dir) => ({ id: 'w1', taskId: 't1', dir, streamPath: fwd(path.join(dir, 'stream.jsonl')) });
const rows = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('a stream replaced by a shorter one starts the turn count again from its first line', () => {
  const dir = tmp();
  try {
    const w = worker(dir);
    const ctx = ctxOn();
    fs.writeFileSync(w.streamPath, RESULT + RESULT + RESULT);
    assert.strictEqual(SL.record(w, ctx, 'task', 'a').turn, 4);
    fs.writeFileSync(w.streamPath, RESULT);
    assert.strictEqual(SL.record(w, ctx, 'message', 'b').turn, 2, 'one result in the new stream, counted from its first byte');
    fs.appendFileSync(w.streamPath, RESULT);
    assert.strictEqual(SL.record(w, ctx, 'message', 'c').turn, 3);
  } finally { cleanup(dir); }
});

test('a kind that is not one of the five is refused by name and writes nothing', () => {
  const dir = tmp();
  try {
    const w = worker(dir);
    assert.strictEqual(SL.record(w, ctxOn(), 'bogus', 'text'), null);
    assert.strictEqual(w.lastError.where, 'sent-log');
    assert.strictEqual(w.lastError.code, 'E_ARGS');
    assert.match(w.lastError.message, /"bogus" is not one of task, message, wake, resume, compact/);
    assert.ok(!fs.existsSync(SL.sentPath(w)));
    for (const k of SL.KINDS) assert.ok(SL.record(w, ctxOn(), k, 'ok'), k);
    assert.deepStrictEqual(rows(SL.sentPath(w)).map((r) => r.kind), SL.KINDS);
  } finally { cleanup(dir); }
});

test('a failure keeps an E_ code, replaces any other code with E_SENT_LOG, and cuts its message at 300', () => {
  const dir = tmp();
  try {
    const cases = [
      [Object.assign(new Error('mine'), { code: 'E_REDACT_X' }), 'E_REDACT_X', 'mine'],
      [Object.assign(new Error('os level'), { code: 'EACCES' }), 'E_SENT_LOG', 'os level'],
      [new Error('plain'), 'E_SENT_LOG', 'plain'],
      [Object.assign(new Error('x'.repeat(500)), { code: 'E_LONG' }), 'E_LONG', 'x'.repeat(300)],
      ['a thrown string', 'E_SENT_LOG', 'a thrown string'],
    ];
    for (const [thrown, code, message] of cases) {
      const w = worker(dir);
      const ctx = ctxOn({ modules: { redact: () => { throw thrown; } } });
      assert.strictEqual(SL.record(w, ctx, 'task', 'spec'), null);
      assert.deepStrictEqual(w.lastError, { where: 'sent-log', code, message });
      assert.deepStrictEqual(w.sentFailures, [{ where: 'sent-log', code, message }]);
    }
  } finally { cleanup(dir); }
});

test('flush passes the task id, and a receipt that cannot be written lands on lastError', async () => {
  const dir = tmp();
  try {
    const w = worker(dir);
    fs.mkdirSync(SL.sentPath(w));
    const ctx = ctxOn();
    SL.record(w, ctx, 'task', 'one');
    SL.record(w, ctx, 'task', 'two');
    assert.strictEqual(w.sentFailures.length, 2);
    const seen = [];
    ctx.core = { memory: { recordEvent: async (a) => { seen.push(a); return a; } } };
    assert.strictEqual(await SL.flush(w, ctx), 2);
    assert.strictEqual(seen[0].task_id, 't1');
    assert.match(seen[0].message, /^sent record: /);
    assert.strictEqual(seen[0].worker_id, 'w1');
    const noTask = { ...worker(dir), taskId: null };
    SL.record(noTask, ctx, 'task', 'three');
    seen.length = 0;
    await SL.flush(noTask, ctx);
    assert.strictEqual(seen[0].task_id, undefined);

    SL.record(w, ctx, 'task', 'four');
    ctx.core = { memory: { recordEvent: async () => { throw Object.assign(new Error('ledger down'), { code: 'E_OWNER_LOST' }); } } };
    assert.strictEqual(await SL.flush(w, ctx), 0);
    assert.deepStrictEqual(w.lastError, { where: 'memory.recordEvent', code: 'E_OWNER_LOST', message: 'ledger down' });
    assert.strictEqual(w.sentFailures.length, 0, 'the failure is taken out whether or not its receipt was written');
  } finally { cleanup(dir); }
});

test('the sequence continues from the last line of an existing file and ignores damaged lines', () => {
  const dir = tmp();
  try {
    const w = worker(dir);
    fs.writeFileSync(SL.sentPath(w), `${JSON.stringify({ seq: 7, turn: 1, kind: 'task', text: 'x' })}\nnot json\n${JSON.stringify({ seq: 3, turn: 1, kind: 'task', text: 'y' })}\n`);
    assert.strictEqual(SL.record(w, ctxOn(), 'message', 'next').seq, 8);
    assert.strictEqual(SL.record(w, ctxOn(), 'message', 'after').seq, 9);
  } finally { cleanup(dir); }
});
