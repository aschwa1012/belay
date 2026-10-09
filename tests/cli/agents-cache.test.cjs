'use strict';
// agents-cache.test.cjs — ADR 0036 amendment 1 sections 4 and 5. The prompt-cache timer, the task, the
// display state and the run's mode of `belay agents`. The derivations are driven in process with an
// injected `now` over fixture stream files; one subprocess test plants rows in a sandbox store.
// Never a real data dir.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');

const { openCore } = require('../../src/core/index.cjs');
const { scanTail, renderText } = require('../../src/cli/cmd-agents.cjs');
const D = require('../../src/cli/agents-derive.cjs');
const { ROOT, CLI, sandbox, cleanup } = require('./stop-helpers.cjs');

const RUN = 'run-c';
const L = (o) => `${JSON.stringify(o)}\n`;
const T0 = Date.parse('2026-10-08T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const usage = (cc) => ({ input_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, ...(cc === undefined ? {} : { cache_creation: cc }) });
const asst = (ts, cc, extra = {}, content = [{ type: 'text', text: 'x' }]) => L({ type: 'assistant', uuid: `u-${ts}`, timestamp: iso(ts), message: { role: 'assistant', model: 'claude-opus-5-5', content, usage: usage(cc) }, parent_tool_use_id: null, ...extra });
const h1 = { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 0 };
const m5 = { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 500 };
const none = { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 };

function cacheOfStream(dir, text, now) {
  const file = `${dir}/s.jsonl`;
  fs.writeFileSync(file, text);
  return D.cacheOf(scanTail(file), now);
}

test('cache: a 1-hour write gives ttl 3600 named by the line and field; warm, low at under ten minutes, cold at zero', () => {
  const dir = sandbox();
  try {
    const text = asst(T0, h1);
    const warm = cacheOfStream(dir, text, T0 + 51 * 60000);
    assert.strictEqual(warm.ttl_s, 3600);
    assert.match(warm.ttl_established_by, /uuid u-.*ephemeral_1h_input_tokens=500/);
    assert.strictEqual(warm.last_request_at_ms, T0);
    assert.strictEqual(warm.age_ms, 51 * 60000);
    assert.strictEqual(warm.left_ms, 9 * 60000);
    assert.strictEqual(warm.state, 'low'); // 9 minutes left of an hour: under the ten-minute cap
    assert.strictEqual(cacheOfStream(dir, text, T0 + 50 * 60000).state, 'warm'); // exactly ten minutes left is not under it
    assert.strictEqual(cacheOfStream(dir, text, T0 + 10 * 60000).state, 'warm');
    const cold = cacheOfStream(dir, text, T0 + 3600000);
    assert.strictEqual(cold.state, 'cold');
    assert.strictEqual(cold.left_ms, 0);
    assert.strictEqual(cacheOfStream(dir, text, T0 + 2 * 3600000).left_ms, -3600000);
    assert.strictEqual(D.cacheText(cacheOfStream(dir, text, T0 + 9 * 60000)), '51m warm');
    assert.strictEqual(D.cacheText(cold), 'cold');
  } finally { cleanup(dir); }
});

test('cache: a 5-minute write gives ttl 300 and goes low under a fifth of it (60 s), not under ten minutes', () => {
  const dir = sandbox();
  try {
    const text = asst(T0, m5);
    const a = cacheOfStream(dir, text, T0 + 100000);
    assert.strictEqual(a.ttl_s, 300);
    assert.match(a.ttl_established_by, /ephemeral_5m_input_tokens=500/);
    assert.strictEqual(a.state, 'warm');
    assert.strictEqual(cacheOfStream(dir, text, T0 + 240000).state, 'warm'); // 60 s left, not under 60 s
    assert.strictEqual(cacheOfStream(dir, text, T0 + 241000).state, 'low');
    assert.strictEqual(cacheOfStream(dir, text, T0 + 300000).state, 'cold');
  } finally { cleanup(dir); }
});

test('cache: a latest line that only read still sets the age, and the lifetime comes from the earlier line that wrote', () => {
  const dir = sandbox();
  try {
    const text = asst(T0, h1) + asst(T0 + 20 * 60000, none) + asst(T0 + 30 * 60000, none);
    const c = cacheOfStream(dir, text, T0 + 40 * 60000);
    assert.strictEqual(c.ttl_s, 3600);
    assert.strictEqual(c.last_request_at_ms, T0 + 30 * 60000);
    assert.strictEqual(c.age_ms, 10 * 60000);
    assert.strictEqual(c.left_ms, 50 * 60000);
    assert.match(c.ttl_established_by, new RegExp(`u-${T0}\\b`));
    // the most recent writer wins when the lifetimes differ
    const mixed = asst(T0, h1) + asst(T0 + 60000, m5);
    assert.strictEqual(cacheOfStream(dir, mixed, T0 + 120000).ttl_s, 300);
  } finally { cleanup(dir); }
});

test('cache: no split anywhere in the tail is unknown, with no lifetime assumed and the reason named; so is a missing split object, a missing stream and a Codex stream', () => {
  const dir = sandbox();
  try {
    for (const text of [asst(T0, none), asst(T0, undefined)]) {
      const c = cacheOfStream(dir, text, T0 + 1000);
      assert.strictEqual(c.ttl_s, null);
      assert.strictEqual(c.state, 'unknown');
      assert.strictEqual(c.left_ms, null);
      assert.strictEqual(c.last_request_at_ms, T0);
      assert.match(c.ttl_established_by, /non-zero message\.usage\.cache_creation split.*not assumed/);
      assert.strictEqual(D.cacheText(c), '?');
    }
    const missing = D.cacheOf(scanTail(`${dir}/absent.jsonl`), T0);
    assert.strictEqual(missing.state, 'unknown');
    assert.match(missing.ttl_established_by, /no stream/);
    assert.match(D.cacheOf({ exists: false, skipped: 'a Codex stream is not parsed' }, T0).ttl_established_by, /Codex/);
  } finally { cleanup(dir); }
});

test('cache: subagent lines and synthetic messages are not the agent\'s own and set neither the age nor the lifetime', () => {
  const dir = sandbox();
  try {
    const own = asst(T0, h1);
    const sub = asst(T0 + 30 * 60000, m5, { parent_tool_use_id: 'toolu_x' });
    const synth = L({ type: 'assistant', timestamp: iso(T0 + 31 * 60000), message: { model: '<synthetic>', content: [], usage: usage(m5) }, parent_tool_use_id: null });
    const c = cacheOfStream(dir, own + sub + synth, T0 + 51 * 60000);
    assert.strictEqual(c.last_request_at_ms, T0);
    assert.strictEqual(c.ttl_s, 3600);
    assert.strictEqual(c.state, 'low');
  } finally { cleanup(dir); }
});

test('display state (orchestrator): result idle, an unanswered tool call waiting, a fresh text line running, an old one stalled; ended, dead and paused by the run row', () => {
  const dir = sandbox();
  try {
    const scanOf = (text, mtime) => { const f = `${dir}/o.jsonl`; fs.writeFileSync(f, text); return { ...scanTail(f), mtime_ms: mtime }; };
    const run = { alive: true, ended_at: null, paused_at: null };
    const tool = [{ type: 'tool_use', id: 't1', name: 'mcp__belay__worker_wait', input: {} }];
    const idle = D.orchestratorDisplay(run, scanOf(asst(T0, h1) + L({ type: 'result', total_cost_usd: 1 }), T0), T0 + 1000);
    assert.strictEqual(idle.display_state, 'idle');
    assert.match(idle.display_state_established_by, /result line/);
    const wait = D.orchestratorDisplay(run, scanOf(asst(T0, h1, {}, tool), T0), T0 + 3600000); // a long wait is not a stall
    assert.strictEqual(wait.display_state, 'waiting');
    assert.match(wait.display_state_established_by, /worker_wait/);
    const subLater = scanOf(asst(T0, h1, {}, tool) + asst(T0 + 1, h1, { parent_tool_use_id: 'toolu_x' }), T0);
    assert.strictEqual(D.orchestratorDisplay(run, subLater, T0).display_state, 'waiting'); // a subagent's line does not end the call
    const text = scanOf(asst(T0, h1), T0);
    assert.strictEqual(D.orchestratorDisplay(run, text, T0 + 60000).display_state, 'running');
    assert.strictEqual(D.orchestratorDisplay(run, text, T0 + 400000).display_state, 'stalled');
    assert.strictEqual(D.orchestratorDisplay(run, scanOf('', T0), T0).display_state, 'unknown');
    assert.match(D.orchestratorDisplay(run, scanOf('', T0), T0).display_state_established_by, /cannot be told apart/);
    // S1: any other unanswered call is mid-turn and ages from its own line's timestamp, however fresh the stream file is
    const bash = [{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }];
    const hung = scanOf(asst(T0, h1, {}, bash), T0 + 390000);
    assert.strictEqual(D.orchestratorDisplay(run, hung, T0 + 60000).display_state, 'running');
    const stalledCall = D.orchestratorDisplay(run, hung, T0 + 400000);
    assert.strictEqual(stalledCall.display_state, 'stalled');
    assert.match(stalledCall.display_state_established_by, /unanswered call to Bash, most overdue call \(Bash\) line timestamp 400000 ms ago \(bound 300000 ms\)/);
    // N2: parallel calls are all named, an answered one is not, and one worker_wait among them is a wait
    const call = (id, name, ts) => asst(ts, h1, {}, [{ type: 'tool_use', id, name, input: {} }]);
    const result1 = L({ type: 'user', timestamp: iso(T0 + 2000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'p1', content: 'ok' }] }, parent_tool_use_id: null });
    const parallel = scanOf(call('p1', 'Read', T0 + 1000) + call('p2', 'Bash', T0 + 1001) + call('p3', 'mcp__belay__worker_wait', T0 + 1002) + result1, T0);
    assert.deepStrictEqual(parallel.tail_event.calls.map((c) => c.name), ['Bash', 'mcp__belay__worker_wait']);
    assert.strictEqual(parallel.tail_event.kind, 'user');
    const pw = D.orchestratorDisplay(run, parallel, T0 + 3600000);
    assert.strictEqual(pw.display_state, 'waiting');
    assert.match(pw.display_state_established_by, /Bash, mcp__belay__worker_wait/);
    assert.strictEqual(D.orchestratorDisplay({ ...run, ended_at: 1 }, text, T0).display_state, 'done');
    assert.strictEqual(D.orchestratorDisplay({ ...run, alive: false }, text, T0).display_state, 'dead');
    const paused = D.orchestratorDisplay({ ...run, paused_at: 1 }, text, T0);
    assert.strictEqual(paused.display_state, 'idle');
    assert.match(paused.display_state_established_by, /adapter pid's liveness, not the orchestrator process's/);
  } finally { cleanup(dir); }
});

test('task: the unreleased lease the worker holds wins over the row task_id; the title is the first non-empty line of the spec, with its sources named', () => {
  const t1 = { id: 'task-1', spec: '\n  Fix the thing\nmore detail' };
  const t2 = { id: 'task-2', spec: '' };
  const byId = new Map([[t1.id, t1], [t2.id, t2]]);
  const held = D.currentTask({ id: 'w1', task_id: 'task-2' }, byId, new Map([['w1', t1]]));
  assert.deepStrictEqual(held, { id: 'task-1', title: 'Fix the thing', title_source: 'first non-empty line of the task spec', source: 'unreleased lease held by this worker (task.list lease.holder)' });
  const row = D.currentTask({ id: 'w1', task_id: 'task-2' }, byId, new Map());
  assert.strictEqual(row.id, 'task-2');
  assert.strictEqual(row.title, null);
  assert.match(row.source, /worker row task_id/);
  assert.strictEqual(D.currentTask({ id: 'w1', task_id: null }, byId, new Map()), null);
});

test('cache: a line with both splits non-zero is a 1-hour write; the age comes from the earliest line of the latest message', () => {
  const dir = sandbox();
  try {
    const both = { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 400 };
    assert.strictEqual(cacheOfStream(dir, asst(T0, both), T0 + 1000).ttl_s, 3600);
    const msg = (ts, id, cc) => asst(ts, cc, { uuid: `l-${ts}` }).replace('"role":"assistant"', `"id":"${id}","role":"assistant"`);
    const text = msg(T0, 'msg-a', h1) + msg(T0 + 5 * 60000, 'msg-b', none) + msg(T0 + 5 * 60000 + 3000, 'msg-b', none) + msg(T0 + 5 * 60000 + 9000, 'msg-b', none);
    const c = cacheOfStream(dir, text, T0 + 20 * 60000);
    assert.strictEqual(c.last_request_at_ms, T0 + 5 * 60000); // not the third line of msg-b, not msg-a
    assert.strictEqual(c.ttl_s, 3600);
  } finally { cleanup(dir); }
});

test('display state (worker): a no-pid starting row is starting, a Codex idle row is idle whatever its pid, a dead pid is dead only where a pid was recorded; stopping and the unprovable are named, not guessed', () => {
  const row = (o) => ({ id: 'w', substrate: 'claude-code', ...o });
  const st = (o, extra = {}) => D.workerDisplay(row(o), { pending: false, stall: null, ...extra });
  const starting = st({ state: 'starting', pid: null, pid_alive: false });
  assert.strictEqual(starting.display_state, 'starting');
  assert.match(starting.display_state_established_by, /no pid recorded yet/);
  const codex = st({ substrate: 'codex', state: 'idle', pid: 4242, pid_alive: false });
  assert.strictEqual(codex.display_state, 'idle');
  assert.match(codex.display_state_established_by, /Codex between turns has no process by design \(api\.md §2\)/);
  assert.strictEqual(st({ state: 'running', pid: 4242, pid_alive: false }).display_state, 'dead');
  assert.strictEqual(st({ substrate: 'codex', state: 'running', pid: 4242, pid_alive: false }).display_state, 'dead');
  assert.strictEqual(st({ state: 'running', pid: null, pid_alive: false }).display_state, 'unknown'); // no pid, so no dead pid to cite
  assert.strictEqual(st({ state: 'stopping', pid: 4242, pid_alive: true }).display_state, 'stopping');
  assert.strictEqual(st({ state: 'running', pid: 4242, pid_alive: null }).display_state, 'unknown');
  assert.strictEqual(st({ state: 'mystery', pid: 4242, pid_alive: true }).display_state, 'unknown');
  assert.match(st({ state: 'mystery', pid: 4242, pid_alive: true }).display_state_established_by, /not one this derivation knows/);
});

test('mode: the launcher marker names an interactive run; the receipt answers only for this run and epoch; a stream with no marker is headless; otherwise null with the reason', () => {
  const dir = sandbox();
  const run = { id: RUN, epoch: 2, started_at: T0 };
  const fresh = { first_ts_ms: T0 + 1000, birthtime_ms: T0 + 1000 };
  const run1 = { ...run, epoch: 1 };
  const put = (name, v) => fs.writeFileSync(`${dir}/${name}`, typeof v === 'string' ? v : JSON.stringify(v));
  const receipt = (o) => ({ run_id: RUN, mode: 'headless', store: { attach: { epoch: 2 }, ended: { epoch: 2 } }, ...o });
  try {
    assert.strictEqual(D.modeOf(dir, run, null).mode, null);
    assert.match(D.modeOf(dir, run, null).mode_source, /run-start\.json does not exist.*run\.json does not exist.*no orchestrator stream/);
    const headless = D.modeOf(dir, run1, fresh);
    assert.strictEqual(headless.mode, 'headless');
    assert.match(headless.mode_source, /epoch 1; a stream exists.*run-start\.json does not exist.*inferred from the absence of a launch marker/);
    put('run.json', receipt({}));
    assert.deepStrictEqual([D.modeOf(dir, run, null).mode, D.modeOf(dir, run, fresh).mode], ['headless', 'headless']);
    put('run.json', receipt({ mode: 'interactive' }));
    assert.strictEqual(D.modeOf(dir, run, null).mode, 'interactive');
    put('run.json', receipt({ store: { attach: { epoch: 1 }, ended: { epoch: 1 } }, mode: 'interactive' })); // an earlier epoch's receipt
    const old = D.modeOf(dir, run, null);
    assert.strictEqual(old.mode, null);
    assert.match(old.mode_source, /epoch 1\/1 does not match the run row's epoch 2/);
    const shared = D.modeOf(dir, run, fresh); // epoch 2: the appended stream cannot show it
    assert.strictEqual(shared.mode, null);
    assert.match(shared.mode_source, /shared across epochs.*cannot show epoch 2's mode; the launch marker is the source/);
    put('run.json', receipt({ run_id: 'other-run', mode: 'interactive' }));
    assert.match(D.modeOf(dir, run, null).mode_source, /names another run/);
    put('run.json', '{not json');
    assert.match(D.modeOf(dir, run, null).mode_source, /run\.json is unreadable/);
    put('run-start.json', { run_id: 'other-run', mode: 'interactive', started_at: 1, launcher_pid: 1 });
    assert.strictEqual(D.modeOf(dir, run1, fresh).mode, 'headless');
    put('run-start.json', { run_id: RUN, epoch: 1, mode: 'interactive', started_at: 1, launcher_pid: 1 });
    assert.strictEqual(D.modeOf(dir, run, null).mode, null); // a marker of an earlier epoch of this run does not answer
    put('run-start.json', { run_id: RUN, epoch: 2, mode: 'interactive', started_at: 1, launcher_pid: 1 });
    assert.strictEqual(D.modeOf(dir, run, null).mode, 'interactive');
    assert.match(D.modeOf(dir, run, null).mode_source, /run-start\.json run_id/);
  } finally { cleanup(dir); }
});

function cli(args, dataDir) {
  return spawnSync(process.execPath, [CLI, 'agents', ...args, '--data', dataDir, '--json'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
}

test('agents: task, display_state and cache per worker and the run mode, through the built CLI', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const orchDir = `${dir}/orch`;
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
  const now = Date.now();
  let orch, w7;
  try {
    orch = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: RUN, pid: process.pid }, embed: false });
    const att = await orch.run.attach({ adapter_pid: process.pid });
    const t = await orch.task.create({ spec: 'Widen the agents table\nwith more columns' });
    const t3 = await orch.task.create({ spec: 'Held by lease\nsecond line' });
    const base = { substrate: 'claude-code', pid: process.pid, started_at: now - 700000 };
    await orch.worker.write({ id: 'w1', ...base, state: 'running', mid_turn: 1, last_event_at: now - 1000, task_id: t.id, model: 'claude-sonnet-5-5', effort_requested: 'medium', permission_mode_effective: 'auto', claude_code_version: '2.1.300' });
    await orch.worker.write({ id: 'w2', ...base, state: 'running', mid_turn: 0 });
    await orch.worker.write({ id: 'w3', ...base, state: 'running', mid_turn: 1, last_event_at: now - 600000 });
    await orch.task.assign({ task_id: t3.id, worker_id: 'w3' });
    await orch.worker.write({ id: 'w10', substrate: 'claude-code', state: 'starting', started_at: now - 1000 });
    await orch.worker.write({ id: 'w4', ...base, state: 'running' });
    await orch.worker.write({ id: 'w4', state: 'paused', paused_at: now - 5000, paused_by: 'operator' });
    await orch.worker.write({ id: 'w5', ...base, state: 'running' });
    await orch.worker.write({ id: 'w5', state: 'dead', exited_at: now - 5000, exit_code: 1, death_established_by: 'pid not alive' });
    await orch.worker.write({ id: 'w6', ...base, state: 'running' });
    await orch.worker.write({ id: 'w6', state: 'stopped', exited_at: now - 5000, exit_code: 0 });
    await orch.worker.write({ id: 'w7', ...base, state: 'running', mid_turn: 1, last_event_at: now - 1000 });
    await orch.worker.write({ id: 'w8', ...base, pid: child.pid, state: 'running', mid_turn: 1, last_event_at: now - 1000 });
    const exited = new Promise((r) => child.once('exit', r));
    child.kill();
    await exited; // the row was written while the pid lived; now it is gone
    await orch.worker.write({ id: 'w9', ...base, substrate: 'codex', state: 'idle' });
    w7 = await openCore({ dataDir, caller: { role: 'worker', worker_id: 'w7', run_id: RUN, pid: process.pid }, embed: false });
    await w7.permission.request({ id: 'tu-1', tool: 'Bash', input: { command: 'ls' } });

    fs.mkdirSync(`${dataDir}/workers/w1`, { recursive: true });
    fs.writeFileSync(`${dataDir}/workers/w1/stream.jsonl`, asst(now - 600000, h1) + asst(now - 120000, none));
    fs.mkdirSync(orchDir, { recursive: true });
    fs.writeFileSync(`${orchDir}/run-start.json`, JSON.stringify({ run_id: RUN, epoch: att.epoch ?? att.run.epoch, mode: 'interactive', started_at: now, launcher_pid: process.pid }));
    fs.writeFileSync(`${orchDir}/stream.jsonl`, asst(now - 1000, h1) + L({ type: 'result', total_cost_usd: 1 }));

    const r = cli([RUN, '--dir', orchDir], dataDir);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    const by = Object.fromEntries(j.agents.map((a) => [a.id, a]));
    assert.strictEqual(j.mode, 'interactive');
    assert.match(j.mode_source, /run-start\.json/);
    assert.ok(Number.isSafeInteger(j.started_at_ms));
    assert.strictEqual(j.paused_at_ms, null);
    assert.strictEqual(j.ended_at_ms, null);
    assert.deepStrictEqual(j.tasks, { done: 0, total: 2 });
    assert.strictEqual(j.max_fix_rounds, null);

    assert.deepStrictEqual(by.w1.task, { id: t.id, title: 'Widen the agents table', title_source: 'first non-empty line of the task spec', source: 'worker row task_id (no unreleased lease held by this worker)' });
    assert.strictEqual(by.w3.task.id, t3.id); // held by lease, no task_id on the row
    assert.match(by.w3.task.source, /unreleased lease/);
    assert.strictEqual(by.w3.task.title, 'Held by lease');
    assert.strictEqual(by.w1.pid, process.pid);
    assert.strictEqual(by.w1.permission_mode, 'auto');
    assert.strictEqual(by.w1.claude_code_version, '2.1.300');
    assert.strictEqual(by.w2.claude_code_version, null);
    assert.strictEqual(by.orchestrator.pid, null);
    assert.strictEqual(by.w2.task, null);
    assert.strictEqual(by.orchestrator.task, null);
    assert.strictEqual(by.w1.model, 'claude-sonnet-5-5');
    assert.strictEqual(by.w1.effort, 'medium');
    assert.strictEqual(by.w1.cache.ttl_s, 3600);
    assert.strictEqual(by.w1.cache.state, 'warm');
    assert.ok(Math.abs(by.w1.cache.age_ms - 120000) < 60000);
    assert.strictEqual(by.w2.cache.state, 'unknown');
    assert.strictEqual(by.w9.cache.state, 'unknown');
    assert.match(by.w9.cache.ttl_established_by, /Codex/);

    const states = Object.fromEntries(j.agents.map((a) => [a.id, a.display_state]));
    assert.deepStrictEqual(states, { orchestrator: 'idle', w1: 'running', w2: 'idle', w3: 'stalled', w4: 'parked', w5: 'dead', w6: 'done', w7: 'permission', w8: 'dead', w9: 'idle', w10: 'starting' });
    assert.match(by.w3.display_state_established_by, /last event \d+ ms ago by row/);
    assert.match(by.w8.display_state_established_by, /not alive/);
    assert.match(by.w4.display_state_established_by, /ADR 0023 amendment 2/);
    assert.match(by.w7.display_state_established_by, /pending permission/);

    const text = renderText(j); // the text table, over the same receipt: a second CLI call here waits about 30 s on the open owner
    assert.match(text, /w1 .*display running\n {2}task \S+ Widen the agents table {2}cache 5\dm warm\n/);
    assert.match(text, /w2 .*display idle\n {2}task - {2}cache \?\n/);
    for (const line of text.split('\n')) assert.ok(Array.from(line).length <= 120, line);
  } finally {
    child.kill();
    if (w7) await w7.close();
    if (orch) { await orch.shutdownOwner(); await orch.close(); }
    cleanup(dir);
  }
});

test('mode: a stream that predates this epoch is not headless (first line timestamp, else birthtime, against the run row\'s started_at)', () => {
  const dir = sandbox();
  const run1 = { id: RUN, epoch: 1, started_at: T0 };
  try {
    const stale = D.modeOf(dir, run1, { first_ts_ms: T0 - 1000, birthtime_ms: T0 + 5000 });
    assert.strictEqual(stale.mode, null); // the first line's timestamp wins over a newer birthtime
    assert.match(stale.mode_source, /may predate this run \(first line timestamp/);
    assert.strictEqual(D.modeOf(dir, run1, { first_ts_ms: null, birthtime_ms: T0 - 1 }).mode, null);
    const born = D.modeOf(dir, run1, { first_ts_ms: null, birthtime_ms: T0 });
    assert.strictEqual(born.mode, 'headless');
    assert.match(born.mode_source, /file birthtime/);
    const file = `${dir}/stream.jsonl`;
    fs.writeFileSync(file, asst(T0 - 5000, h1) + asst(T0 + 9000, h1));
    assert.strictEqual(D.streamStart(file).first_ts_ms, T0 - 5000);
    assert.strictEqual(D.streamStart(`${dir}/absent.jsonl`), null);
  } finally { cleanup(dir); }
});

test('display state (orchestrator): a call is stalled only after max(300 s, its own bound): task_evaluate 600 s, a permission wait its timeout_ms; the most overdue unanswered call decides', () => {
  const dir = sandbox();
  try {
    const scanOf = (text) => { const f = `${dir}/o.jsonl`; fs.writeFileSync(f, text); return { ...scanTail(f), mtime_ms: T0 + 99999999 }; };
    const run = { alive: true, ended_at: null, paused_at: null };
    const call = (id, name, ts, input = {}) => asst(ts, h1, {}, [{ type: 'tool_use', id, name, input }]);
    const ev = scanOf(call('e1', 'mcp__belay__task_evaluate', T0));
    assert.strictEqual(D.orchestratorDisplay(run, ev, T0 + 330000).display_state, 'running'); // 5.5 minutes
    assert.strictEqual(D.orchestratorDisplay(run, ev, T0 + 630000).display_state, 'stalled'); // 10.5 minutes
    const perm = scanOf(call('p1', 'mcp__belay__permission_wait', T0, { timeout_ms: 900000 }));
    assert.strictEqual(D.orchestratorDisplay(run, perm, T0 + 630000).display_state, 'running');
    assert.strictEqual(D.orchestratorDisplay(run, perm, T0 + 930000).display_state, 'stalled');
    // two unanswered calls: only the earliest is past the bound, so the latest one's timestamp must not set the age
    const two = scanOf(call('a1', 'Bash', T0) + call('a2', 'Read', T0 + 200000));
    assert.strictEqual(D.orchestratorDisplay(run, two, T0 + 400000).display_state, 'stalled');
    // an overdue Bash is not excused by a task_evaluate that is within its longer bound
    const mixed = scanOf(call('m1', 'Bash', T0) + call('m2', 'mcp__belay__task_evaluate', T0 + 100000));
    assert.strictEqual(D.orchestratorDisplay(run, mixed, T0 + 400000).display_state, 'stalled');
  } finally { cleanup(dir); }
});

test('task: a worker holding two unreleased leases shows the newest grant', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  let orch;
  try {
    orch = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: RUN, pid: process.pid }, embed: false });
    await orch.run.attach({ adapter_pid: process.pid });
    const a = await orch.task.create({ spec: 'older task' });
    const b = await orch.task.create({ spec: 'newer task' });
    await orch.worker.write({ id: 'w1', substrate: 'claude-code', pid: process.pid, state: 'running', started_at: Date.now() - 1000 });
    await orch.task.assign({ task_id: a.id, worker_id: 'w1' });
    await new Promise((r) => setTimeout(r, 20));
    await orch.task.assign({ task_id: b.id, worker_id: 'w1' });
    const { tasks } = await orch.task.list({});
    const { workers } = await orch.worker.list({});
    const rows = await require('../../src/cli/cmd-agents.cjs').leaseTasksOf(tasks.filter((t) => t.run_id === RUN));
    assert.strictEqual(rows.get('w1').id, b.id);
    const w = workers.find((x) => x.id === 'w1');
    assert.strictEqual(D.currentTask(w, new Map(tasks.map((t) => [t.id, t])), rows).title, 'newer task');
  } finally {
    if (orch) { await orch.shutdownOwner(); await orch.close(); }
    cleanup(dir);
  }
});

test('mode: with epochs from the real core, epoch 2 reading epoch 1\'s appended stream is null, never headless; epoch 1 with that stream is headless', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  let orch;
  try {
    orch = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: RUN, pid: process.pid }, embed: false });
    await orch.run.attach({ adapter_pid: process.pid });
    const row = async () => (await orch.run.list({})).runs.find((r) => r.id === RUN);
    const e1 = await row();
    await orch.run.end({ exit_reason: 'idle' });
    await orch.run.attach({ adapter_pid: process.pid });
    const e2 = await row();
    assert.strictEqual(e1.epoch, 1);
    assert.strictEqual(e2.epoch, 2);
    assert.strictEqual(e2.started_at, e1.started_at); // inherited across epochs
    const file = `${dir}/stream.jsonl`;
    fs.writeFileSync(file, asst(e1.started_at + 5, h1)); // epoch 1's stream, appended to by epoch 2
    const stream = D.streamStart(file);
    assert.strictEqual(D.modeOf(dir, e1, stream).mode, 'headless');
    const second = D.modeOf(dir, e2, stream);
    assert.strictEqual(second.mode, null);
    assert.match(second.mode_source, /shared across epochs/);
  } finally {
    if (orch) { await orch.shutdownOwner(); await orch.close(); }
    cleanup(dir);
  }
});

test('display state (orchestrator): a newer call past its own bound stalls the orchestrator even when the oldest call is still within its larger one', () => {
  const dir = sandbox();
  try {
    const f = `${dir}/o.jsonl`;
    const call = (id, name, ts) => asst(ts, h1, {}, [{ type: 'tool_use', id, name, input: {} }]);
    fs.writeFileSync(f, call('e1', 'mcp__belay__task_evaluate', T0) + call('b1', 'Bash', T0 + 60000));
    const scan = { ...scanTail(f), mtime_ms: T0 };
    const run = { alive: true, ended_at: null, paused_at: null };
    // 7 min after the evaluate (bound 10 min: within), 6 min after the Bash (bound 5 min: past)
    const d = D.orchestratorDisplay(run, scan, T0 + 420000);
    assert.strictEqual(d.display_state, 'stalled');
    assert.match(d.display_state_established_by, /most overdue call \(Bash\)/);
  } finally { cleanup(dir); }
});
