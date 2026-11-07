'use strict';
require('../helpers/tmp.cjs');
// digest-fold.test.cjs — the digest rides the wake's own line (ADR 0074 amendment 5): one stdin line and so one orchestrator turn per exception
// or done wake, headless; one injection, interactive. Before it, every such wake was followed by a separate `policy_digest` line.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const D = require('../../src/run/run-digest.cjs');
const DW = require('../../src/run/digest-wake.cjs');
const { wakeText } = require('../../src/run/wake.cjs');
const { startWakePublisher, wakePipeName } = require('../../src/run/wake-pipe.cjs');
const { idleClose } = require('../../src/run/orchestrator-idle-close.cjs');
const { cleanup } = require('../core/helpers.cjs');

const RUN = 'r1';
const fwd = (p) => String(p).split(path.sep).join('/');
const bytes = (s) => Buffer.byteLength(s, 'utf8');
const stepRow = (seq, step, taskId, ref) => ({ seq, run_id: RUN, step, task_id: taskId, outcome: 'done', row_ref: ref, error: null, worker_id: 'coder', trigger_table: 'task', trigger_id: taskId, trigger_seq: 1, finished_at: 1000 + seq });
const exception = (key, text = 'belay: task W failed its own checks (E5).') => ({ event: 'evaluated', exception: 'E5', worker_id: 'policy:W', turn: 0, key, text });
const done = { event: 'policy_done', worker_id: 'policy:run', turn: 0, key: 'd1', text: 'belay: implementation done at abc123.' };

// A headless context: writeWake records the exact stdin text of each wake, as orchestrator.cjs writeWake writes it.
function setup(steps) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-fold-'));
  const state = { wakesSuppressed: [], finishing: false, pendingWrites: [], evalSeen: new Map(), idle: true };
  const lines = [];
  const ctx = { core: { policy: { list: async () => ({ rows: steps.slice(), last_seq: steps.length }) } }, dataDir: fwd(root), runId: RUN, state, armed: () => true, writeWake: (ev) => lines.push({ ev, text: wakeText(ev) }) };
  return { root, state, lines, ctx };
}

test('one exception wake writes exactly one stdin line holding the wake and the digest', async () => {
  const s = setup([stepRow(1, 'fix', 'W', 'task:f1'), stepRow(2, 're_review', 'W', 'task:r2')]);
  try {
    const ev = exception('k1');
    await DW.writeAll([ev], s.ctx);
    assert.strictEqual(s.lines.length, 1, `one line: ${JSON.stringify(s.lines.map((l) => l.text))}`);
    assert.ok(s.lines[0].text.startsWith(`${ev.text}\n`), 'the wake text leads, whole');
    assert.match(s.lines[0].text, /#1 fix W/);
    assert.match(s.lines[0].text, /#2 re_review W/);
    assert.strictEqual(s.lines.filter((l) => l.ev.event === 'policy_digest').length, 0, 'no wake of the digest\'s own');
    assert.deepStrictEqual(D.readDigests(s.ctx.dataDir, RUN).map((d) => [d.via, d.lines.map((l) => l.step_seq)]), [['wake', [1, 2]]]);
    assert.strictEqual(require('../../src/run/wake-record.cjs').wakeRecord(ev, s.lines[0].text, 0, true).digest_n, 1, 'the wake entry joins wakes[] to digests[]');
  } finally { cleanup(s.root); }
});

test('the done wake carries the digest in its own line too', async () => {
  const s = setup([stepRow(1, 'integrate', 'W', 'integration:i1')]);
  try {
    await DW.writeAll([done], s.ctx);
    assert.strictEqual(s.lines.length, 1);
    assert.ok(s.lines[0].text.startsWith(`${done.text}\n`) && /#1 integrate W/.test(s.lines[0].text));
  } finally { cleanup(s.root); }
});

test('two wakes in one poll: the digest rides the last exception only, and the next poll finds nothing new', async () => {
  const s = setup([stepRow(1, 'fix', 'W', 'task:f1')]);
  try {
    await DW.writeAll([exception('k1', 'first'), { event: 'evaluated', worker_id: 'w1', turn: 1, text: 'a routine wake' }, exception('k2', 'second')], s.ctx);
    assert.deepStrictEqual(s.lines.map((l) => l.text.split('\n')[0]), ['first', 'a routine wake', 'second']);
    assert.deepStrictEqual(s.lines.map((l) => l.text.includes('#1 fix')), [false, false, true]);
    await DW.writeAll([exception('k3', 'third')], s.ctx);
    assert.strictEqual(s.lines[3].text, 'third', 'claimed once: no steps, a plain wake');
  } finally { cleanup(s.root); }
});

test('a digest too long for its cap is cut, oldest lines first with a count, and the wake text is never cut', async () => {
  const steps = [];
  for (let i = 1; i <= 60; i += 1) steps.push(stepRow(i, 'integrate', `task-with-a-long-id-${i}`, `integration:i${i}`));
  const s = setup(steps);
  try {
    const text = `belay: ${'x'.repeat(200)}`;
    await DW.writeAll([exception('k1', text)], s.ctx);
    const [head, ...rest] = s.lines[0].text.split('\n');
    assert.strictEqual(head, text, 'the wake text, byte for byte');
    const digest = rest.join('\n');
    assert.ok(bytes(digest) <= D.CAP_BYTES, `digest ${bytes(digest)} bytes`);
    assert.match(digest, /\(\+\d+ earlier policy steps not shown\)/);
    assert.match(digest, /#60 integrate task-with-a-long-id-60/, 'the newest line is kept');
  } finally { cleanup(s.root); }
});

test('a wake the run did not write gives the digest back, and the steps stay for the next asker', async () => {
  const steps = [stepRow(1, 'fix', 'W', 'task:f1')];
  const s = setup(steps);
  try {
    s.ctx.writeWake = (ev) => s.state.wakesSuppressed.push({ ...ev, reason: 'stdin was broken when this event was found' });
    const ev = exception('k1');
    await DW.writeAll([ev], s.ctx);
    assert.strictEqual(ev.rider, undefined, 'the event offered again carries no digest the orchestrator never saw');
    const again = D.claimDigest({ dataDir: s.ctx.dataDir, runId: RUN, rows: steps, via: 'wait' });
    assert.ok(again && again.lines[0].step_seq === 1, 'released: the wait is offered the step');
  } finally { cleanup(s.root); }
});

// The idle close: steps no wake carried ride the notice the close writes; alone only when it writes none.
const closeCtx = (s, extra) => ({
  state: s.state, rows: [], runId: RUN, pending_deaths: [], turnAtCall: 1, hold: { isPaused: () => false }, awaitingWakeIds: () => [],
  callWatcher: { holds: () => [] }, preClose: { check: async () => ({ ran: false }) }, recordHold() {}, writeWake: s.ctx.writeWake,
  closeThenKillOnDeadline: (why) => { s.closed = why; }, flushDigest: DW.closer(s.ctx), ...extra,
});
test('the idle close folds the digest into the stall notice it writes, and writes a digest alone only when it writes no notice', async () => {
  const s = setup([stepRow(1, 'integrate', 'X', 'integration:i1')]);
  try {
    const st = { event: 'stalled', worker_id: 'stall:run', turn: 0, text: 'belay: open tasks nobody is assigned: t1.', task_ids: ['t1'] };
    assert.strictEqual(await idleClose(closeCtx(s, { stall: { atClose: async () => st } })), false);
    assert.strictEqual(s.lines.length, 1);
    assert.ok(s.lines[0].text.startsWith(`${st.text}\n`) && /#1 integrate X/.test(s.lines[0].text), 'one line: the notice and the steps');
    s.ctx.core.policy.list = async () => ({ rows: [stepRow(1, 'integrate', 'X', 'integration:i1'), stepRow(2, 'fix', 'X', 'task:f2')], last_seq: 2 });
    assert.strictEqual(await idleClose(closeCtx(s, {})), false, 'nothing to carry it: written alone, and the close waits');
    assert.deepStrictEqual(s.lines.slice(1).map((l) => l.ev.event), ['policy_digest']);
    assert.strictEqual(await idleClose(closeCtx(s, {})), true, 'nothing new: it closes');
    assert.strictEqual(s.lines.length, 2);
  } finally { cleanup(s.root); }
});

// Interactive: the digest is the tail of the wake's own published line, inside the 221-byte cap.
const until = async (f) => { for (let i = 0; i < 400; i += 1) { if (f()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };
function readLines(pipe) {
  const out = []; let buf = '';
  const c = net.connect(pipe);
  c.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { try { out.push(JSON.parse(buf.slice(0, i))); } catch { /* torn */ } buf = buf.slice(i + 1); } });
  c.on('error', () => {});
  return { out, close: () => c.destroy() };
}
test('interactive: the death wake and the digest are one published line within 221 bytes; a wake with no room leaves the steps unclaimed', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-fold-i-'));
  const dataDir = fwd(path.join(base, 'data')); fs.mkdirSync(dataDir);
  const steps = [stepRow(1, 'fix', 'W', 'task:f1')];
  const core = {
    worker: { list: async () => ({ workers: [{ id: 'c1', run_id: RUN, state: 'dead', turns: 1, pid: 999991, pid_created: '1', exited_at: Date.now() + 60000, exit_code: 1 }] }) },
    run: { get: async () => ({ run: { id: RUN, policy_default: { review: true } } }) },
    task: { list: async () => ({ tasks: [] }) },
    policy: { list: async () => ({ rows: steps.slice() }) },
  };
  const pipe = wakePipeName(dataDir, RUN, 'n-fold');
  const pub = startWakePublisher({ core, runId: RUN, dataDir, pipeName: pipe, pollMs: 20 });
  await pub.listening;
  const rd = readLines(pipe);
  try {
    assert.ok(await until(() => rd.out.some((l) => l.id && /belay did/.test(l.text))), `a wake line with the digest: ${JSON.stringify(rd.out)}`);
    const wakes = rd.out.filter((l) => l.id);
    assert.strictEqual(wakes.filter((l) => /belay did/.test(l.text)).length, 1, 'one line carries the digest');
    assert.strictEqual(wakes.filter((l) => /^belay: policy steps since/.test(l.text)).length, 0, 'none of its own');
    const death = wakes.find((l) => /died during turn/.test(l.text));
    assert.match(death.text, /\| belay did: #1 fix W/);
    assert.ok(bytes(death.text) <= 221, `${bytes(death.text)} bytes`);
    assert.deepStrictEqual(D.readDigests(dataDir, RUN).map((d) => d.via), ['wake']);
  } finally { rd.close(); await pub.stop(); cleanup(base); }
});

test('interactive: a digest whose room is under FOLD_MIN_CAP claims nothing', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-fold-r-'));
  try {
    const dataDir = fwd(base);
    const core = { policy: { list: async () => ({ rows: [stepRow(1, 'fix', 'W', 'task:f1')] }) } };
    assert.strictEqual(await D.foldDigest({ core, dataDir, runId: RUN, cap: D.FOLD_MIN_CAP - 1 }), null);
    assert.deepStrictEqual(D.readDigests(dataDir, RUN), [], 'nothing claimed');
    const fit = await D.foldDigest({ core, dataDir, runId: RUN, cap: D.FOLD_MIN_CAP + 30 });
    assert.ok(fit && /^ \| belay did: #1 fix W/.test(fit.text) && bytes(fit.text) <= D.FOLD_MIN_CAP + 30);
  } finally { cleanup(base); }
});
