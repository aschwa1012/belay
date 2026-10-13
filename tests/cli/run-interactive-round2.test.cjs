'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// run-interactive-round2.test.cjs — the launcher-side fixes of Opus review round 2 (ADR 0037): F1 through the real
// gate and the fake claude, F3 (the gate-failure kill is by pid, no tree), F7 (the fast close's bounds), F8 (wording
// and strict integers), and the L6 test gap (a stop whose kill was not delivered claims nothing).

const { test } = require('node:test');
const assert = require('node:assert');

const H = require('./stop-helpers.cjs');
const P = require('../../src/run/process.cjs');
const cmdRun = require('../../src/cli/cmd-run.cjs');
const cmdStop = require('../../src/cli/cmd-stop.cjs');
const RI = require('../../src/cli/run-interactive.cjs');
const { makeConsole } = require('../../src/run/orchestrator-interactive.cjs');
const { FAKE, makeSpec, fakeGate, start, withRun } = require('./run-interactive-helpers.cjs');

const { ROOT, sleep, waitUntil, currentRunRow } = H;

// ------------------------------------------------------------------ F1: through the real gate and the fake claude

async function realRun(dir, env) {
  const { specPath } = makeSpec(dir);
  const saved = { ...process.env };
  Object.assign(process.env, { BELAY_CLAUDE_EXE: FAKE, CLAUDE_CONFIG_DIR: `${dir}/claude-config`, FAKE_RECORD_FILE: `${dir}/rec.json`, FAKE_HOLD_MS: '1500', ...env });
  try { return await cmdRun.run({ argv: [specPath], cwd: ROOT, dataDir: `${dir}/.belay`, json: true }); } finally { process.env = saved; }
}

test('F1: a turn whose user entry has no origin and whose debug log has no cc_prompt_index is not "operator quit": no reply is exit 1', async (t) => withRun(t, async (dir) => {
  const res = await realRun(dir, { FAKE_NO_ORIGIN: '1', FAKE_NO_DEBUG_PROMPT: '1', FAKE_NO_ASSISTANT: '1' });
  assert.strictEqual(res.code, 1, res.text);
  assert.ok(!/operator quit/.test(res.json.ended_by), res.json.ended_by);
  assert.match(res.json.ended_by, /^surface gate failed \(session\): no_assistant_reply_before_exit/);
  assert.notStrictEqual(res.json.orchestrator.interactive.gate.status, 'not reached');
}));

test('F1: the same turn with its reply passes the gate (it is checked, not skipped as "not reached")', async (t) => withRun(t, async (dir) => {
  const res = await realRun(dir, { FAKE_NO_ORIGIN: '1', FAKE_NO_DEBUG_PROMPT: '1' });
  assert.strictEqual(res.code, 0, res.text);
  assert.strictEqual(res.json.orchestrator.interactive.gate.status, 'passed');
  assert.strictEqual(typeof res.json.orchestrator.interactive.gate.first_message_at, 'number');
}));

for (const [label, env] of [['missing', { FAKE_NO_DEBUG_FILE: '1' }], ['empty', { FAKE_EMPTY_DEBUG: '1' }]]) {
  test(`F1: a ${label} debug file after a turn is exit 1 naming debug_file_missing`, async (t) => withRun(t, async (dir) => {
    const res = await realRun(dir, env);
    assert.strictEqual(res.code, 1, res.text);
    assert.match(res.json.ended_by, /^surface gate failed \(debug\): debug_file_missing/);
  }));
  test(`F1: a ${label} debug file with no turn is a quit before the session was reached (nothing else can fail before it)`, async (t) => withRun(t, async (dir) => {
    const res = await realRun(dir, { ...env, FAKE_NO_FIRST: '1' });
    assert.strictEqual(res.code, 0, res.text);
    assert.strictEqual(res.json.ended_by, 'operator quit before the first message');
    assert.strictEqual(res.json.orchestrator.interactive.gate.status, 'not reached');
  }));
}

test('trust dialog declined (decision 9): claude exits 1 before the session started: exit 1, "exited before the session started (code 1)", gate not reached', async (t) => withRun(t, async (dir) => {
  const res = await realRun(dir, { FAKE_NO_FIRST: '1', FAKE_EXIT_CODE: '1', FAKE_HOLD_MS: '300' });
  assert.strictEqual(res.code, 1, res.text);
  assert.strictEqual(res.json.ended_by, 'claude exited before the session started (code 1)');
  assert.strictEqual(res.json.orchestrator.interactive.gate.status, 'not reached');
  assert.strictEqual(res.json.orchestrator.exit_code, 1);
}));

test('a leak line before the session is reached still fails at once and the status says failed, never "not reached"', async (t) => withRun(t, async (dir) => {
  const res = await realRun(dir, { FAKE_NO_FIRST: '1', FAKE_LEAK: '1', FAKE_NEVER_EXIT: '1' });
  assert.strictEqual(res.code, 1, res.text);
  assert.match(res.json.ended_by, /^surface gate failed \(debug\)/);
  assert.strictEqual(res.json.orchestrator.interactive.gate.status, 'failed');
}));

// ------------------------------------------------------------------ F3: the gate-failure kill is by pid, no tree

test('F3: a gate failure ends claude with killPid on its exact pid and never a tree kill', async (t) => withRun(t, async (dir) => {
  // The pid comes from the injected killPid call, not from the fake's own record (T1). Any call to P.killTree, by
  // anyone, is a failure: the spy records it and throws (M11), and the module's own function is restored after.
  const pidCalls = []; const treeCalls = [];
  const realTree = P.killTree;
  P.killTree = (...a) => { treeCalls.push(a); throw new Error('P.killTree was called'); };
  const deps = { killPid: (target, sig) => { pidCalls.push(target.pid); return P.killPid(target, sig); } };
  const gate = fakeGate({ debug: { ok: false, failed: 'skills', detail: '2 skills loaded' }, debugMs: 100 });
  const r = start(dir, { gate, deps, env: { FAKE_NEVER_EXIT: '1' } });
  try {
    const res = await r.done;
    assert.deepStrictEqual(treeCalls, [], 'something called P.killTree');
    assert.strictEqual(pidCalls.length, 1, 'claude was not killed by killPid, exactly once');
    assert.strictEqual(pidCalls[0], res.json.orchestrator.pid, 'the killPid pid is not the pid the receipt names for claude');
    assert.match(res.json.ended_by, /^surface gate failed \(debug\): skills/);
    assert.strictEqual(res.code, 1);
    assert.ok(!P.pidAlive(pidCalls[0]));
  } finally {
    P.killTree = realTree;
    const rec = r.record();
    // no post-exit signal (ADR 0039): the run closes its own claude
    await r.done.catch(() => {});
  }
}));

// ------------------------------------------------------------------ L6 test gap

test('L6: a stop whose kill was not delivered (signalled false) sets no stop cause and ended_by tells what happened', async (t) => withRun(t, async (dir) => {
  const pidCalls = [];
  const deps = { killPid: (target) => { pidCalls.push(target.pid); return { signalled: false }; } };
  const r = start(dir, { env: { FAKE_HOLD_MS: '1500' }, deps });
  const rec = await waitUntil(() => r.record(), 15000);
  assert.ok(rec);
  assert.ok(await waitUntil(() => currentRunRow(r.dataDir, r.runId), 15000));
  await cmdStop.run({ argv: [r.runId], cwd: ROOT, dataDir: r.dataDir, json: true });
  const res = await r.done;
  assert.deepStrictEqual(pidCalls, [rec.pid], 'the stop never tried the kill');
  assert.ok(!/ended by its pid/.test(res.json.ended_by), res.json.ended_by);
  assert.ok(!/^stopped by belay stop/.test(res.json.ended_by), 'a stop that ended nothing claims the stop as the cause');
  assert.match(res.json.ended_by, /^claude exited \(code 0\)$/);
}));

// ------------------------------------------------------------------ F7: the fast close's bounds

// A console with a SIGHUP recorded now. Disposed by the caller.
function hupped() {
  const ce = makeConsole();
  ce.install();
  process.emit('SIGHUP');
  return ce;
}
const never = () => new Promise(() => {});
const slow = (ms, v) => new Promise((r) => { setTimeout(() => r(v), ms).unref(); });

test('F7: run.get is bounded by the fast close budget and leaves time for the shutdown and run.json', async () => {
  const ce = hupped();
  try {
    const core = { run: { end: async () => ({ epoch: 1 }), get: () => slow(30000, { run: {} }) } };
    const late = [];
    const t0 = Date.now();
    const out = await RI.endRun({ core, ce, runId: 'r', exitReason: 'x', usage: null, reviewRounds: { value: null, reason: 'never' }, countReviewRounds: async () => ({ value: 1, reason: null }), late: (m) => late.push(m) });
    assert.ok(Date.now() - t0 < 15000, `run.get held the close for ${Date.now() - t0} ms`); // the budget cuts it near 3 s; the stub would hold it 30 s
    assert.deepStrictEqual(out.endedRow, { epoch: 1 });
    assert.strictEqual(out.gotRun, null);
    assert.ok(late.some((m) => /run\.get/.test(m)), JSON.stringify(late));
    assert.ok(ce.leftMs(0) >= 450, `only ${ce.leftMs(0)} ms were left for the owner shutdown and run.json`);
  } finally { ce.dispose(); }
});

test('F7: a cut review count says "not counted: fast-close budget", never "never attached"', async () => {
  const ce = hupped();
  try {
    const core = { run: { end: async () => ({ epoch: 1 }), get: async () => ({ run: {} }) } };
    const late = [];
    const t0 = Date.now();
    const out = await RI.endRun({ core, ce, runId: 'r', exitReason: 'x', usage: null, reviewRounds: { value: null, reason: 'the run was never attached, so no tasks were read' }, countReviewRounds: () => slow(30000, { value: 3, reason: null }), late: (m) => late.push(m) });
    assert.ok(Date.now() - t0 < 15000); // the budget cuts it near 3 s; the stub would hold it 30 s
    assert.strictEqual(out.reviewRounds.value, null);
    assert.strictEqual(out.reviewRounds.reason, 'not counted: fast-close budget');
    assert.ok(!/never attached/.test(JSON.stringify(out.reviewRounds)));
  } finally { ce.dispose(); }
});

test('F7: the owner shutdown keeps its reserve AT ITS CALL SITE in cmd-run: a run passes a reserve of 100 ms or more and under the end reserve', async (t) => withRun(t, async (dir) => {
  // cmd-run calls RI.within(ce, core.shutdownOwner(), 'the owner shutdown', fallback, late, reserve) (M9): the
  // reserve is read from the argument the real call passes, not from the constant beside it.
  const realWithin = RI.within;
  const reserves = [];
  RI.within = (ce, p, what, fb, late, ...rest) => { if (what === 'the owner shutdown') reserves.push(rest.length ? rest[0] : 'default'); return realWithin(ce, p, what, fb, late, ...rest); };
  try {
    const res = await start(dir, {}).done;
    assert.strictEqual(res.code, 0, res.text);
  } finally { RI.within = realWithin; }
  assert.strictEqual(reserves.length, 1, 'the owner shutdown was not bounded through RI.within');
  assert.strictEqual(typeof reserves[0], 'number', 'the call site passed no reserve (the default is the 1300 ms of the kills)');
  assert.ok(reserves[0] >= 100 && reserves[0] < RI.END_RESERVE_MS, `reserve ${reserves[0]}`);
}));

test('F7: within() cuts at the budget less the reserve it is given, not at the default reserve or the whole budget', async () => {
  const ce = hupped();
  try {
    const t0 = Date.now();
    // A reserve of 3300 ms cuts near 200 ms into the 3500 ms budget; the default reserve (FAST_RESERVE_MS, 1300) would cut
    // at 2200 and no reserve at 3500. A bound of 1500 sits 1300 ms above the cut and 700 ms below the default's.
    const v = await RI.within(ce, never(), 'the owner shutdown', 'cut', () => {}, 3300);
    const ms = Date.now() - t0;
    assert.strictEqual(v, 'cut');
    assert.ok(ms < 1500, `the shutdown was held ${ms} ms, past the given reserve's cut (default would be 2200, none 3500)`);
  } finally { ce.dispose(); }
});

test('F7: without a console the close is plain: nothing is cut (headless is unchanged)', async () => {
  const out = await RI.endRun({
    core: { run: { end: async () => ({ epoch: 2 }), get: async () => { await sleep(50); return { run: { epoch: 2 } }; } } },
    ce: null, runId: 'r', exitReason: 'x', usage: null, reviewRounds: { value: null, reason: 'a' },
    countReviewRounds: async () => ({ value: 4, reason: null }), late: () => { throw new Error('late called'); },
  });
  assert.deepStrictEqual(out.reviewRounds, { value: 4, reason: null });
  assert.deepStrictEqual(out.gotRun, { run: { epoch: 2 } });
  assert.deepStrictEqual(out.errors, []);
});

test('F7: after a SIGHUP a claude that does not exit is ended by its pid within the budget, and the receipt says so', async (t) => withRun(t, async (dir) => {
  const r = start(dir, { env: { FAKE_NEVER_EXIT: '1' } });
  const rec = await waitUntil(() => r.record(), 15000);
  assert.ok(rec);
  assert.ok(await waitUntil(() => currentRunRow(r.dataDir, r.runId), 15000));
  const hupAt = Date.now();
  process.emit('SIGHUP');
  try {
    const res = await r.done;
    const ms = Date.now() - hupAt;
    // The design bound is 3500 ms, and a loaded host runs well past it. What this separates is a close that waits on a
    // claude that never exits (the run's own timeout is far longer), so 15 s.
    assert.ok(ms < 15000, `the close took ${ms} ms after the SIGHUP`);
    assert.strictEqual(res.code, 1);
    assert.match(res.json.ended_by, /^claude did not exit within the fast close budget; claude ended by its pid; then console closed \(fast close\)$/);
    assert.ok(!P.pidAlive(rec.pid));
    assert.ok(currentRunRow(r.dataDir, r.runId).ended_at != null);
  } finally { await r.done.catch(() => {}); }
}));

// ------------------------------------------------------------------ F8: wording and integers

const failureEvent = (over = {}) => ({ worker: 'orchestrator', call: 'memory.store', code: 'E_TIMEOUT', cause: 'timeout', action: 'pause', pause: null, ...over });
const linesFor = (events) => RI.embedderLines({ mode: 'interactive', embedder: null, embedder_failures: RI.interactiveEmbedder(() => {}).annotate(events) });

test('F8: an embedder failure whose stop the fast close cut does not say "run continued"', () => {
  const [line] = linesFor([failureEvent()]);
  assert.ok(!/run continued/.test(line), line);
  assert.match(line, /stop requested, not confirmed: the fast close cut the wait/);
  const [fatal] = linesFor([failureEvent({ action: 'stop' })]);
  assert.ok(!/run continued/.test(fatal), fatal);
  const [cont] = linesFor([failureEvent({ action: 'continue' })]);
  assert.match(cont, /run continued/, 'a lever of continue still says so');
});

test('F8: a stop refused because claude had already exited is not "run NOT ended"', () => {
  const [line] = linesFor([failureEvent({ action: 'stop', stop: { ok: false, error: 'the run\'s orchestrator (pid 12) already exited: claude exited (code 0)' } })]);
  assert.ok(!/run NOT ended/.test(line), line);
  assert.match(line, /claude had already exited/);
  const [other] = linesFor([failureEvent({ action: 'stop', stop: { ok: false, error: 'no orchestrator to stop yet' } })]);
  assert.match(other, /run NOT ended: no orchestrator to stop yet/);
});

// N3: a headless run's wording is d226f9a's, byte for byte. The "already exited" branch is the interactive run's only.
test('N3: the headless failure lines are d226f9a\'s wording exactly, "already exited" included', () => {
  const head = 'embedder failure: orchestrator, memory.store, E_TIMEOUT (timeout); ';
  const ev = (over) => ({ worker: 'orchestrator', call: 'memory.store', code: 'E_TIMEOUT', cause: 'timeout', ...over });
  const lines = (events) => RI.embedderLines({ embedder: null, embedder_failures: events });
  assert.deepStrictEqual(lines([ev({ action: 'stop', stop: { ok: false, error: 'the run\'s orchestrator (pid 12) already exited: claude exited (code 0)' } })]),
    [`${head}run NOT ended: the run's orchestrator (pid 12) already exited: claude exited (code 0)`]);
  assert.deepStrictEqual(lines([ev({ action: 'stop', stop: { ok: true } })]), [`${head}run ended (cannot be fixed inside a run)`]);
  assert.deepStrictEqual(lines([ev({ action: 'pause', pause: { ok: false, error: 'x' } })]), [`${head}run NOT paused: x`]);
  assert.deepStrictEqual(lines([ev({ action: 'continue' })]), [`${head}run continued`]);
});

test('F8: interactive_surface_ms must be a positive integer number, not a boolean or a string', () => {
  for (const key of ['interactive_surface_ms']) {
    for (const bad of [true, false, '5', '', 0, -1, 1.5, null, [1]]) {
      const r = RI.parseModeKeys({ [key]: bad });
      assert.match(r.error || '', new RegExp(`${key} must be a positive integer`), `${key}=${JSON.stringify(bad)}`);
    }
    assert.strictEqual(RI.parseModeKeys({ [key]: 1234 }).fields[key], 1234);
  }
});
