'use strict';
// run-paused.test.cjs — build step 6f, design item 5,
// ADR 0023 amendment 3 decision 4.1, the shape of worker-paused.test.cjs. Through the engine
// (openCore's in-process path): `run.setPaused` appends a run row carrying `paused_at`/`paused_by`,
// refuses an ended run, a missing run and a non-boolean, and `run.attach` carries both forward across
// a reattach epoch.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch, operator;

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  operator = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
});

after(async () => {
  await operator.close();
  await orch.shutdownOwner();
  await orch.close();
  cleanup(dir);
});

// (c1)
test('run.setPaused: sets and clears paused_at and paused_by, refuses an ended run, a missing run and a non-boolean, and run.attach carries both forward', async () => {
  const initial = (await orch.run.get()).run;
  assert.strictEqual(initial.paused_at, null);
  assert.strictEqual(initial.paused_by, null);

  const t0 = Date.now();
  const paused = await orch.run.setPaused({ paused: true });
  assert.strictEqual(paused.id, 'test-run');
  assert.ok(Number.isInteger(paused.paused_at) && paused.paused_at >= t0, `paused_at ${paused.paused_at} must be an integer at or after ${t0}`);
  assert.strictEqual(paused.paused_by, 'orchestrator', 'paused_by is E.writtenBy(caller)');

  const readBack = (await orch.run.get()).run;
  assert.strictEqual(readBack.paused_at, paused.paused_at);
  assert.strictEqual(readBack.paused_by, 'orchestrator');

  // run.attach carries paused_at/paused_by forward from the previous epoch (decision 4.1) — a reattach
  // must not lose a pause the run process itself never asked to clear.
  const reattached = await orch.run.attach({ adapter_pid: process.pid });
  assert.strictEqual(reattached.run.paused_at, paused.paused_at);
  assert.strictEqual(reattached.run.paused_by, 'orchestrator');

  // operator is allowed too (ORCH_OR_OPERATOR); clearing sets both fields null.
  const resumed = await operator.run.setPaused({ paused: false });
  assert.strictEqual(resumed.paused_at, null);
  assert.strictEqual(resumed.paused_by, null);
  const reattached2 = await orch.run.attach({ adapter_pid: process.pid });
  assert.strictEqual(reattached2.run.paused_at, null, 'a cleared pause must not be revived by a later reattach');
  assert.strictEqual(reattached2.run.paused_by, null);

  // a non-boolean, or a missing `paused`, is E_ARGS and writes nothing.
  const beforeArgsSeq = (await orch.run.get()).run.seq;
  await assert.rejects(orch.run.setPaused({ paused: 'yes' }), (e) => { assert.strictEqual(e.code, 'E_ARGS'); return true; });
  await assert.rejects(orch.run.setPaused({}), (e) => { assert.strictEqual(e.code, 'E_ARGS'); return true; });
  assert.strictEqual((await orch.run.get()).run.seq, beforeArgsSeq, 'an args-refused setPaused must not write a row');

  // a missing run: caller.run_id names no run row at all.
  const noRunCore = await openCore({ dataDir: dir, caller: { role: 'operator', run_id: 'no-such-run', pid: process.pid }, embed: false });
  try {
    await assert.rejects(noRunCore.run.setPaused({ paused: true }), (e) => { assert.strictEqual(e.code, 'E_NOT_FOUND'); return true; });
  } finally { await noRunCore.close(); }

  // 6f-2 design item 4 (should-fix, methods-run.cjs:77, first review 1b): a pause ends with its run —
  // run.end nulls paused_at/paused_by even on a run that was paused the moment it ended, and a reattach
  // afterwards must not carry that pause into the next epoch (probe `stale`'s own scenario).
  await orch.run.setPaused({ paused: true });
  const endedRow = await orch.run.end({ exit_reason: 'test done' });
  assert.strictEqual(endedRow.paused_at, null, 'run.end must null paused_at even on a run that was paused');
  assert.strictEqual(endedRow.paused_by, null, 'run.end must null paused_by even on a run that was paused');

  // an ended run refuses E_ARGS, whatever its own pause state.
  await assert.rejects(orch.run.setPaused({ paused: true }), (e) => { assert.strictEqual(e.code, 'E_ARGS'); return true; });

  const reattached3 = await orch.run.attach({ adapter_pid: process.pid });
  assert.strictEqual(reattached3.run.paused_at, null, 'run.attach must carry a pause forward only from an epoch that has not ended');
  assert.strictEqual(reattached3.run.paused_by, null);

  // build step 6i item 8 (C8): a legacy row from before 6f-2 item 4 — ended, yet still carrying
  // paused_at/paused_by, which run.end itself can no longer produce, but which a store written before
  // that fix (or planted directly, as here) still can. run.attach's own `carryPause` (methods-run.cjs)
  // must key on `ended_at`, not merely reuse whatever the previous row happened to answer.
  const prevRow = (await orch.run.get()).run;
  orch.owner.store.db.prepare(
    'INSERT INTO run(id, epoch, orchestrator_pid, adapter_pid, started_at, ended_at, exit_reason, paused_at, paused_by, written_at, written_by) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(prevRow.id, prevRow.epoch, prevRow.orchestrator_pid, prevRow.adapter_pid, prevRow.started_at, Date.now(), 'legacy ended row', Date.now(), 'legacy-writer', Date.now(), 'test-legacy-fixture');
  const legacyRow = (await orch.run.get()).run;
  assert.ok(legacyRow.ended_at != null && legacyRow.paused_at != null, 'the planted legacy row must itself carry both ended_at and paused_at');

  const reattached4 = await orch.run.attach({ adapter_pid: process.pid });
  assert.strictEqual(reattached4.run.paused_at, null, 'run.attach must never carry paused_at forward from an ended row, legacy or not');
  assert.strictEqual(reattached4.run.paused_by, null);
});

// (c2) build step 6i-2 design item 1 (ADR 0023 amendment 4 decisions 1, 3): run.setPaused validates
// `parks` at the boundary (src/core/pause-parks.cjs); run.attach carries `pause_parks` forward with the
// pause; `paused: false` and `run.end` clear it. A run of its own (module `dir` above ends at (c1)).
test('run.setPaused: refuses a malformed parks naming the field; run.attach carries pause_parks with the pause; paused: false and run.end clear it', async () => {
  const dir2 = sandbox();
  const orch2 = await openCore({ dataDir: dir2, caller: callerFor('orchestrator'), embed: false });
  try {
    await orch2.run.attach({ adapter_pid: process.pid });

    await assert.rejects(orch2.run.setPaused({ paused: true, parks: 'nope' }), (e) => { assert.strictEqual(e.code, 'E_ARGS'); return true; });
    await assert.rejects(
      orch2.run.setPaused({ paused: true, parks: { parked: [{ worker_id: 'w1', paused_at: 'nope', paused_by: 'x:1' }], already_parked: [], unconfirmed: [] } }),
      (e) => { assert.strictEqual(e.code, 'E_ARGS'); assert.strictEqual(e.detail.field, 'parked'); return true; },
    );
    await assert.rejects(
      orch2.run.setPaused({ paused: true, parks: { parked: [], already_parked: [], unconfirmed: [123] } }),
      (e) => { assert.strictEqual(e.code, 'E_ARGS'); assert.strictEqual(e.detail.field, 'unconfirmed'); return true; },
    );
    // item d (R-review: a 1 MB worker_id was accepted): worker_id and paused_by are capped at 256 chars
    // (src/core/pause-parks.cjs); over the cap is E_ARGS naming the offending list, not silently stored.
    await assert.rejects(
      orch2.run.setPaused({ paused: true, parks: { parked: [{ worker_id: 'w'.repeat(1024 * 1024), paused_at: 1, paused_by: 'x:1' }], already_parked: [], unconfirmed: [] } }),
      (e) => { assert.strictEqual(e.code, 'E_ARGS'); assert.strictEqual(e.detail.field, 'parked'); return true; },
    );
    await assert.rejects(
      orch2.run.setPaused({ paused: true, parks: { parked: [], already_parked: [], unconfirmed: ['w'.repeat(1024 * 1024)] } }),
      (e) => { assert.strictEqual(e.code, 'E_ARGS'); assert.strictEqual(e.detail.field, 'unconfirmed'); return true; },
    );
    // fix-up (b): parks is accepted only with paused: true; given with paused: false it is refused, not
    // silently dropped (src/core/pause-parks.cjs's resolveParks).
    await assert.rejects(
      orch2.run.setPaused({ paused: false, parks: { parked: [], already_parked: [], unconfirmed: [] } }),
      (e) => { assert.strictEqual(e.code, 'E_ARGS'); assert.strictEqual(e.detail.field, 'parks'); return true; },
    );
    assert.strictEqual((await orch2.run.get()).run.paused_at, null, 'a refused setPaused must not write a row');

    const parks = {
      parked: [{ worker_id: 'w1', paused_at: 1000, paused_by: 'operator:1' }],
      already_parked: [{ worker_id: 'w2', paused_at: 500, paused_by: 'operator:1' }],
      unconfirmed: ['w3'],
    };
    const paused = await orch2.run.setPaused({ paused: true, at: 2000, by: 'operator:1', parks });
    assert.deepStrictEqual(paused.pause_parks, parks, 'pause_parks is bound and returned as an object, never a string the caller parses');

    const readBack = (await orch2.run.get()).run;
    assert.deepStrictEqual(readBack.pause_parks, parks);

    const reattached = await orch2.run.attach({ adapter_pid: process.pid });
    assert.deepStrictEqual(reattached.run.pause_parks, parks, 'run.attach carries pause_parks forward with paused_at/paused_by');
    // item c: `previous` (methods-run.cjs's attach) is rows.current's raw row, unparsed unlike `run` —
    // its pause_parks must come back an object too, as get and list already return it, never a string.
    assert.strictEqual(typeof reattached.previous.pause_parks, 'object', 'reattached.previous.pause_parks must be parsed, not a raw string');
    assert.deepStrictEqual(reattached.previous.pause_parks, parks);

    const resumed = await orch2.run.setPaused({ paused: false });
    assert.strictEqual(resumed.pause_parks, null);

    await orch2.run.setPaused({ paused: true, at: 3000, by: 'operator:1', parks });
    const ended = await orch2.run.end({ exit_reason: 'test done' });
    assert.strictEqual(ended.pause_parks, null, 'run.end must null pause_parks even on a run paused with parks the moment it ends');
  } finally { await orch2.shutdownOwner(); await orch2.close(); cleanup(dir2); }
});
