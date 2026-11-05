'use strict';
require('../helpers/tmp.cjs');
// wake-unbound-hold.test.cjs — the interactive orchestrator's wake while its session is not bound. Opening Claude Code's
// background-sessions list unmounts the orchestrator's REPL, and from then on `$.prompt.submit` rejects with "not available in this
// mode: no session is bound in this process". Nothing was submitted, yet the mod had already recorded the wake as delivered, so every
// wake from then on was lost. The real core.mjs, with the rejection Claude Code 2.1.293 gave in a live run.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const MOD = `file://${path.resolve(__dirname, '../../src/mod/hooks/wake/core.mjs').split('\\').join('/')}`;
const UNBOUND = 'belay: $.prompt.submit is not available in this mode: no session is bound in this process (the REPL has not mounted and no headless session is built); catch it and carry on';

function harness(m, initial = '') {
  const s = { bound: false, file: initial, submitted: [], log: [] };
  s.d = m.createDelivery({
    file: 'F', initial,
    io: {
      write: async (f, c) => { s.file = c; },
      submit: async (t) => { if (!s.bound) throw new Error(UNBOUND); s.submitted.push(t); },
      log: (e) => s.log.push(e),
    },
  });
  return s;
}

test('a wake refused because no session is bound is held, not recorded, and submitted once a session takes it', async () => {
  const m = await import(MOD);
  const s = harness(m);
  assert.strictEqual(await s.d.deliver('w1', 'belay: worker coder-g3 finished turn 1.'), 'held');
  assert.strictEqual(await s.d.deliver('w2', 'belay: worker coder-g3 finished turn 2.'), 'held');
  assert.strictEqual(s.d.delivered.has('w1'), false, 'a wake that was never submitted is recorded as delivered');
  assert.deepStrictEqual(m.parseDelivered(s.file), new Set(), 'the delivered file names a wake that was never submitted');
  assert.deepStrictEqual([...s.d.pending.keys()], ['w1', 'w2']);
  assert.deepStrictEqual(s.log.map((e) => [e.id, e.stage, e.held]), [['w1', 'submit', true], ['w2', 'submit', true]]);
  assert.strictEqual(await s.d.retryPending(), 2, 'still unbound: both stay held');
  s.bound = true;
  assert.strictEqual(await s.d.retryPending(), 0);
  assert.deepStrictEqual(s.submitted, ['belay: worker coder-g3 finished turn 1.', 'belay: worker coder-g3 finished turn 2.'], 'in the order they came');
  assert.deepStrictEqual(m.parseDelivered(s.file), new Set(['w1', 'w2']));
  assert.strictEqual(await s.d.deliver('w1', 'again'), 'skip', 'at most once, after it landed');
  assert.strictEqual(s.submitted.length, 2);
});

test('a held wake keeps the earlier records, and any other submit failure is still never re-run', async () => {
  const m = await import(MOD);
  const s = harness(m, m.deliveredLine('old', 1));
  assert.strictEqual(await s.d.deliver('w1', 't'), 'held');
  assert.deepStrictEqual(m.parseDelivered(s.file), new Set(['old']), 'the retraction took an earlier record with it');
  assert.strictEqual(m.isUnboundSubmit(UNBOUND), true);
  assert.strictEqual(m.isUnboundSubmit('no prompt'), false);
  let submits = 0;
  const d = m.createDelivery({ file: 'F', io: { write: async () => {}, submit: async () => { submits += 1; throw new Error('the turn was aborted'); }, log: () => {} } });
  assert.strictEqual(await d.deliver('x', 't'), 'submit-failed');
  assert.strictEqual(await d.deliver('x', 't'), 'skip');
  assert.strictEqual(submits, 1);
});
