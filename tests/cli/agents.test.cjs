'use strict';
// agents.test.cjs — ADR 0036 decisions 5a and 5b, build step U1. Drives the built CLI's `agents` as a
// subprocess against a sandbox store planted through the core, with fixture stream files (the
// orchestrator's under the OS tmp dir, a worker's under its sandbox data dir). Never a real data dir.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const { openCore } = require('../../src/core/index.cjs');
const { scanTail, contextOf, TAIL_MAX_BYTES } = require('../../src/cli/cmd-agents.cjs');
const { ROOT, CLI, sandbox, cleanup } = require('./stop-helpers.cjs');

const RUN = 'run-a';
const L = (o) => `${JSON.stringify(o)}\n`;
const WINDOW = 1000000;
const asst = (model, usage, extra = {}) => L({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text: 'x' }], usage }, parent_tool_use_id: null, timestamp: '2026-10-04T10:00:01.000Z', ...extra });
const result = (model, cost, window = WINDOW) => L({ type: 'result', is_error: false, total_cost_usd: cost, modelUsage: { [model]: { costUSD: cost, ...(window == null ? {} : { contextWindow: window }) } } });
const tick = (iso) => L({ type: 'user', message: { role: 'user', content: 'x' }, parent_tool_use_id: null, timestamp: iso });

function cli(args, dataDir, { json = true } = {}) {
  return spawnSync(process.execPath, [CLI, 'agents', ...args, '--data', dataDir, ...(json ? ['--json'] : [])], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
}

async function withOwner(dataDir, fn, attach = {}) {
  const core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: RUN, pid: process.pid }, embed: false });
  try { await core.run.attach({ adapter_pid: process.pid, ...attach }); return await fn(core); } finally { await core.shutdownOwner(); await core.close(); }
}

// w1 claude-code with a cost; w2 a Codex worker with none; w3 a claude-code worker holding a review task.
async function plant(dataDir, { end = null } = {}) {
  await withOwner(dataDir, async (orch) => {
    const t0 = Date.now() - 60000;
    await orch.worker.write({ id: 'w1', substrate: 'claude-code', pid: process.pid, state: 'running', started_at: t0, model: 'claude-sonnet-5-5', effort_requested: 'medium', cost_usd: 0.25 });
    await orch.worker.write({ id: 'w2', substrate: 'codex', pid: process.pid, state: 'running', started_at: t0 });
    const rv = await orch.task.create({ spec: 'review it', acceptance: { verdict: true } });
    await orch.worker.write({ id: 'w3', substrate: 'claude-code', pid: process.pid, state: 'running', started_at: t0, task_id: rv.id, effort_requested: 'high' });
    if (end) await orch.run.end(end);
  }, { orch_effort_requested: 'xhigh' });
}

function orchestratorStream() {
  return [
    asst('claude-opus-5-5', { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }),
    result('claude-opus-5-5', 0.5),
    tick('2026-10-04T10:00:05.000Z'),
    asst('claude-opus-5-5', { input_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }),
    tick('2026-10-04T10:00:09.000Z'),
    result('claude-opus-5-5', 1.25),
    // not the agent's own context: a subagent's line and a synthetic message come after
    asst('claude-opus-5-5', { input_tokens: 999999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, { parent_tool_use_id: 'toolu_x' }),
    asst('<synthetic>', { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
  ].join('');
}

test('agents: one row for the orchestrator and one per worker, context from the last assistant usage against the result line\'s window, cost by its source, the run cost meter as the footer', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const orch = `${dir}/orch`;
  try {
    await plant(dataDir);
    fs.mkdirSync(orch, { recursive: true });
    fs.writeFileSync(`${orch}/stream.jsonl`, orchestratorStream());
    fs.mkdirSync(`${dataDir}/workers/w1`, { recursive: true });
    fs.writeFileSync(`${dataDir}/workers/w1/stream.jsonl`, [
      asst('claude-sonnet-5-5', { input_tokens: 50, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 }),
      result('claude-sonnet-5-5', 0.25, 500000),
    ].join(''));
    fs.mkdirSync(`${dataDir}/workers/w3`, { recursive: true });
    fs.writeFileSync(`${dataDir}/workers/w3/stream.jsonl`, asst('claude-opus-5-5', { input_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }));

    const r = cli([RUN, '--dir', orch], dataDir);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    const by = Object.fromEntries(j.agents.map((a) => [a.id, a]));
    assert.deepStrictEqual(j.agents.map((a) => a.id), ['orchestrator', 'w1', 'w2', 'w3']);

    const o = by.orchestrator;
    assert.strictEqual(o.role, 'orchestrator');
    assert.strictEqual(o.model, 'claude-opus-5-5');
    assert.strictEqual(o.effort, 'xhigh');
    assert.strictEqual(o.context_tokens, 1203, 'the LAST assistant message of the agent itself: 3 + 1000 + 200');
    assert.strictEqual(o.context_window, WINDOW);
    assert.strictEqual(o.context_pct, 0.1);
    assert.strictEqual(o.cost_usd, 1.25, 'the latest result line, never the sum of the cumulative totals');
    assert.ok(o.cost_source.includes('stream result line total_cost_usd'), o.cost_source);

    assert.strictEqual(by.w1.cost_usd, 0.25);
    assert.strictEqual(by.w1.cost_source, 'worker row cost_usd');
    assert.strictEqual(by.w1.effort, 'medium');
    assert.strictEqual(by.w1.context_tokens, 4050);
    assert.strictEqual(by.w1.context_window, 500000, 'the window is the stream\'s own, not a constant');
    assert.strictEqual(by.w1.context_pct, 0.8);
    assert.strictEqual(by.w1.role, null);

    assert.strictEqual(by.w2.context_tokens, null, 'a Codex stream is not parsed');
    assert.strictEqual(by.w2.cost_usd, null);
    assert.strictEqual(by.w2.cost_source, null);

    assert.strictEqual(by.w3.role, 'reviewer');
    assert.ok(by.w3.role_source.includes('acceptance.verdict'));
    assert.strictEqual(by.w3.context_tokens, 7);
    assert.strictEqual(by.w3.context_window, null, 'no result line yet: tokens without a window');
    assert.strictEqual(by.w3.context_pct, null);

    assert.strictEqual(j.footer.agents, 4);
    assert.strictEqual(j.footer.total_cost_usd, 1.5);
    assert.strictEqual(j.footer.cost_not_recorded, 2, 'w2 and w3 have no cost');
    assert.strictEqual(j.footer.as_of_ms, Date.parse('2026-10-04T10:00:09.000Z'), 'dated by the last timestamped line before the newest result');
    assert.strictEqual(j.footer.highest_context_pct, 0.8);

    const tx = cli([RUN, '--dir', orch], dataDir, { json: false });
    assert.strictEqual(tx.status, 0, tx.stderr);
    assert.ok(tx.stdout.includes('context 1,203 of 1,000,000 tokens (0.1%)'), tx.stdout);
    assert.ok(tx.stdout.includes('context 7 tokens (window unknown)'));
    assert.ok(tx.stdout.includes('context not recorded'));
    assert.ok(tx.stdout.includes('run cost $1.5 over 4 agents, 2 with cost not recorded, as of 2026-10-04T10:00:09.000Z'));
    for (const line of tx.stdout.split('\n')) assert.ok(Array.from(line).length <= 120, `line over 120 columns: ${line}`);
  } finally { cleanup(dir); }
});

test('agents: a run row\'s orch_cost_usd wins over the stream once run.end wrote it, and the state is ended', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const orch = `${dir}/orch`;
  try {
    await plant(dataDir, { end: { exit_reason: 'idle', usage: { orch_model: 'claude-opus-5-5', orch_cost_usd: 2.5 } } });
    fs.mkdirSync(orch, { recursive: true });
    fs.writeFileSync(`${orch}/stream.jsonl`, orchestratorStream());
    const j = JSON.parse(cli([RUN, '--dir', orch], dataDir).stdout);
    const o = j.agents[0];
    assert.strictEqual(o.state, 'ended');
    assert.strictEqual(o.cost_usd, 2.5);
    assert.ok(o.cost_source.startsWith('run row orch_cost_usd'), o.cost_source);
    assert.strictEqual(j.footer.total_cost_usd, 2.75);
  } finally { cleanup(dir); }
});

test('agents: a missing orchestrator stream leaves context and cost not recorded, an unknown run is exit 1, usage errors are exit 2', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    await plant(dataDir);
    const j = JSON.parse(cli([RUN, '--dir', `${dir}/nowhere`], dataDir).stdout);
    assert.strictEqual(j.agents[0].stream_exists, false);
    assert.strictEqual(j.agents[0].context_tokens, null);
    assert.strictEqual(j.agents[0].cost_usd, null);
    assert.strictEqual(cli(['run-nope'], dataDir).status, 1);
    for (const args of [['--dir'], ['a', 'b'], ['--nope']]) assert.strictEqual(cli(args, dataDir, { json: false }).status, 2, args.join(' '));
  } finally { cleanup(dir); }
});

test('scanTail: reads only the last 256 KB when the lines are there, steps back fourfold only while one is missing, and drops a cut first line', () => {
  const dir = sandbox();
  try {
    const filler = (n) => L({ type: 'tool_progress', pad: 'x'.repeat(1000) }).repeat(n);
    // both lines inside the tail: one window
    fs.writeFileSync(`${dir}/near.jsonl`, filler(2000) + asst('m', { input_tokens: 1 }) + result('m', 1));
    const near = scanTail(`${dir}/near.jsonl`);
    assert.strictEqual(near.bytes_read, 256 * 1024, 'the whole file is over 2 MB; only the tail was read');
    assert.ok(near.assistant && near.result);
    // the lines sit 1 MB back: the window grows until both are in it, and no further
    fs.writeFileSync(`${dir}/far.jsonl`, asst('m', { input_tokens: 2 }) + result('m', 2) + filler(1000));
    const far = scanTail(`${dir}/far.jsonl`);
    assert.strictEqual(far.assistant.message.usage.input_tokens, 2);
    assert.ok(far.bytes_read > 256 * 1024 && far.bytes_read <= 1024 * 1024 + 4096, `bytes_read ${far.bytes_read}`);
    // no such line anywhere: bounded by the file, and says so
    fs.writeFileSync(`${dir}/none.jsonl`, filler(10));
    const none = scanTail(`${dir}/none.jsonl`);
    assert.deepStrictEqual([none.assistant, none.result], [null, null]);
    assert.strictEqual(scanTail(`${dir}/missing.jsonl`).exists, false);
    assert.deepStrictEqual(contextOf(none), { model_seen: null, context_tokens: null, context_window: null, context_pct: null });
  } finally { cleanup(dir); }
});

test('agents: a forgotten worker keeps its cost in the meter, and the total equals what receipts sums for the same run', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    await plant(dataDir);
    await withOwner(dataDir, async (orch) => {
      await orch.worker.write({ id: 'wf', substrate: 'claude-code', pid: process.pid, state: 'running', started_at: Date.now() - 50000 });
      await orch.worker.write({ id: 'wf', state: 'dead', exited_at: Date.now() - 1000, exit_code: 0, cost_usd: 0.75, death_established_by: 'test' });
      const op = await openCore({ dataDir, caller: { role: 'operator', run_id: RUN, pid: process.pid }, embed: false });
      try { await op.worker.forget({ worker_id: 'wf' }); } finally { await op.close(); }
      await orch.run.end({ exit_reason: 'idle', usage: { orch_model: 'claude-opus-5-5', orch_cost_usd: 2.5, orch_turns: 3 } });
    });
    const j = JSON.parse(cli([RUN], dataDir).stdout);
    const wf = j.agents.find((a) => a.id === 'wf');
    assert.ok(wf, 'the forgotten worker is still a row of the meter');
    assert.strictEqual(wf.cost_usd, 0.75);
    assert.strictEqual(j.footer.total_cost_usd, 3.5, '2.5 + 0.25 + 0.75');
    const rc = spawnSync(process.execPath, [CLI, 'receipts', RUN, '--data', dataDir, '--json'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
    assert.strictEqual(rc.status, 0, rc.stderr);
    assert.strictEqual(JSON.parse(rc.stdout).totals.cost_usd, j.footer.total_cost_usd);
  } finally { cleanup(dir); }
});

test('scanTail: never reads past the 8 MB cap, and stops widening once the last assistant line is found without a result line', () => {
  const dir = sandbox();
  try {
    const filler = (n) => L({ type: 'tool_progress', pad: 'x'.repeat(1000) }).repeat(n);
    // nothing usable in 9 MB: the cap, not the file, ends the read
    fs.writeFileSync(`${dir}/big.jsonl`, filler(8800));
    assert.ok(fs.statSync(`${dir}/big.jsonl`).size > 8 * 1024 * 1024 + 4096);
    const big = scanTail(`${dir}/big.jsonl`);
    assert.strictEqual(big.bytes_read, TAIL_MAX_BYTES);
    assert.strictEqual(TAIL_MAX_BYTES, 8 * 1024 * 1024);
    assert.deepStrictEqual([big.assistant, big.result], [null, null]);
    // a live orchestrator: the assistant line is at the end, no result line anywhere in the first window
    fs.writeFileSync(`${dir}/live.jsonl`, result('m', 9) + filler(2000) + asst('m', { input_tokens: 5 }));
    const live = scanTail(`${dir}/live.jsonl`);
    assert.strictEqual(live.bytes_read, 256 * 1024, 'the result line 2 MB back is not read for');
    assert.strictEqual(live.assistant.message.usage.input_tokens, 5);
    assert.strictEqual(live.result, null);
  } finally { cleanup(dir); }
});

test('agents: a live orchestrator has tokens, no cost and no own window; the window comes from a same-model worker result line, never a different model', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const orch = `${dir}/orch`;
  try {
    await plant(dataDir);
    fs.mkdirSync(orch, { recursive: true });
    fs.writeFileSync(`${orch}/stream.jsonl`, asst('claude-opus-5-5', { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }));
    fs.mkdirSync(`${dataDir}/workers/w1`, { recursive: true });
    const w1 = (model) => fs.writeFileSync(`${dataDir}/workers/w1/stream.jsonl`, asst(model, { input_tokens: 5 }) + result(model, 0.25, 500000));

    w1('claude-sonnet-5-5');
    let j = JSON.parse(cli([RUN, '--dir', orch], dataDir).stdout);
    assert.strictEqual(j.agents[0].context_window, null, 'a different model\'s window is not borrowed');
    assert.strictEqual(j.agents[0].context_pct, null);
    assert.strictEqual(j.agents[0].cost_usd, null);

    w1('claude-opus-5-5');
    j = JSON.parse(cli([RUN, '--dir', orch], dataDir).stdout);
    const o = j.agents[0];
    assert.strictEqual(o.context_tokens, 1000);
    assert.strictEqual(o.context_window, 500000);
    assert.strictEqual(o.context_pct, 0.2);
    assert.strictEqual(o.window_source, 'result line of worker w1 (same model)');
    assert.strictEqual(o.cost_usd, null, 'cost while live is not recorded, never estimated');
    assert.strictEqual(j.footer.total_cost_usd, 0.25);
    assert.strictEqual(j.footer.cost_not_recorded, 3, 'orchestrator, w2 and w3');
    const tx = cli([RUN, '--dir', orch], dataDir, { json: false });
    assert.ok(tx.stdout.includes('window from result line of worker w1 (same model)'), tx.stdout);
  } finally { cleanup(dir); }
});

test('agents: a run row with orch_turns 0 has no recorded orchestrator cost, so the stream is used, else null', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const orch = `${dir}/orch`;
  try {
    await plant(dataDir, { end: { exit_reason: 'stopped', usage: { orch_model: 'claude-opus-5-5', orch_cost_usd: 0, orch_turns: 0 } } });
    fs.mkdirSync(orch, { recursive: true });
    let j = JSON.parse(cli([RUN, '--dir', orch], dataDir).stdout);
    assert.strictEqual(j.agents[0].cost_usd, null);
    assert.strictEqual(j.agents[0].cost_source, null);
    fs.writeFileSync(`${orch}/stream.jsonl`, asst('claude-opus-5-5', { input_tokens: 1 }) + result('claude-opus-5-5', 1.25));
    j = JSON.parse(cli([RUN, '--dir', orch], dataDir).stdout);
    assert.strictEqual(j.agents[0].cost_usd, 1.25);
    assert.ok(j.agents[0].cost_source.includes('stream result line'));
  } finally { cleanup(dir); }
});

test('agents: a stream that cannot be read (stream.jsonl is a directory) is that agent\'s stream_error, not a failed table', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    await plant(dataDir);
    fs.mkdirSync(`${dataDir}/workers/w1/stream.jsonl`, { recursive: true });
    const r = cli([RUN, '--dir', `${dir}/nowhere`], dataDir);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    const w1 = j.agents.find((a) => a.id === 'w1');
    assert.ok(w1.stream_error, 'the error is named on the row');
    assert.strictEqual(w1.context_tokens, null);
    assert.strictEqual(j.agents.length, 4, 'the other rows are still there');
    assert.ok(cli([RUN, '--dir', `${dir}/nowhere`], dataDir, { json: false }).stdout.includes('stream error'));
  } finally { cleanup(dir); }
});
