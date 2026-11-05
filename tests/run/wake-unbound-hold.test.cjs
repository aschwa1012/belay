'use strict';
require('../helpers/tmp.cjs');
// wake-unbound-hold.test.cjs — the interactive orchestrator's wake while its session is not bound. Opening Claude Code's
// background-sessions list unmounts the orchestrator's REPL, and from then on `$.prompt.submit` rejects with "not available in this
// mode: no session is bound in this process". The mod had already recorded each wake as delivered, so every wake from then on was
// lost. Now a wake is submitted first and recorded after, a wake that cannot be submitted is held without a write, and held wakes go
// out first, in order, when the session is back. The real core.mjs, with the rejection Claude Code 2.1.293 gave in a live run.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const MOD = `file://${path.resolve(__dirname, '../../src/mod/hooks/wake/core.mjs').split('\\').join('/')}`;
const UNBOUND = 'belay: $.prompt.submit is not available in this mode: no session is bound in this process (the REPL has not mounted and no headless session is built); catch it and carry on';

function harness(m, { initial = '', bound = null } = {}) {
  const s = { bound: false, file: initial, writes: 0, submitted: [], log: [], failWrite: false };
  s.d = m.createDelivery({
    file: 'F', initial,
    io: {
      write: async (f, c) => { s.writes += 1; if (s.failWrite) throw new Error('EBUSY'); s.file = c; },
      submit: async (t) => { if (!s.bound) throw new Error(UNBOUND); s.submitted.push(t); },
      log: (e) => s.log.push(e),
      ...(bound ? { bound } : {}),
    },
  });
  return s;
}

test('a wake refused because no session is bound is held with nothing written, and goes out once a session takes it', async () => {
  const m = await import(MOD);
  const s = harness(m);
  assert.strictEqual(await s.d.deliver('w1', 'belay: worker coder-g3 finished turn 1.'), 'held');
  assert.strictEqual(await s.d.deliver('w2', 'belay: worker coder-g3 finished turn 2.'), 'held');
  for (let i = 0; i < 5; i++) assert.strictEqual(await s.d.retryPending(), 2, 'still unbound: both stay held');
  assert.strictEqual(s.writes, 0, 'a held wake wrote the delivered file');
  assert.deepStrictEqual(m.parseDelivered(s.file), new Set());
  assert.deepStrictEqual([...s.d.held], ['w1', 'w2']);
  assert.deepStrictEqual(s.log.map((e) => [e.id, e.stage]), [['w1', 'held'], ['w2', 'held']], 'each held wake is logged once, not on every retry');
  assert.strictEqual(m.heldNotice(s.d.held.size, s.d.heldWhy), 'belay: 2 wakes not delivered: Claude Code says no session is open in this window; they are sent when the orchestrator session is back');
  assert.ok(m.HELD_RETRY_MS <= 5000, 'a held wake is tried again within seconds');
  s.bound = true;
  assert.strictEqual(await s.d.retryPending(), 0);
  assert.deepStrictEqual(s.submitted, ['belay: worker coder-g3 finished turn 1.', 'belay: worker coder-g3 finished turn 2.'], 'in the order they came');
  assert.deepStrictEqual(m.parseDelivered(s.file), new Set(['w1', 'w2']));
  assert.strictEqual(s.d.held.size, 0);
  assert.strictEqual(s.d.takeReleased(), 2, 'the toast counts the held wakes that went out');
  assert.strictEqual(s.d.takeReleased(), 0);
  assert.deepStrictEqual(s.log.filter((e) => e.stage === 'released').map((e) => e.id), ['w1', 'w2'], 'and each is logged once more, delivered');
  assert.strictEqual(await s.d.deliver('w1', 'again'), 'skip', 'at most once in this process');
});

test('after the session is back, a new wake waits behind the held ones', async () => {
  const m = await import(MOD);
  const s = harness(m);
  assert.strictEqual(await s.d.deliver('w1', 'one'), 'held');
  assert.strictEqual(await s.d.deliver('w2', 'two'), 'held');
  s.bound = true; // the REPL is back, and a new wake arrives before the retry timer fires
  assert.strictEqual(await s.d.deliver('w3', 'three'), 'submitted');
  assert.deepStrictEqual(s.submitted, ['one', 'two', 'three'], 'the new wake overtook the held ones');
});

test('a record write that fails after the submit is written again and never submitted again; a reload re-delivers it', async () => {
  const m = await import(MOD);
  const s = harness(m);
  s.bound = true; s.failWrite = true;
  assert.strictEqual(await s.d.deliver('w1', 'one'), 'submitted');
  await s.d.retryPending(); await s.d.retryPending();
  assert.deepStrictEqual(s.submitted, ['one']);
  assert.deepStrictEqual(s.log.map((e) => e.stage), ['write'], 'one log line for the failed write');
  // the mod reloads before the write lands: the file never named w1, so the new load submits it again (at least once; its ref id says so)
  const again = harness(m, { initial: s.file });
  again.bound = true;
  assert.strictEqual(await again.d.deliver('w1', 'one'), 'submitted');
  s.failWrite = false;
  assert.strictEqual(await s.d.retryPending(), 0);
  assert.deepStrictEqual(m.parseDelivered(s.file), new Set(['w1']));
});

test('a window holding a session that is not the orchestrator\'s holds the wake without submitting it', async () => {
  const m = await import(MOD);
  let mine = false;
  const s = harness(m, { bound: async () => mine });
  s.bound = true; // a submit would be accepted, but into the wrong session
  assert.strictEqual(await s.d.deliver('w1', 'one'), 'held');
  assert.deepStrictEqual(s.submitted, [], 'a wake was submitted into another session');
  assert.strictEqual(s.d.heldWhy, 'other-session');
  assert.match(m.heldNotice(1, s.d.heldWhy), /holds a session that is not the orchestrator session; it is sent/);
  mine = true;
  await s.d.retryPending();
  assert.deepStrictEqual(s.submitted, ['one']);
  const throwing = harness(m, { bound: async () => { throw new Error('no session'); } });
  throwing.bound = true;
  assert.strictEqual(await throwing.d.deliver('w1', 'one'), 'held', 'a session id that cannot be read holds the wake');
});

test('only "no session is bound" holds a wake; any other refusal is recorded and never re-run', async () => {
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
