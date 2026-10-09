'use strict';
// logs-diff.test.cjs — build steps 4c and 4c-2. Drives the built CLI's `logs` and `diff` as subprocesses,
// with the scaffolding of tests/cli/observe.test.cjs and tests/cli/stop-helpers.cjs. Every invocation is
// bracketed by a recursive listing of the data dir that must be identical before and after; every
// planted or spawned process is killed by exact pid in a `finally`.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { openCore, pidAlive } = require('../../src/core/index.cjs');
const { ROOT, CLI, sandbox, cleanup, listRecursive, waitForExit, waitUntil } = require('./stop-helpers.cjs');

function logsJson(args, dataDir) {
  return spawnSync(process.execPath, [CLI, 'logs', ...args, '--data', dataDir, '--json'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
}
function diffJson(args, dataDir) {
  return spawnSync(process.execPath, [CLI, 'diff', ...args, '--data', dataDir, '--json'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
}

// B3/observe.test.cjs's own pattern: reading never writes, asserted by the sorted NAME listing.
function checked(fn, dataDir, label) {
  const before = listRecursive(dataDir);
  const r = fn();
  assert.deepStrictEqual(listRecursive(dataDir), before, `${label}: changed the data dir listing`);
  return r;
}

// Captures a spawned `logs -f` child's stdout/stderr (and each stdout chunk's own arrival time, for
// evidence a followed line arrived close to the event that produced it) into a mutable state object,
// and a way to wait until its header line has arrived (the tail read has happened) before racing it.
function watchCli(cli) {
  const state = { out: '', errOut: '', events: [] };
  cli.stdout.on('data', d => { const text = d.toString(); state.out += text; state.events.push({ t: Date.now(), text }); });
  cli.stderr.on('data', d => { state.errOut += d.toString(); });
  return state;
}
function waitForHeader(state, timeoutMs = 60000) {
  return waitUntil(() => (/^worker /m.test(state.out) ? true : null), timeoutMs, 20);
}

const vec = (seed) => Array.from({ length: 384 }, (_, i) => (((i + seed) % 7) + 1) / 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function plantWorker(dataDir, runId, workerId, pid) {
  const core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: runId, pid: process.pid } });
  try {
    await core.run.attach({ adapter_pid: process.pid });
    return await core.worker.write({ id: workerId, substrate: 'claude-code', pid, state: 'running', turns: 0, started_at: Date.now() });
  } finally {
    await core.shutdownOwner();
    await core.close();
  }
}

function streamPathOf(dataDir, workerId) { return `${dataDir}/workers/${workerId}/stream.jsonl`; }

function writeTailFixture(dataDir, workerId, n) {
  const p = streamPathOf(dataDir, workerId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const lines = [];
  for (let i = 1; i <= n; i += 1) lines.push(JSON.stringify({ line: i }));
  fs.writeFileSync(p, lines.map(l => `${l}\n`).join(''));
  return p;
}

// ================================================================ logs

test('logs: prints the header and the last N lines of a worker\'s stream from the byte offset it reports, an unknown worker is E_NOT_FOUND with exit 1, a worker with no stream file yet exits 0 with no lines, and --json carries the raw lines', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    await plantWorker(dataDir, 'run-logs-a', 'w1', process.pid);
    await plantWorker(dataDir, 'run-logs-a', 'w-nostream', process.pid);
    const streamPath = writeTailFixture(dataDir, 'w1', 30);
    const totalBytes = fs.statSync(streamPath).size;
    const rDefault = checked(() => logsJson(['w1'], dataDir), dataDir, 'logs w1 (default tail)');
    assert.strictEqual(rDefault.status, 0, `logs w1: ${rDefault.stdout} / ${rDefault.stderr}`);
    const jDefault = JSON.parse(rDefault.stdout);
    assert.strictEqual(jDefault.worker_id, 'w1');
    assert.strictEqual(jDefault.stream_path, streamPath.split(path.sep).join('/'));
    assert.strictEqual(jDefault.stream_bytes, totalBytes);
    assert.strictEqual(jDefault.lines.length, 20, 'the default tail is 20 lines');
    assert.deepStrictEqual(JSON.parse(jDefault.lines[19]), { line: 30 }, 'the tail must end at the last line written');
    assert.deepStrictEqual(JSON.parse(jDefault.lines[0]), { line: 11 });
    const tailBytes = Buffer.byteLength(jDefault.lines.map(l => `${l}\n`).join(''), 'utf8');
    assert.strictEqual(jDefault.offset + tailBytes, jDefault.stream_bytes, 'offset plus the printed bytes must equal stream_bytes');
    assert.strictEqual(jDefault.followed, false);
    const rTail5 = checked(() => logsJson(['w1', '--tail', '5'], dataDir), dataDir, 'logs w1 --tail 5');
    const jTail5 = JSON.parse(rTail5.stdout);
    assert.strictEqual(jTail5.lines.length, 5);
    assert.deepStrictEqual(JSON.parse(jTail5.lines[4]), { line: 30 });
    assert.deepStrictEqual(JSON.parse(jTail5.lines[0]), { line: 26 });
    const rText = checked(() => spawnSync(process.execPath, [CLI, 'logs', 'w1', '--tail', '3', '--data', dataDir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' }), dataDir, 'logs w1 --tail 3 (text)');
    assert.strictEqual(rText.status, 0);
    const textLines = rText.stdout.split(/\r?\n/);
    assert.match(textLines[0], /^worker w1 .* stream .* bytes \d+ offset \d+$/);
    assert.strictEqual(textLines[1], JSON.stringify({ line: 28 }));
    assert.strictEqual(textLines[3], JSON.stringify({ line: 30 }));
    const rUnknown = checked(() => logsJson(['no-such-worker'], dataDir), dataDir, 'logs unknown worker');
    assert.strictEqual(rUnknown.status, 1, `unknown worker: ${rUnknown.stdout} / ${rUnknown.stderr}`);
    assert.strictEqual(JSON.parse(rUnknown.stderr).error.code, 'E_NOT_FOUND');
    const rNoStream = checked(() => logsJson(['w-nostream'], dataDir), dataDir, 'logs w-nostream');
    assert.strictEqual(rNoStream.status, 0, `w-nostream: ${rNoStream.stdout} / ${rNoStream.stderr}`);
    const jNoStream = JSON.parse(rNoStream.stdout);
    assert.strictEqual(jNoStream.stream_bytes, null);
    assert.strictEqual(jNoStream.offset, null);
    assert.deepStrictEqual(jNoStream.lines, []);
    const rNoStreamText = spawnSync(process.execPath, [CLI, 'logs', 'w-nostream', '--data', dataDir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
    assert.match(rNoStreamText.stdout, /\(no stream file yet\)/);
  } finally {
    cleanup(dir);
  }
});

// A still-being-written last line (no trailing newline) prints as a tail line exactly as stored, and
// the follow later emits its completed remainder as its own line: split, never lost or re-printed whole.
test('logs: a stream whose last line is partial at the tail read is printed as a tail line, and the follow later emits the remainder as its own line', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  let hangChild = null;
  try {
    const streamPath = streamPathOf(dataDir, 'w-partial');
    fs.mkdirSync(path.dirname(streamPath), { recursive: true });
    fs.writeFileSync(streamPath, ['{"line":1}', '{"line":2}'].map(l => `${l}\n`).join('') + '{"line":3,"partial":true');
    hangChild = spawn(process.execPath, ['-e', 'setInterval(()=>{},100000)'], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
    await plantWorker(dataDir, 'run-logs-partial', 'w-partial', hangChild.pid);
    const rTail = checked(() => logsJson(['w-partial'], dataDir), dataDir, 'logs w-partial (partial last line)');
    assert.strictEqual(rTail.status, 0, `${rTail.stdout} / ${rTail.stderr}`);
    const jTail = JSON.parse(rTail.stdout);
    assert.strictEqual(jTail.lines[jTail.lines.length - 1], '{"line":3,"partial":true');
    const cli = spawn(process.execPath, [CLI, 'logs', 'w-partial', '-f', '--for', '2000', '--data', dataDir], { cwd: ROOT, windowsHide: true });
    const st = watchCli(cli);
    assert.ok(await waitForHeader(st), `logs -f never printed its header within the hang guard: stdout=${st.out} stderr=${st.errOut}`);
    fs.appendFileSync(streamPath, '}\n'); // completes {"line":3,"partial":true} with its trailing newline
    const exit = await waitForExit(cli, HANG_GUARD_MS);
    assert.ok(exit, `logs -f (partial line) never exited: stdout=${st.out} stderr=${st.errOut}`);
    assert.strictEqual(exit.code, 0, `exited ${exit.code}: ${st.errOut}`);
    const outLines = st.out.split(/\r?\n/);
    assert.ok(outLines.includes('}'), `the remainder must arrive as its own followed line: ${st.out}`);
    assert.ok(!outLines.includes('{"line":3,"partial":true}'), `the tail's partial line must not be re-printed whole by the follow: ${st.out}`);
  } finally {
    if (hangChild && hangChild.pid && pidAlive(hangChild.pid)) { try { process.kill(hangChild.pid); } catch { /* already gone */ } }
    cleanup(dir);
  }
});

// ================================================================ logs -f

// A worker fixture process: appends one JSON line every 200 ms for 1.5 s, then exits on its own.
// Count-driven, not clock-driven (w2 flake fix): it writes exactly seven lines, then exits. The old
// fixture exited at a 1,500 ms timer, so under CPU starvation its interval ticked fewer than seven times
// and the test's "line 6 never appeared" was the fixture's shortfall, not the follower's.
const APPENDER_SRC = "const fs=require('fs');const t=process.argv[2];let n=0;"
  + "const iv=setInterval(()=>{n+=1;fs.appendFileSync(t,JSON.stringify({n,at:Date.now()})+'\\n');"
  + "if(n===7){clearInterval(iv);process.exit(0);}},200);\n";
const HANG_SRC = "setInterval(() => {}, 100000);\n"; // a worker fixture process that never exits on its own

// build step 6h design item 4: mirrors src/cli/cmd-logs.cjs's own POLL_MS (250 ms) — not importable,
// since design item 8 forbids editing anything under src/cli, including adding an export to it.
// Distribution: the bound case's elapsed
// time over its own `--for` bound was 263-316 ms across 20 quiet runs and 266-1298 ms across 10 runs
// under a full `npm test` beside it (the CLI's own sleep(POLL_MS) overshoots under host contention,
// same shape as the follow test's known flake, 4c-2/probe-follow-*); line 7's own arrival relative to
// the appender's exit ranged -76 to +242 ms across both. Bounds below are POLL_MS times a factor each
// distribution justifies with margin, never a raw number.
const FOLLOW_POLL_MS = 250;
// Hang guard for a spawned CLI: only a process that never exits trips it. Child start-up alone took
// several seconds under a saturated host (w2-flakes/load-base-1.json), so no speed claim rides on it.
const HANG_GUARD_MS = 60000;
// What the follower itself reports ("followed N ms") is compared with its own --for, never the test's
// wall clock around a spawned process, whose start-up is the host's load and not belay's behaviour.
const followedMsOf = (out) => { const m = /followed (\d+) ms, ended because/.exec(out); return m ? Number(m[1]) : null; };
// build step 6h fix round (should-fix, FINDINGS.json line 168): this margin is a stability bound
// against host load, not a regression gate — a per-poll stall of 150 or 400 ms passes it, the same as
// it passed the old raw 1,000 ms margin this replaced (no catching power lost, none had). Recorded
// here, not asserted: a tighter bound would need a receipt-derived signal (the poll count, say), which
// design item 8 forbids adding an export to src/cli to produce.

test('logs -f: follows a growing stream for the bound, emitting each line as it lands, and ends early once the worker\'s pid is dead and the file stops growing, saying which', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const scriptsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-logs-f-'));
  const appenderPath = path.join(scriptsDir, 'appender.cjs');
  const hangPath = path.join(scriptsDir, 'hang.cjs');
  fs.writeFileSync(appenderPath, APPENDER_SRC);
  fs.writeFileSync(hangPath, HANG_SRC);
  let appenderChild = null;
  let hangChild = null;
  try {
    // Case 1: the worker's pid dies mid-follow and the stream stops growing with it.
    const streamPathA = streamPathOf(dataDir, 'wA');
    fs.mkdirSync(path.dirname(streamPathA), { recursive: true });
    appenderChild = spawn(process.execPath, [appenderPath, streamPathA], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
    await plantWorker(dataDir, 'run-logs-f', 'wA', appenderChild.pid);
    let appenderExitedAt = null;
    const appenderExit = new Promise(res => appenderChild.once('exit', () => { appenderExitedAt = Date.now(); res(); }));
    const forMsA = 10000;
    const cliA = spawn(process.execPath, [CLI, 'logs', 'wA', '-f', '--for', String(forMsA), '--data', dataDir], { cwd: ROOT, windowsHide: true });
    const stA = watchCli(cliA);
    await appenderExit;
    const exitA = await waitForExit(cliA, HANG_GUARD_MS);
    assert.ok(exitA, `belay logs -f (dead pid case) never exited: stdout=${stA.out} stderr=${stA.errOut}`);
    assert.strictEqual(exitA.code, 0, `belay logs -f exited ${exitA.code}: ${stA.errOut}`);
    assert.match(stA.out, /ended because: pid dead and the stream stopped growing/);
    // The fact this ended early, not a raw millisecond count: it named the dead pid above, and it did
    // so before the --for bound it was given, never waiting out the full window for a pid it can see
    // is already gone.
    const followedA = followedMsOf(stA.out);
    assert.ok(followedA !== null && followedA < forMsA, `belay logs -f followed ${followedA} ms by its own count, at or past its own --for ${forMsA} bound`);
    for (let n = 1; n <= 7; n += 1) assert.match(stA.out, new RegExp(`"n":${n}\\b`), `line ${n} never appeared in the followed output`);
    const line7Event = stA.events.find(e => e.text.includes('"n":7'));
    assert.ok(line7Event, 'no stdout chunk ever carried n:7');
    // Line 7 was written by the fixture's last act; the follower must have emitted it before declaring the
    // pid dead and the stream stopped. Presence in the output (above) is that fact; its latency after the
    // child's exit is the host's scheduling and is not asserted.
    // Case 2: the worker's pid stays alive throughout, so the follow ends on the bound.
    hangChild = spawn(process.execPath, [hangPath], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
    await plantWorker(dataDir, 'run-logs-f', 'wB', hangChild.pid);
    const forMsB = 1500;
    const cliB = spawn(process.execPath, [CLI, 'logs', 'wB', '-f', '--for', String(forMsB), '--data', dataDir], { cwd: ROOT, windowsHide: true });
    const stB = watchCli(cliB);
    const exitB = await waitForExit(cliB, HANG_GUARD_MS);
    assert.ok(exitB, `belay logs -f (bound case) never exited: stdout=${stB.out} stderr=${stB.errOut}`);
    assert.strictEqual(exitB.code, 0, `belay logs -f exited ${exitB.code}: ${stB.errOut}`);
    assert.match(stB.out, /ended because: bound/);
    const followedB = followedMsOf(stB.out);
    // Both sides are the follower's own in-process count, so spawn latency is not in them: at least its bound,
    // and not more than the bound plus 8 polls (a follower that ignored --for would run on to the guard).
    assert.ok(followedB !== null && followedB >= forMsB && followedB < forMsB + FOLLOW_POLL_MS * 8, `the follow ended on the bound but after ${followedB} ms of its own ${forMsB} ms`);
    assert.ok(pidAlive(hangChild.pid), 'the hang child must still be alive: the bound, not a dead pid, ended this follow');
    // --json -f: the lines are collected, not streamed, into one document.
    const rJsonFollow = spawnSync(process.execPath, [CLI, 'logs', 'wB', '-f', '--for', '1000', '--data', dataDir, '--json'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
    assert.strictEqual(rJsonFollow.status, 0, `logs -f --json: ${rJsonFollow.stdout} / ${rJsonFollow.stderr}`);
    const jFollow = JSON.parse(rJsonFollow.stdout);
    assert.strictEqual(jFollow.followed, true);
    assert.strictEqual(jFollow.ended_because, 'bound');
    assert.ok(Array.isArray(jFollow.lines), 'the json follow receipt must carry a lines array');
  } finally {
    for (const child of [appenderChild, hangChild]) {
      if (child && child.pid && pidAlive(child.pid)) { try { process.kill(child.pid); } catch { /* already gone */ } }
    }
    fs.rmSync(scriptsDir, { recursive: true, force: true });
    cleanup(dir);
  }
});

// A directory where a file is expected (EISDIR) reproduces an unreadable stream file without a
// platform-specific ACL tool (FINDINGS.json line 142, should-fix).
test('logs: an unreadable stream file is an error receipt, exit 1, in text and in --json', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    await plantWorker(dataDir, 'run-logs-eisdir', 'w-eisdir', process.pid);
    fs.mkdirSync(streamPathOf(dataDir, 'w-eisdir'), { recursive: true }); // a dir, not a file: EISDIR
    const rJson = checked(() => logsJson(['w-eisdir'], dataDir), dataDir, 'logs w-eisdir --json');
    assert.strictEqual(rJson.status, 1, `expected exit 1: ${rJson.stdout} / ${rJson.stderr}`);
    const jErr = JSON.parse(rJson.stderr);
    assert.ok(jErr.error && jErr.error.code && jErr.error.message, `--json error receipt malformed: ${rJson.stderr}`);
    const rText = checked(() => spawnSync(process.execPath, [CLI, 'logs', 'w-eisdir', '--data', dataDir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' }), dataDir, 'logs w-eisdir (text)');
    assert.strictEqual(rText.status, 1, `expected exit 1: ${rText.stdout} / ${rText.stderr}`);
    assert.match(rText.stderr, /^belay logs: /);
  } finally {
    cleanup(dir);
  }
});

// Regression test for the race the 4c fix round closed at the root: followLoop's start offset comes
// from the same read that produced the tail, never a second, independent read (FINDINGS.json line 161).
test('logs -f: a line written between the tail read and the first follow poll is followed, not lost', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  let hangChild = null;
  let appendTimer = null;
  try {
    const streamPath = writeTailFixture(dataDir, 'wR', 5);
    hangChild = spawn(process.execPath, ['-e', 'setInterval(()=>{},100000)'], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
    await plantWorker(dataDir, 'run-logs-race', 'wR', hangChild.pid);
    const cli = spawn(process.execPath, [CLI, 'logs', 'wR', '-f', '--for', '3000', '--tail', '5', '--data', dataDir], { cwd: ROOT, windowsHide: true });
    const st = watchCli(cli);
    assert.ok(await waitForHeader(st), `logs -f never printed its header within the hang guard: stdout=${st.out} stderr=${st.errOut}`);
    // The header has arrived (the tail read has happened): one line now, then one every 100 ms for
    // 1,000 ms — the exact window the closed race lost a line inside.
    const appended = [];
    let n = 0;
    const appendOne = () => { const line = `race-${n}`; fs.appendFileSync(streamPath, `${JSON.stringify({ line })}\n`); appended.push(line); n += 1; };
    appendOne();
    const t0 = Date.now();
    appendTimer = setInterval(() => {
      if (Date.now() - t0 >= 1000) { clearInterval(appendTimer); appendTimer = null; return; }
      appendOne();
    }, 100);
    const exit = await waitForExit(cli, HANG_GUARD_MS);
    assert.ok(exit, `logs -f (race test) never exited: stdout=${st.out} stderr=${st.errOut}`);
    assert.strictEqual(exit.code, 0, `exited ${exit.code}: ${st.errOut}`);
    const outLines = st.out.split(/\r?\n/);
    let lastIdx = -1;
    for (const line of appended) {
      const wanted = JSON.stringify({ line });
      const idx = outLines.findIndex((l, i) => i > lastIdx && l === wanted);
      assert.ok(idx !== -1, `line ${line} never appeared in order in the followed output: ${st.out}`);
      lastIdx = idx;
    }
  } finally {
    if (appendTimer) clearInterval(appendTimer);
    if (hangChild && hangChild.pid && pidAlive(hangChild.pid)) { try { process.kill(hangChild.pid); } catch { /* already gone */ } }
    cleanup(dir);
  }
});

// ================================================================ diff

async function plantForDiff(dataDir, runId) {
  const core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: runId, pid: process.pid } });
  try {
    const { run: runRow } = await core.run.attach({ adapter_pid: process.pid });
    const workerId = `${runId}-w1`;
    await core.worker.write({ id: workerId, substrate: 'claude-code', pid: process.pid, state: 'starting', started_at: Date.now() });
    const t = await core.task.create({ spec: `task for ${runId}` });
    const rowA = await core.memory.store({ namespace: `run/${runId}`, text: 'row A before mark', embedding: vec(0), embedding_model: 'fixture', dim: 384 });
    await sleep(20);
    const markMs = Date.now();
    await sleep(20);
    await core.worker.write({ id: workerId, state: 'running' });
    await core.task.assign({ task_id: t.id, worker_id: workerId });
    await core.continuity.checkpoint({ task_id: t.id, worker_id: workerId, turn: 1, files_touched: ['a.txt'] });
    await core.memory.store({ namespace: `run/${runId}`, text: 'row B supersedes A', embedding: vec(1), embedding_model: 'fixture', dim: 384, supersedes: rowA.id });
    await core.memory.store({ namespace: `run/${runId}`, text: 'row C expires fast', embedding: vec(2), embedding_model: 'fixture', dim: 384, ttl_seconds: 0.001 });
    await sleep(40);
    return { run: runRow, markMs };
  } finally {
    await core.shutdownOwner();
    await core.close();
  }
}

test('diff: with no --since reports what was written since the run started, --since narrows it, --all with no --since reports from the epoch, and every class prints', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    const { run: run1, markMs: mark1 } = await plantForDiff(dataDir, 'run-diff-1');
    const { run: run2 } = await plantForDiff(dataDir, 'run-diff-2');
    const rDefault = checked(() => diffJson([run1.id], dataDir), dataDir, 'diff run-diff-1 (default mark)');
    assert.strictEqual(rDefault.status, 0, `diff run-diff-1: ${rDefault.stdout} / ${rDefault.stderr}`);
    const jDefault = JSON.parse(rDefault.stdout);
    assert.strictEqual(jDefault.since_source, 'run started_at');
    assert.strictEqual(jDefault.since_ms, run1.started_at);
    assert.strictEqual(jDefault.run_id_source, 'argument');
    assert.strictEqual(jDefault.counts.memory.superseded, 1);
    assert.strictEqual(jDefault.counts.memory.expired, 1);
    const rNarrow = checked(() => diffJson([run1.id, '--since', String(mark1)], dataDir), dataDir, 'diff run-diff-1 --since mark1');
    const jNarrow = JSON.parse(rNarrow.stdout);
    assert.strictEqual(jNarrow.since_source, 'argument');
    assert.strictEqual(jNarrow.since_ms, mark1);
    assert.deepStrictEqual(jNarrow.counts.task, { added: 0, updated: 1 }, 'the task was created before the mark, only its assignment lands after');
    assert.deepStrictEqual(jNarrow.counts.worker, { added: 0, updated: 1 });
    const iso = new Date(mark1).toISOString(); // must resolve to the same millisecond value
    const rNarrowIso = checked(() => diffJson([run1.id, '--since', iso], dataDir), dataDir, 'diff run-diff-1 --since (ISO)');
    const jNarrowIso = JSON.parse(rNarrowIso.stdout);
    assert.strictEqual(jNarrowIso.since_ms, mark1);
    assert.deepStrictEqual(jNarrowIso.counts.task, jNarrow.counts.task);
    const rAll = checked(() => diffJson(['--all'], dataDir), dataDir, 'diff --all');
    const jAll = JSON.parse(rAll.stdout);
    assert.strictEqual(jAll.since_source, 'epoch');
    assert.strictEqual(jAll.since_ms, 0);
    assert.strictEqual(jAll.run_id, null);
    assert.strictEqual(jAll.run_id_source, 'all');
    assert.ok(jAll.counts.task.added >= 2, 'both runs\' tasks must be named under --all');
    // Text output: every class the fixture produced must print.
    const rText = checked(() => spawnSync(process.execPath, [CLI, 'diff', run1.id, '--data', dataDir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' }), dataDir, 'diff run-diff-1 (text, default mark)');
    assert.strictEqual(rText.status, 0);
    assert.match(rText.stdout, /^added seq \d+ id /m);
    assert.match(rText.stdout, /^updated seq \d+ id /m);
    assert.match(rText.stdout, /^superseded /m);
    assert.match(rText.stdout, /^expired /m);
    // No changes: a mark after this run's only write, and no memory rows at all.
    const core3 = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-diff-3', pid: process.pid } });
    let run3Id;
    try {
      const { run: run3 } = await core3.run.attach({ adapter_pid: process.pid });
      run3Id = run3.id;
    } finally {
      await core3.shutdownOwner();
      await core3.close();
    }
    await sleep(20);
    const rNoChanges = checked(() => diffJson([run3Id, '--since', String(Date.now())], dataDir), dataDir, 'diff no changes');
    const jNoChanges = JSON.parse(rNoChanges.stdout);
    assert.deepStrictEqual(jNoChanges.counts.task, { added: 0, updated: 0 });
    const rNoChangesText = spawnSync(process.execPath, [CLI, 'diff', run3Id, '--since', String(Date.now()), '--data', dataDir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
    assert.match(rNoChangesText.stdout, /^\(no changes since \d+\)$/m);
    void run2;
  } finally {
    cleanup(dir);
  }
});

// --since is a non-negative integer of digits or an ISO 8601 timestamp; anything else is a usage error
// naming the argument, never a silent 2001 date or an exit-1 runtime error (FINDINGS.json line 36).
test('diff: --since 1.5, -5, 1e22 and a bare word are usage errors, exit 2, naming the argument', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    for (const bad of ['1.5', '-5', '1e22', 'garbage']) {
      const r = checked(() => diffJson(['--since', bad], dataDir), dataDir, `diff --since ${bad}`);
      assert.strictEqual(r.status, 2, `--since ${bad}: expected exit 2, got ${r.status}: ${r.stdout} / ${r.stderr}`);
      const j = JSON.parse(r.stderr);
      assert.ok(String(j.error).includes(bad), `the usage error must name the argument ${bad}: ${j.error}`);
    }
  } finally {
    cleanup(dir);
  }
});

// ================================================================ import graph

test('logs and diff: no CLI path to either loads the embedder', () => {
  const probe = `
    require(${JSON.stringify(CLI)});
    require(${JSON.stringify(`${ROOT}/src/cli/cmd-logs.cjs`)});
    require(${JSON.stringify(`${ROOT}/src/cli/cmd-diff.cjs`)});
    const hit = Object.keys(require.cache).filter(k => /src[\\\\/]core[\\\\/]embedder\\.cjs$/i.test(k));
    process.stdout.write(JSON.stringify(hit));
  `;
  const rProbe = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(rProbe.status, 0, `probe failed: ${rProbe.stderr}`);
  assert.deepStrictEqual(JSON.parse(rProbe.stdout), [], 'requiring the command modules reached the embedder');
});
