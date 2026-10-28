'use strict';
// transcript.test.cjs — ADR 0036 decision 8, build step U1. Drives the built CLI's `transcript` as a
// subprocess against a sandbox store with one planted run row and fixture stream files under the OS
// tmp dir, never a real data dir. Every sandbox is removed in finally.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');

const { openCore } = require('../../src/core/index.cjs');
const { makeFolder } = require('../../src/cli/cmd-transcript.cjs');
const { ROOT, CLI, sandbox, cleanup } = require('./stop-helpers.cjs');

const RUN = 'run-t';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const L = (o) => `${JSON.stringify(o)}\n`;
const TS = '2026-10-04T10:00:00.000Z';
const asst = (content, extra = {}) => L({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content, usage: { input_tokens: 1 } }, parent_tool_use_id: null, timestamp: TS, ...extra });
const text = (t) => asst([{ type: 'text', text: t }]);
const toolUse = (id, name, input) => asst([{ type: 'tool_use', id, name, input }]);
const toolResult = (id, content, isError) => L({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] }, parent_tool_use_id: null, timestamp: TS });

function cli(args, dataDir, { env, json = true } = {}) {
  return spawnSync(process.execPath, [CLI, 'transcript', ...args, '--data', dataDir, ...(json ? ['--json'] : [])], { cwd: ROOT, windowsHide: true, encoding: 'utf8', env: { ...process.env, ...(env || {}) } });
}

function cliAsync(args, dataDir) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, 'transcript', ...args, '--data', dataDir, '--json'], { cwd: ROOT, windowsHide: true });
    let stdout = ''; proc.stdout.on('data', (d) => { stdout += d; });
    let stderr = ''; proc.stderr.on('data', (d) => { stderr += d; });
    proc.once('exit', (status) => resolve({ status, stdout, stderr }));
  });
}

// A follow in text mode: its lines arrive as the file is read, so a test appends after the CLI has printed what it started from (its
// start-up is slower than any fixed sleep on a loaded host). `seen(needle)` resolves true once stdout holds the needle, false if the CLI exits first.
function followAsync(args, dataDir) {
  const proc = spawn(process.execPath, [CLI, 'transcript', ...args, '--data', dataDir], { cwd: ROOT, windowsHide: true });
  let stdout = ''; let stderr = '';
  const waiters = [];
  const check = () => { for (const w of waiters.slice()) if (stdout.includes(w.needle)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(true); } };
  proc.stdout.on('data', (d) => { stdout += d; check(); });
  proc.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((resolve) => proc.once('exit', (status) => { for (const w of waiters) w.resolve(false); resolve({ status, stdout, stderr }); }));
  const seen = (needle) => new Promise((resolve) => { waiters.push({ needle, resolve }); check(); });
  return { seen, done };
}

async function plantRun(dataDir) {
  const core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: RUN, pid: process.pid }, embed: false });
  try { await core.run.attach({ adapter_pid: process.pid }); } finally { await core.shutdownOwner(); await core.close(); }
}

function snapshot(...dirs) {
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) { out.push(`${p}/`); walk(p); } else { const s = fs.statSync(p); out.push(`${p} ${s.size} ${s.mtimeMs}`); }
    }
  };
  dirs.forEach(walk);
  return out;
}

const LONG = 'word '.repeat(60).trim();
function fixture() {
  return [
    L({ type: 'system', subtype: 'init' }),
    text(`Creating the coder task.\nSecond line \u001b[31mred\u001b[0m\n${LONG}`),
    toolUse('tu1', 'mcp__belay__worker_spawn', { worker_id: 'w1', task_id: 't1', prompt: 'SECRET PROMPT' }),
    toolResult('tu1', JSON.stringify({ error: 'E_ARGS', message: 'x' }), true),
    toolUse('tu2', 'mcp__belay__task_evaluate', { task_id: 't1' }),
    toolUse('tu3', 'mcp__belay__worker_wait', { worker_ids: ['w1', 'w2'], timeout_ms: 1000 }),
    toolResult('tu2', '{"state":"done"}'),
    'this is not json\n',
    asst([{ type: 'text', text: 'SUBAGENT WORDS' }], { parent_tool_use_id: 'toolu_x' }),
    L({ type: 'user', message: { role: 'user', content: 'belay: worker w1 finished turn 1.' }, parent_tool_use_id: null, timestamp: TS }),
    toolResult('tu3', [{ type: 'text', text: '{"timed_out":true}' }]),
    L({ type: 'result', is_error: false, num_turns: 2, stop_reason: 'end_turn', total_cost_usd: 1.5 }),
  ].join('');
}

test('transcript: renders the stream as panel entries, text in full, one line per tool call with its ids and error code, wakes, turn ends; skips what is not the orchestrator\'s; reads write nothing', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const orch = `${dir}/orch`;
  try {
    await plantRun(dataDir);
    fs.mkdirSync(orch, { recursive: true });
    const partial = '{"type":"assistant","message":{"content":[{"type":"text","text":"PARTIAL';
    fs.writeFileSync(`${orch}/stream.jsonl`, fixture() + partial);
    const before = snapshot(dataDir, orch);

    const r = cli([RUN, '--dir', orch], dataDir);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepStrictEqual(j.entries.map((e) => e.kind), ['text', 'tool', 'tool', 'belay', 'tool', 'result']);
    const [t0, spawnE, evalE, wake, waitE, res] = j.entries;
    assert.ok(t0.text.includes('Creating the coder task.') && t0.text.includes(LONG), 'the text block is whole');
    assert.deepStrictEqual(spawnE.ids, { worker_id: 'w1', task_id: 't1' });
    assert.strictEqual(spawnE.result, 'error');
    assert.strictEqual(spawnE.error_code, 'E_ARGS');
    assert.strictEqual(evalE.result, 'ok');
    assert.strictEqual(evalE.error_code, null);
    assert.strictEqual(wake.text, 'belay: worker w1 finished turn 1.');
    assert.deepStrictEqual(waitE.ids, { worker_ids: 'w1,w2' });
    assert.strictEqual(res.total_cost_usd, 1.5);
    assert.strictEqual(res.num_turns, 2);
    assert.strictEqual(j.skipped_lines, 2, 'the malformed line and the subagent line');
    assert.strictEqual(j.followed, false);
    assert.strictEqual(j.stream_bytes, fs.statSync(`${orch}/stream.jsonl`).size);
    assert.ok(!JSON.stringify(j).includes('SECRET PROMPT') && !JSON.stringify(j).includes('PARTIAL') && !JSON.stringify(j).includes('SUBAGENT'));

    const tx = cli([RUN, '--dir', orch], dataDir, { json: false });
    assert.strictEqual(tx.status, 0, tx.stderr);
    assert.ok(tx.stdout.includes('worker_spawn worker_id=w1 task_id=t1 -> E_ARGS'), tx.stdout);
    assert.ok(tx.stdout.includes('task_evaluate task_id=t1 -> ok'));
    assert.ok(tx.stdout.includes('! belay: worker w1 finished turn 1.'));
    assert.ok(tx.stdout.includes('turn end  turns 2  stop end_turn  total_cost_usd $1.5'));
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(tx.stdout), 'no control character reaches the text');
    for (const line of tx.stdout.split('\n')) assert.ok(Array.from(line).length <= 120, `line over 120 columns: ${line}`);

    assert.deepStrictEqual(snapshot(dataDir, orch), before, 'a read writes no file and touches none');
  } finally { cleanup(dir); }
});

test('transcript: the default stream is <tmpdir>/belay-run/<run-id>/stream.jsonl, a missing stream is exit 0 and says so, an unknown run is exit 1', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const tmp = `${dir}/tmp`;
  try {
    await plantRun(dataDir);
    fs.mkdirSync(`${tmp}/belay-run/${RUN}`, { recursive: true });
    const env = { TEMP: tmp, TMP: tmp, TMPDIR: tmp };

    const none = cli([], dataDir, { env, json: false });
    assert.strictEqual(none.status, 0, none.stderr);
    assert.ok(none.stdout.replace(/\s+/g, ' ').includes('(no stream file yet)'), none.stdout); // the line wraps at 120 columns, wherever the temp path puts the break
    assert.ok(none.stdout.includes('(chosen by run.list)'));

    fs.writeFileSync(`${tmp}/belay-run/${RUN}/stream.jsonl`, text('hello from the default path'));
    const r = cli([RUN], dataDir, { env });
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.run_id_source, 'argument');
    assert.deepStrictEqual(j.entries.map((e) => e.text), ['hello from the default path']);
    assert.ok(j.stream_path.endsWith(`/belay-run/${RUN}/stream.jsonl`), j.stream_path);

    const bad = cli(['run-nope'], dataDir, { env });
    assert.strictEqual(bad.status, 1);
    assert.strictEqual(JSON.parse(bad.stderr).error.code, 'E_NOT_FOUND');
  } finally { cleanup(dir); }
});

test('transcript: usage errors are exit 2 and create nothing', () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    for (const args of [['--for', '0'], ['--for', 'x'], ['--dir'], ['a', 'b'], ['--nope']]) {
      const r = cli(args, dataDir, { json: false });
      assert.strictEqual(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
      assert.ok(r.stderr.includes('usage: belay transcript'));
    }
    assert.strictEqual(fs.existsSync(dataDir), false);
  } finally { cleanup(dir); }
});

test('transcript -f: reads appended bytes from an offset, completes a partial line on a later poll, and ends on --for', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const orch = `${dir}/orch`;
  try {
    await plantRun(dataDir);
    fs.mkdirSync(orch, { recursive: true });
    const file = `${orch}/stream.jsonl`;
    fs.writeFileSync(file, text('first words'));
    const running = followAsync([RUN, '-f', '--for', '12000', '--dir', orch], dataDir);
    assert.ok(await running.seen('first words'), 'the follow never printed the line it started from');
    const half = text('second words, written in two parts');
    const cut = Math.floor(half.length / 2);
    fs.appendFileSync(file, text('later words') + half.slice(0, cut));
    assert.ok(await running.seen('later words'), 'the follow never read the appended whole line');
    fs.appendFileSync(file, half.slice(cut)); // the partial line is completed on a later poll
    assert.ok(await running.seen('second words, written in two parts'), 'the completed line never arrived');
    const r = await running.done;
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /ended because: bound[.] entries: 3[.]/);
    const at = ['first words', 'later words', 'second words, written in two parts'].map((w) => r.stdout.indexOf(w));
    assert.ok(at[0] >= 0 && at[0] < at[1] && at[1] < at[2], r.stdout);
  } finally { cleanup(dir); }
});

test('makeFolder: a tool call waits for its result and flush returns the ones still waiting with no result', () => {
  const f = makeFolder();
  assert.deepStrictEqual(f.feed(toolUse('a', 'mcp__belay__task_create', { id: 't9', depends_on: ['t1', 't2'] }).trim()), []);
  const done = f.feed(toolResult('a', 'plain failure E_BUSY here', true).trim());
  assert.strictEqual(done.length, 1);
  assert.strictEqual(done[0].error_code, 'E_BUSY');
  assert.deepStrictEqual(done[0].ids, { id: 't9', depends_on: 't1,t2' });
  f.feed(toolUse('b', 'Bash', { command: 'ls' }).trim());
  const rest = f.flush();
  assert.deepStrictEqual(rest.map((e) => [e.tool, e.result]), [['Bash', null]]);
  assert.deepStrictEqual(f.flush(), []);
});

test('makeFolder: any user line starting `belay: ` is kind belay, a run-resume line included; an operator line stays operator', () => {
  const f = makeFolder();
  const user = (t) => L({ type: 'user', message: { role: 'user', content: t }, parent_tool_use_id: null, timestamp: TS }).trim();
  assert.deepStrictEqual(f.feed(user('belay: worker w1 finished turn 1.')).map((e) => e.kind), ['belay']);
  assert.deepStrictEqual(f.feed(user('belay: operator:7 has been resumed now. Carry on.')).map((e) => e.kind), ['belay']);
  assert.deepStrictEqual(f.feed(user('operator: please wait')).map((e) => e.kind), ['operator']);
  assert.deepStrictEqual(f.feed(user('belayed: not ours')).map((e) => e.kind), []);
  assert.strictEqual(makeFolder().feed(L({ type: 'result', num_turns: '2\u001b[31m' }).trim()).length, 1);
});

test('transcript: no run rows at all is exit 0 with an empty result and creates nothing', () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    const r = cli([], dataDir);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepStrictEqual([j.run_id, j.entries], [null, []]);
    assert.ok(cli([], dataDir, { json: false }).stdout.includes('(no run rows exist)'));
    assert.strictEqual(fs.existsSync(dataDir), false);
    assert.strictEqual(cli(['run-nope'], dataDir).status, 1, 'a named run that is not there stays exit 1');
  } finally { cleanup(dir); }
});

test('transcript -f: a stream that shrinks is read again from its start and says so', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const orch = `${dir}/orch`;
  try {
    await plantRun(dataDir);
    fs.mkdirSync(orch, { recursive: true });
    const file = `${orch}/stream.jsonl`;
    fs.writeFileSync(file, text('a long first line of words '.repeat(10)));
    const running = followAsync([RUN, '-f', '--for', '12000', '--dir', orch], dataDir);
    assert.ok(await running.seen('a long first line of words'), 'the follow never printed the line it started from');
    fs.writeFileSync(file, text('new'));
    assert.ok(await running.seen('new\n'), 'the follow never read the rewritten stream');
    const r = await running.done;
    assert.strictEqual(r.status, 0, r.stderr);
    const at = ['a long first line of words', 'shrank', 'new\n'].map((w) => r.stdout.indexOf(w));
    assert.ok(at[0] >= 0 && at[0] < at[1] && at[1] < at[2], r.stdout);
    assert.match(r.stdout, /entries: 3[.]/);
  } finally { cleanup(dir); }
});

test('transcript -f: ends on a dead orchestrator pid once the stream stops growing, well before --for', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const orch = `${dir}/orch`;
  try {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { windowsHide: true, stdio: 'ignore' });
    const exited = new Promise((r) => child.once('exit', r));
    const core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: RUN, pid: process.pid }, embed: false });
    try { await core.run.attach({ adapter_pid: process.pid, orchestrator_pid: child.pid }); } finally { await core.shutdownOwner(); await core.close(); }
    fs.mkdirSync(orch, { recursive: true });
    fs.writeFileSync(`${orch}/stream.jsonl`, text('words'));
    await exited;
    const r = await cliAsync([RUN, '-f', '--for', '60000', '--dir', orch], dataDir);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.ok(j.ended_because.includes('orchestrator pid dead'), j.ended_because);
    assert.ok(j.followed_ms < 30000, `followed ${j.followed_ms} ms against a 60000 ms bound`);
  } finally { cleanup(dir); }
});

test('transcript -f: SIGINT ends the follow as interrupted (the signal is emitted in-process by a preload, so it works on Windows too)', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const orch = `${dir}/orch`;
  try {
    await plantRun(dataDir);
    fs.mkdirSync(orch, { recursive: true });
    fs.writeFileSync(`${orch}/stream.jsonl`, text('words'));
    // process.emit reaches the process.once('SIGINT') listener without an OS signal; repeated so it lands after the listener is installed
    fs.writeFileSync(`${dir}/sigint.cjs`, "setTimeout(() => setInterval(() => process.emit('SIGINT'), 300).unref(), 1000).unref();\n");
    const cliPath = process.env.BELAY_TEST_CLI || CLI;
    const r = await new Promise((resolve) => {
      const proc = spawn(process.execPath, ['-r', `${dir}/sigint.cjs`, cliPath, 'transcript', RUN, '-f', '--for', '60000', '--dir', orch, '--data', dataDir, '--json'], { cwd: ROOT, windowsHide: true });
      let stdout = ''; proc.stdout.on('data', (d) => { stdout += d; });
      let stderr = ''; proc.stderr.on('data', (d) => { stderr += d; });
      proc.once('exit', (status) => resolve({ status, stdout, stderr }));
    });
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.ended_because, 'interrupted');
    assert.ok(j.followed_ms < 30000, `followed ${j.followed_ms} ms against a 60000 ms bound`);
  } finally { cleanup(dir); }
});
