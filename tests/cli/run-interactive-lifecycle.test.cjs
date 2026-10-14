'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// run-interactive-lifecycle.test.cjs — the fixes to ADR 0037's interactive-run lifecycle (findings L1 to L9, G3,
// G5, G9 and the two test gaps M7, M8). Same scaffolding as run-interactive.test.cjs (run-interactive-helpers.cjs):
// `belay run` driven in this process against the interactive stub, the gate a fake of the new contract.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const H = require('./stop-helpers.cjs');
const P = require('../../src/run/process.cjs');
const cmdStop = require('../../src/cli/cmd-stop.cjs');
const { closeRunWorkers } = require('../../src/cli/run-close.cjs');
const { renderText } = require('../../src/cli/cmd-run.cjs');
const RI = require('../../src/cli/run-interactive.cjs');
const { MARKER, fakeGate, start, sleeper, withRun } = require('./run-interactive-helpers.cjs');

const { ROOT, sleep, waitUntil, currentRunRow } = H;

const embedderError = () => Object.assign(new Error('the model did not load'), { code: 'E_TIMEOUT', detail: { embedder: true, cause: 'timeout' } });
const failure = () => ({ caller: { role: 'orchestrator' }, by: 'orchestrator', call: 'memory.store', error: embedderError() });
const NOTE = 'pause unavailable interactively; stopped instead';

// ------------------------------------------------------------------ L1: an embedder failure is never silently degraded

test('L1: under on_embedder_failure stop, a failure that would pause stops the run, says so, and exits 1', async (t) => withRun(t, async (dir) => {
  let guard;
  const r = start(dir, { env: { FAKE_NEVER_EXIT: '1' }, specOverrides: { on_embedder_failure: 'stop' }, deps: { onGuard: (g) => { guard = g; } } });
  const rec = await waitUntil(() => r.record(), 15000);
  assert.ok(rec, 'the stub never started');
  assert.ok(await waitUntil(() => currentRunRow(r.dataDir, r.runId), 15000), 'no run row');
  await guard.onFailure(failure());
  const res = await r.done;
  assert.strictEqual(res.code, 1, res.text);
  assert.ok(!P.pidAlive(rec.pid), 'claude outlived the stop');
  const f = res.json.embedder_failures[0];
  assert.strictEqual(f.stop.ok, true);
  assert.strictEqual(f.note, NOTE);
  assert.strictEqual(f.pause, null, 'the receipt claims a pause that never happened');
  assert.match(res.text, new RegExp(`embedder failure: orchestrator, memory.store, E_TIMEOUT \\(timeout\\); ${NOTE}: run ended`));
  assert.ok(!/no orchestrator to pause/.test(JSON.stringify(res.json)) && !/no orchestrator to pause/.test(res.text));
  assert.match(res.json.ended_by, new RegExp(`^embedder-failure \\(orchestrator, memory.store, E_TIMEOUT, timeout\\): ${NOTE}; claude ended by its pid$`));
}));

test('L1: on_embedder_failure continue stays as chosen: the failure is recorded, the run goes on and exits 0', async (t) => withRun(t, async (dir) => {
  let guard;
  const r = start(dir, { env: { FAKE_HOLD_MS: '1200' }, deps: { onGuard: (g) => { guard = g; } } });
  assert.ok(await waitUntil(() => r.record(), 15000));
  assert.ok(await waitUntil(() => currentRunRow(r.dataDir, r.runId), 15000));
  await guard.onFailure(failure());
  const res = await r.done;
  assert.strictEqual(res.code, 0, res.text);
  assert.strictEqual(res.json.embedder_failures.length, 1);
  assert.match(res.text, /embedder failure: orchestrator, memory.store, E_TIMEOUT \(timeout\); run continued/);
}));

test('L1: a failure whose stop could not run (nothing to stop yet) is neither stopped nor continued: exit 1, run NOT ended', async (t) => withRun(t, async (dir) => {
  const r = start(dir, {
    env: { FAKE_HOLD_MS: '300' }, specOverrides: { on_embedder_failure: 'stop' },
    deps: { onGuard: (g) => { g.onFailure(failure()); } }, // before the spawn: stopControl has no orchestrator yet
  });
  const res = await r.done;
  assert.strictEqual(res.code, 1, res.text);
  assert.strictEqual(res.json.embedder_failures[0].stop.ok, false);
  assert.match(res.text, /run NOT ended/);
}));

// ------------------------------------------------------------------ L2: an unsettled gate is not clean

test('L2: a gate half still pending at claude\'s exit is exit 1, with the facts learned so far kept', async (t) => withRun(t, async (dir) => {
  const gate = fakeGate({ sessionMs: null, learned: { version: '2.1.293' } });
  const r = start(dir, { gate });
  const res = await r.done;
  assert.strictEqual(res.code, 1, res.text);
  assert.match(res.json.ended_by, /^claude exited \(code 0\); surface gate unsettled \(debug: true, session: null\)$/);
  assert.strictEqual(res.json.orchestrator.interactive.gate.status, 'unsettled');
  assert.strictEqual(res.json.orchestrator.interactive.gate.session.facts.version, '2.1.293');
  assert.strictEqual(res.json.orchestrator.claude_code_version, '2.1.293');
}));

test('L2: a quit before the first message is exit 0 with that cause, the gate recorded as not reached', async (t) => withRun(t, async (dir) => {
  const gate = fakeGate({ firstMs: null, debugMs: null, sessionMs: null, learned: { version: '2.1.293' } });
  const r = start(dir, { gate, env: { FAKE_NO_SESSION: '1', FAKE_HOLD_MS: '200' } });
  const res = await r.done;
  assert.strictEqual(res.code, 0, res.text);
  assert.strictEqual(res.json.ended_by, 'operator quit before the first message');
  assert.strictEqual(res.json.orchestrator.interactive.gate.status, 'not reached');
  assert.strictEqual(res.json.orchestrator.interactive.gate.first_message_at, null);
  assert.strictEqual(res.json.orchestrator.claude_code_version, '2.1.293', 'the facts learned before the quit were lost');
  assert.ok(currentRunRow(r.dataDir, r.runId).ended_at != null);
}));

test('L2: a quit before the first message with a non-zero exit is still exit 1', async (t) => withRun(t, async (dir) => {
  const gate = fakeGate({ firstMs: null, debugMs: null, sessionMs: null });
  const r = start(dir, { gate, env: { FAKE_NO_SESSION: '1', FAKE_HOLD_MS: '200', FAKE_EXIT_CODE: '2' } });
  const res = await r.done;
  assert.strictEqual(res.code, 1);
  assert.match(res.json.ended_by, /^claude exited before the session started \(code 2\)$/);
}));

// ------------------------------------------------------------------ L3: timeout_ms

test('L3: an interactive run with timeout_ms above 0 is a usage error that writes nothing; headless is unaffected', async (t) => withRun(t, async (dir) => {
  const r = start(dir, { specOverrides: { timeout_ms: 5000 } });
  const res = await r.done;
  assert.strictEqual(res.code, 2);
  assert.match(res.text, /an interactive run takes no timeout_ms/);
  assert.ok(!fs.existsSync(r.dataDir) && !fs.existsSync(r.orchestratorDir), 'something was written before the refusal');
  const ok = start(dir, { specOverrides: { timeout_ms: 0 }, prompt: `${MARKER}\n{{max_fix_rounds}} {{fix_cutoff_rule}}\n` });
  const res2 = await ok.done;
  assert.strictEqual(res2.code, 0, res2.text);
  assert.ok(!/\{\{/.test(fs.readFileSync(ok.captured[0].appendSystemPromptFile, 'utf8')), 'a placeholder was left in the prompt');
}));

// ------------------------------------------------------------------ L4 and L6: the stop

test('L4: belay stop ends claude with killPid on its exact pid and never a tree kill', async (t) => withRun(t, async (dir) => {
  const pidCalls = []; const treeCalls = [];
  const deps = {
    killPid: (target, sig) => { pidCalls.push(target.pid); return P.killPid(target, sig); },
    killTree: (target) => { treeCalls.push(target && target.pid); return P.killTree(target); },
  };
  const r = start(dir, { env: { FAKE_NEVER_EXIT: '1', FAKE_ORPHAN: '1' }, deps });
  const rec = await waitUntil(() => { const x = r.record(); return x && x.grandchild_pid ? x : null; }, 15000);
  // ADR 0039: the orphan the stop leaves (by design) is noted while it is still in this process's tree, so the
  // cleanup can end it by its creation time once its parent is gone.
  const crash = require('../crash.cjs');
  const gcNoted = crash.noteDescendant(rec.grandchild_pid);
  assert.ok(await waitUntil(() => currentRunRow(r.dataDir, r.runId), 15000));
  try {
    const stopped = await cmdStop.run({ argv: [r.runId], cwd: ROOT, dataDir: r.dataDir, json: true });
    assert.strictEqual(stopped.code, 0, stopped.text);
    const res = await r.done;
    assert.deepStrictEqual(pidCalls, [rec.pid], 'the stop did not kill claude by its exact pid, once');
    assert.deepStrictEqual(treeCalls, [], 'the stop killed a tree');    assert.match(res.json.ended_by, /^stopped by belay stop \(caller pid \d+\); claude ended by its pid$/);
  } finally {
    await r.done.catch(() => {});
    if (gcNoted && P.pidAlive(rec.grandchild_pid)) crash.crash(rec.grandchild_pid);
  }
}));

test('D3: after a stop the run settles with no timer of the stop left pending (the 5 s kill wait is cleared once claude exits)', async (t) => withRun(t, async (dir) => {
  const pending = new Map(); const set = [];
  let n = 0;
  const deps = {
    setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); pending.set(++n, { h, ms }); set.push(ms); const id = n; h.__id = id; return h; },
    clearTimeout: (h) => { clearTimeout(h); if (h && h.__id) pending.delete(h.__id); },
  };
  const r = start(dir, { env: { FAKE_NEVER_EXIT: '1' }, deps });
  const rec = await waitUntil(() => r.record(), 15000);
  assert.ok(await waitUntil(() => currentRunRow(r.dataDir, r.runId), 15000));
  try {
    const stopped = await cmdStop.run({ argv: [r.runId], cwd: ROOT, dataDir: r.dataDir, json: true });
    assert.strictEqual(stopped.code, 0, stopped.text);
    await r.done;
    assert.ok(set.includes(5000), 'the stop never armed its kill wait through the injected timers');
    const left = [...pending.values()].map((x) => x.ms);
    assert.deepStrictEqual(left, [], `timers left pending after the run settled: ${left}`);
  } finally { await r.done.catch(() => {}); }
}));

test('L6: a stop that finds claude already gone does not claim to have ended it', async (t) => withRun(t, async (dir) => {
  const pidCalls = [];
  let rec = null;
  const deps = {
    killPid: (target, sig) => { pidCalls.push(target.pid); return P.killPid(target, sig); },
    pidAlive: (pid) => (rec && pid === rec.pid ? false : P.pidAlive(pid)), // claude is exiting on its own as the stop arrives
  };
  const r = start(dir, { env: { FAKE_HOLD_MS: '1500' }, deps });
  rec = await waitUntil(() => r.record(), 15000);
  assert.ok(await waitUntil(() => currentRunRow(r.dataDir, r.runId), 15000));
  const stopped = await cmdStop.run({ argv: [r.runId], cwd: ROOT, dataDir: r.dataDir, json: true });
  const res = await r.done;
  assert.deepStrictEqual(pidCalls, [], 'a kill was sent to a claude that had already exited');
  assert.ok(!/ended by its pid/.test(res.json.ended_by), res.json.ended_by);
  assert.match(res.json.ended_by, /^claude exited \(code 0\)$/);
  assert.match(JSON.stringify(stopped.json), /already exited/);
}));

// ------------------------------------------------------------------ L5: the headless text

test('L5: headless renderText is byte-identical to d226f9a (a representative receipt and a refusal)', () => {
  const base = {
    run_id: 'r-1', mode: 'headless', orchestrator: { pid: 4242, session_id: 'sess-1', turns: 7, exit_code: 0 }, ended_by: 'the orchestrator closed (stdin closed)',
    holds: [1, 2], polls: 3, stop: { caller_pid: 99 }, workers_closed: { killed: [{}], marked_dead: [1, 2] },
    levers: { max_fix_rounds: 2, fix_cutoff: 'cutoff', on_embedder_failure: 'stop' }, review_rounds: null, review_rounds_reason: 'task.list failed: x',
    embedder: { ok: true, warm_ms: 12, load_ms: null },
    embedder_failures: [{ worker: 'w1', call: 'memory.store', code: 'E_TIMEOUT', cause: 'timeout', pause: { ok: true } }, { worker: 'w2', call: 'm', code: 'E_X', stop: { ok: true } }],
    receipt_path: '/tmp/x/run.json',
  };
  const refusal = {
    run_id: 'r-2', mode: 'headless', orchestrator: { pid: null, session_id: null, turns: null, exit_code: null }, ended_by: 'the election failed: E_X: boom',
    holds: [], polls: 0, stop: null, workers_closed: null, levers: { max_fix_rounds: 2, fix_cutoff: 'a', on_embedder_failure: 'stop' }, review_rounds: null, review_rounds_reason: 'the run never started',
    embedder: null, embedder_failures: [], receipt_path: null,
  };
  // Generated by running d226f9a's renderText (git show d226f9a:src/cli/cmd-run.cjs) on these two receipts.
  assert.strictEqual(renderText(base), 'run_id: r-1\norchestrator pid 4242, session sess-1, 7 turn(s)\nended_by: the orchestrator closed (stdin closed)\nexit_code: 0\nholds: 2\npolls: 3\nstopped by: pid 99\nworkers closed: 1 killed, 2 marked dead\nlevers: max_fix_rounds 2, fix_cutoff cutoff, on_embedder_failure stop; review_rounds: unknown (task.list failed: x)\nembedder: warmed in 12 ms (model load unrecorded)\nembedder failure: w1, memory.store, E_TIMEOUT (timeout); run paused\nembedder failure: w2, m, E_X; run ended (cannot be fixed inside a run)\nreceipt: /tmp/x/run.json\n');
  assert.strictEqual(renderText(refusal), 'run_id: r-2\norchestrator pid null, session null, null turn(s)\nended_by: the election failed: E_X: boom\nexit_code: null\nholds: 0\npolls: 0\nlevers: max_fix_rounds 2, fix_cutoff a, on_embedder_failure stop; review_rounds: unknown (the run never started)\n');
  assert.match(renderText({ ...base, mode: 'interactive' }), /^run_id: r-1\nmode: interactive\n/);
});

// ------------------------------------------------------------------ L7 to L9, M7: the fast close

test('L7: a gate failure followed by SIGHUP keeps the failure: <cause>; then console closed (fast close)', async (t) => withRun(t, async (dir) => {
  const gate = fakeGate({ debug: { ok: false, failed: 'skills', detail: '2 skills loaded' }, debugMs: 300, afterDebug: () => process.emit('SIGHUP') });
  const r = start(dir, { env: { FAKE_NEVER_EXIT: '1' }, gate });
  const res = await r.done;
  assert.strictEqual(res.code, 1);
  assert.strictEqual(res.json.ended_by, 'surface gate failed (debug): skills: 2 skills loaded; then console closed (fast close)');
  assert.strictEqual(currentRunRow(r.dataDir, r.runId).exit_reason, res.json.ended_by);
}));

test('L8: the console handlers are still installed when run.json is written, and gone after', async (t) => withRun(t, async (dir) => {
  const seen = [];
  const real = fs.writeFileSync;
  fs.writeFileSync = function patched(file, ...rest) {
    if (/orch\/run\.json$/.test(String(file).split('\\').join('/'))) seen.push(process.listenerCount('SIGHUP'));
    return real.call(this, file, ...rest);
  };
  const before = process.listenerCount('SIGHUP');
  try {
    const res = await start(dir).done;
    assert.strictEqual(res.code, 0, res.text);
  } finally { fs.writeFileSync = real; }
  assert.deepStrictEqual(seen, [before + 1], 'the SIGHUP handler was not installed while run.json was written');
  assert.strictEqual(process.listenerCount('SIGHUP'), before, 'the handlers were not removed afterwards');
}));

test('L9: after a SIGHUP, a slow worker close is cut and the whole close still ends, row and receipt written, inside the close budget', async (t) => withRun(t, async (dir) => {
  const r = start(dir, {
    env: { FAKE_HOLD_MS: '900' },
    deps: { closeRunWorkers: () => new Promise((res) => { setTimeout(res, 30000).unref(); }) }, // a close that would take 30 s
  });
  const rec = await waitUntil(() => r.record(), 15000);
  assert.ok(rec);
  await sleep(300);
  const hupAt = Date.now();
  process.emit('SIGHUP');
  const res = await r.done;
  const ms = Date.now() - hupAt;
  // The design bound is 3500 ms, and a loaded host runs well past it. What this separates is a close that waits out
  // the 30 s worker close above, so 15 s.
  assert.ok(ms < 15000, `the close took ${ms} ms after the SIGHUP`);
  assert.strictEqual(res.code, 1);
  assert.match(res.json.ended_by, /^console closed \(fast close\); then worker close: fast close deadline passed during the run's worker close$/);
  assert.ok(currentRunRow(r.dataDir, r.runId).ended_at != null, 'run.end never landed');
  assert.ok(!fs.existsSync(`${r.dataDir}/owner.lock`), 'the owner was left running');
  assert.strictEqual(JSON.parse(fs.readFileSync(`${r.orchestratorDir}/run.json`, 'utf8')).mode, 'interactive');
}));

test('L9: with a fast close each kill wait is cut to the time left (and not otherwise)', async () => {
  const w = sleeper();
  try {
    const waits = [];
    const deps = {
      // ADR 0039: the close kills through killProcess; only a kill that was sent has a death to wait for.
      killProcess: async () => ({ tree: { terminated: 1 }, pidKill: { signalled: true }, identity: { via: 'created' }, refused: null }),
      waitPidGone: async (pid, o) => { waits.push(o.timeoutMs); return null; },
    };
    const core = { run: { get: async () => ({ run: { adapter_pid: null } }) }, worker: { list: async () => ({ workers: [{ id: 'w', run_id: 'r', substrate: 'claude-code', state: 'running', pid: w.pid }] }) } };
    await closeRunWorkers({ core, runId: 'r', graceMs: 1000, deps, fast: { requested: () => true, leftMs: () => 250 } });
    await closeRunWorkers({ core, runId: 'r', graceMs: 1000, deps });
    assert.deepStrictEqual(waits, [250, 5000]);
  } finally { require('../crash.cjs').crash(w); }
});

test('M7: a SIGHUP that arrives during the close still makes it the fast close', async (t) => withRun(t, async (dir) => {
  const r = start(dir, {
    env: { FAKE_HOLD_MS: '300' },
    deps: { closeRunWorkers: async (o) => { process.emit('SIGHUP'); return closeRunWorkers(o); } }, // the signal lands inside the close
  });
  const res = await r.done;
  assert.strictEqual(res.code, 1, 'a fast close is never a clean exit');
  assert.strictEqual(res.json.ended_by, 'console closed (fast close)');
  assert.deepStrictEqual(res.json.orchestrator.interactive.console_events.map((e) => e.signal), ['SIGHUP']);
  assert.strictEqual(currentRunRow(r.dataDir, r.runId).exit_reason, 'console closed (fast close)');
}));

// ------------------------------------------------------------------ G3, G5, G9, M8

test('G3: a stale claude-debug.log is removed before the spawn, and the gate is told when the spawn was', async (t) => withRun(t, async (dir) => {
  fs.mkdirSync(`${dir}/orch`, { recursive: true });
  fs.writeFileSync(`${dir}/orch/claude-debug.log`, 'STALE LOG FROM AN EARLIER RUN\n');
  const existedAtArgv = [];
  const t0 = Date.now();
  const gate = fakeGate();
  const r = start(dir, { gate, onArgv: (o) => existedAtArgv.push(fs.existsSync(o.debugFile)) });
  const res = await r.done;
  assert.strictEqual(res.code, 0, res.text);
  assert.deepStrictEqual(existedAtArgv, [false], 'the stale log survived until the launch');
  assert.ok(gate.seen[0].spawnedAt >= t0 && gate.seen[0].spawnedAt <= Date.now());
  assert.ok(!/STALE LOG/.test(fs.readFileSync(`${dir}/orch/claude-debug.log`, 'utf8')));
}));

test('G5: a missing session file does not override the gate: a settled session half is a session', async (t) => withRun(t, async (dir) => {
  const gate = fakeGate({ session: { ok: true, facts: { permission_mode: 'auto', session_file: 'C:/elsewhere/s.jsonl' } } });
  const r = start(dir, { gate, env: { FAKE_NO_SESSION: '1' } });
  const res = await r.done;
  assert.strictEqual(res.code, 0, res.text);
  assert.strictEqual(res.json.ended_by, 'claude exited (code 0)');
  assert.strictEqual(res.json.orchestrator.interactive.session_file, 'C:/elsewhere/s.jsonl');
}));

test('interactive_assistant_ms is gone (ADR 0037 amendment 4): a spec that sets it is refused as an unknown key, and no gate is built', async (t) => withRun(t, async (dir) => {
  const gate = fakeGate();
  const res = await start(dir, { gate, specOverrides: { interactive_assistant_ms: 1234 } }).done;
  assert.strictEqual(res.code, 2);
  assert.match(res.text, /unknown spec key "interactive_assistant_ms"/);
  assert.strictEqual(gate.seen.length, 0);
}));

test('G9: the marker counts only as a line of its own, not as a substring of prose', async (t) => withRun(t, async (dir) => {
  const r = start(dir, { prompt: `Quote the marker ${MARKER} inline, never as its own line.\n` });
  const res = await r.done;
  assert.strictEqual(res.code, 2);
  assert.match(res.text, /lacks the line/);
  assert.ok(RI.hasMarker(`a\r\n  ${MARKER}  \r\nb`) && !RI.hasMarker(`x ${MARKER}`));
}));

test('M8: a gate failure with claude exiting 0 (the kill suppressed) still makes the exit 1', async (t) => withRun(t, async (dir) => {
  const gate = fakeGate({ debug: { ok: false, failed: 'plugins', detail: '1 plugin agent loaded' }, debugMs: 100 });
  const killed = [];
  const deps = { killPid: (target) => { killed.push(target.pid); return { signalled: false }; }, killTree: async (pid) => { killed.push(pid); return null; } };
  const r = start(dir, { gate, deps, env: { FAKE_HOLD_MS: '700' } }); // the failure lands at 100 ms; the un-killed stub exits 0 at 700 ms
  const res = await r.done;
  assert.ok(killed.length >= 1, 'the gate failure never tried to kill claude');
  assert.strictEqual(res.json.orchestrator.exit_code, 0, 'the stub did not exit 0 by itself');
  assert.strictEqual(res.code, 1, res.text);
  assert.match(res.json.ended_by, /^surface gate failed \(debug\): plugins: 1 plugin agent loaded$/);
}));

// ------------------------------------------------------------------ R4-2: a stop before any assistant reply leaves the gate unsettled

test('R4-2: belay stop on a reached session with no assistant reply is gate status unsettled, the details kept, ended_by the stop', async (t) => withRun(t, async (dir) => {
  const base = fakeGate({ debugMs: null, sessionMs: null, firstMs: 50, learned: { version: '2.1.293' } });
  const make = (opts) => {
    const g = base.make(opts);
    const debug = { ok: true, finalized: true, checks: [], facts: { version: '2.1.293' } };
    const session = { ok: false, finalized: true, failed: 'no_assistant_reply_before_exit', detail: 'required entry model absent: claude exited before an assistant reply', checks: [], facts: {} };
    let settle; const fin = new Promise((r) => { settle = r; });
    return { ...g, debug: fin.then(() => debug), session: fin.then(() => session), finalize() { settle(); return Promise.resolve({ debug, session }); } };
  };
  const r = start(dir, { env: { FAKE_NEVER_EXIT: '1' }, gate: { make, seen: base.seen }, specOverrides: { close_grace_ms: 1500 } });
  const rec = await waitUntil(() => r.record(), 15000);
  assert.ok(rec);
  assert.ok(await waitUntil(() => currentRunRow(r.dataDir, r.runId), 15000));
  try {
    await cmdStop.run({ argv: [r.runId], cwd: ROOT, dataDir: r.dataDir, json: true });
    const res = await r.done;
    assert.match(res.json.ended_by, /^stopped by belay stop/);
    const gate = res.json.orchestrator.interactive.gate;
    assert.strictEqual(gate.status, 'unsettled');
    assert.strictEqual(gate.session.failed, 'no_assistant_reply_before_exit');
    assert.match(gate.session.detail, /absent/);
  } finally { require('../crash.cjs').crashDescendant(rec.pid); await r.done.catch(() => {}); } // ADR 0039: only while it is this process's own child
}));
