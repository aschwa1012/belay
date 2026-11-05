'use strict';
require('../helpers/tmp.cjs');
// wake-unbound-hold.test.cjs — the interactive orchestrator's wake while its session is not bound. Opening Claude Code's
// background-sessions list unmounts the orchestrator's REPL, and from then on `$.prompt.submit` rejects with "not available in this
// mode: no session is bound in this process". The mod had already recorded each wake as delivered, so every wake from then on was
// lost. Now a refused wake is held, first in line, and goes out when the session is back. A claimed wake (a halt or a death, with its
// `(ref ...)`) is submitted before it is recorded (ADR 0074 amendment 1); every other wake keeps the record-then-submit order. The real
// core.mjs, with the rejection Claude Code 2.1.293 gave in a live run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MOD = `file://${path.resolve(__dirname, '../../src/mod/hooks/wake/core.mjs').split('\\').join('/')}`;
const UNBOUND = 'belay: $.prompt.submit is not available in this mode: no session is bound in this process (the REPL has not mounted and no headless session is built); catch it and carry on';
const DEATH = 'belay: worker coder-g3 died (exit 1). (ref 0a1b2c3d)';

function harness(m, { initial = '' } = {}) {
  const s = { bound: false, file: initial, writes: [], submitted: [], log: [], failWrite: false, clock: 1000 };
  s.d = m.createDelivery({
    file: 'F', initial, now: () => s.clock,
    io: {
      write: async (f, c) => { s.writes.push(c); if (s.failWrite) throw new Error('EBUSY'); s.file = c; },
      submit: async (t) => { if (!s.bound) throw new Error(UNBOUND); s.submitted.push({ t, file: s.file }); },
      log: (e) => s.log.push(e),
    },
  });
  return s;
}

test('a wake refused because no session is bound is held, its record taken back, and goes out first once a session takes it', async () => {
  const m = await import(MOD);
  const s = harness(m);
  assert.strictEqual(await s.d.deliver('w1', 'belay: worker coder-g3 finished turn 1.'), 'held');
  assert.strictEqual(await s.d.deliver('w2', 'belay: worker coder-g3 finished turn 2.'), 'held');
  for (let i = 0; i < 5; i++) assert.strictEqual(await s.d.retryPending(), 2, 'still unbound: both stay held');
  assert.deepStrictEqual(m.parseDelivered(s.file), new Set(), 'a held wake is left recorded as delivered');
  assert.deepStrictEqual([...s.d.held.keys()], ['w1', 'w2']);
  assert.deepStrictEqual(s.log.map((e) => [e.id, e.stage]), [['w1', 'held'], ['w2', 'held']], 'each held wake is logged once, not on every retry');
  assert.strictEqual(m.heldNotice(s.d.held.size), 'belay: 2 wakes not delivered: Claude Code says no session is open in this window; they are sent when it is back');
  assert.ok(m.HELD_RETRY_MS <= 5000, 'a held wake is tried again within seconds');
  s.clock += 4 * 60000; // four minutes in the background-sessions list
  s.bound = true;
  assert.strictEqual(await s.d.retryPending(), 0);
  assert.deepStrictEqual(s.submitted.map((x) => x.t), ['belay: worker coder-g3 finished turn 1.', 'belay: worker coder-g3 finished turn 2.'], 'in the order they came');
  assert.ok(s.submitted.every((x) => m.parseDelivered(x.file).size >= 1), 'an ordinary wake was submitted before its record was on disk');
  assert.deepStrictEqual(m.parseDelivered(s.file), new Set(['w1', 'w2']));
  const r = s.d.takeReleased();
  assert.deepStrictEqual(r, { n: 2, longestMs: 4 * 60000 });
  assert.strictEqual(m.releasedNotice(r.n, r.longestMs), 'belay: 2 wakes held for up to 4 min while no session was open in this window, delivered now', 'the toast names how many and how long');
  assert.deepStrictEqual(s.d.takeReleased(), { n: 0, longestMs: 0 });
  assert.deepStrictEqual(s.log.filter((e) => e.stage === 'released').map((e) => e.id), ['w1', 'w2'], 'and each is logged once more, delivered');
  assert.strictEqual(await s.d.deliver('w1', 'again'), 'skip');
});

test('after the session is back, a new wake waits behind the held ones', async () => {
  const m = await import(MOD);
  const s = harness(m);
  assert.strictEqual(await s.d.deliver('w1', 'one'), 'held');
  assert.strictEqual(await s.d.deliver('w2', 'two'), 'held');
  s.bound = true; // the REPL is back, and a new wake arrives before the retry timer fires
  assert.strictEqual(await s.d.deliver('w3', 'three'), 'submitted');
  assert.deepStrictEqual(s.submitted.map((x) => x.t), ['one', 'two', 'three'], 'the new wake overtook the held ones');
});

test('a claimed wake is submitted before it is recorded and never written while held; a failed record is written again, not submitted again', async () => {
  const m = await import(MOD);
  assert.strictEqual(m.isClaimedWake(DEATH), true);
  assert.strictEqual(m.isClaimedWake('belay: worker coder-g3 finished turn 1.'), false);
  const s = harness(m);
  assert.strictEqual(await s.d.deliver('d1', DEATH), 'held');
  await s.d.retryPending();
  assert.strictEqual(s.writes.length, 0, 'a held claimed wake wrote the delivered file');
  s.bound = true; s.failWrite = true;
  await s.d.retryPending();
  assert.deepStrictEqual(s.submitted.map((x) => x.t), [DEATH]);
  assert.strictEqual(m.parseDelivered(s.submitted[0].file).size, 0, 'the claimed wake was recorded before its submit');
  await s.d.retryPending(); await s.d.retryPending();
  assert.strictEqual(s.submitted.length, 1, 'a failed record submitted the wake again');
  assert.strictEqual(s.log.filter((e) => e.stage === 'write').length, 1, 'one log line for the failed write');
  // a reload before the record lands delivers it again: at least once, and its ref names the repeat
  const again = harness(m, { initial: s.file });
  again.bound = true;
  assert.strictEqual(await again.d.deliver('d1', DEATH), 'submitted');
  s.failWrite = false;
  assert.strictEqual(await s.d.retryPending(), 0);
  assert.deepStrictEqual(m.parseDelivered(s.file), new Set(['d1']));
});

test('an ordinary wake whose record write fails waits in order, submits nothing until the write lands, and is never duplicated', async () => {
  const m = await import(MOD);
  const s = harness(m);
  s.bound = true; s.failWrite = true;
  assert.strictEqual(await s.d.deliver('w1', 'one'), 'write-failed');
  assert.strictEqual(await s.d.deliver('w2', 'two'), 'queued', 'a later wake overtook one whose write failed');
  assert.deepStrictEqual(s.submitted, []);
  s.failWrite = false;
  assert.strictEqual(await s.d.retryPending(), 0);
  assert.deepStrictEqual(s.submitted.map((x) => x.t), ['one', 'two']);
  assert.ok(s.submitted.every((x) => m.parseDelivered(x.file).size >= 1), 'submitted before the record was on disk');
});

test('a /clear (a new session id) changes nothing the mod checks: wakes keep flowing', async () => {
  const m = await import(MOD);
  const s = harness(m);
  s.bound = true;
  assert.strictEqual(await s.d.deliver('w1', 'one'), 'submitted');
  // after a /clear Claude Code gives the window a new session id and fires no session.start; the mod knows no session id at all
  assert.strictEqual(await s.d.deliver('w2', 'two'), 'submitted');
  assert.deepStrictEqual(s.submitted.map((x) => x.t), ['one', 'two']);
  const cfg = m.activeConfig(JSON.stringify({ role: 'orchestrator', run_id: 'r', data_dir: 'd', belay_cli: 'c', node: 'n', orchestrator_dir: 'o', wake_nonce: 'x' }));
  assert.ok(cfg && !('session_id' in cfg), 'the run file carries no session id');
  const index = fs.readFileSync(path.resolve(__dirname, '../../src/mod/hooks/wake/index.ts'), 'utf8');
  assert.ok(!index.includes('$.session.id'), 'the wake hook compares the session id again: a /clear would hold every later wake');
  const launcher = fs.readFileSync(path.resolve(__dirname, '../../src/run/orchestrator-interactive.cjs'), 'utf8');
  assert.ok(!/wake_nonce: wakeNonce, session_id/.test(launcher), 'the launcher writes a session id into the plugin run file');
});

test('only "no session is bound" holds a wake; any other refusal stays recorded and is never re-run', async () => {
  const m = await import(MOD);
  assert.strictEqual(m.isUnboundSubmit(UNBOUND), true);
  assert.strictEqual(m.isUnboundSubmit('$.prompt.submit is not available in this mode: the session is read-only'), false);
  let submits = 0;
  const log = [];
  const d = m.createDelivery({ file: 'F', io: { write: async () => {}, submit: async () => { submits += 1; throw new Error('the turn was aborted'); }, log: (e) => log.push(e) } });
  assert.strictEqual(await d.deliver('x', 't'), 'submit-failed');
  assert.strictEqual(await d.deliver('x', 't'), 'skip');
  assert.strictEqual(submits, 1);
  assert.deepStrictEqual(log.map((e) => e.stage), ['submit']);
});
