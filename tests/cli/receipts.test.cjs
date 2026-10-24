'use strict';
// receipts.test.cjs — build step S4c. Drives the built CLI's
// `receipts` as a subprocess against a sandbox store planted through the core the way
// tests/cli/observe.test.cjs plants rows, never through a live run. Every sandbox is removed in finally.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');

const { openCore } = require('../../src/core/index.cjs');
const rows = require('../../src/core/rows.cjs');
const { ROOT, CLI, sandbox, cleanup, listRecursive } = require('./stop-helpers.cjs');

const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };
const FAIL = { commands: [{ argv: [process.execPath, '-e', 'process.exit(3)'], timeout_ms: 20000 }] };

function receipts(args, dataDir, { json = true } = {}) {
  return spawnSync(process.execPath, [CLI, 'receipts', ...args, '--data', dataDir, ...(json ? ['--json'] : [])], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
}

// A sorted list of every file under dir with its size and mtime, for the reading-never-writes check.
function stat(dir) {
  const out = [];
  (function walk(d) {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) { out.push(`${p}/`); walk(p); } else { const s = fs.statSync(p); out.push(`${p} ${s.size} ${s.mtimeMs}`); }
    }
  })(dir);
  return out;
}

async function withOwner(dataDir, runId, role, fn, extra = {}) {
  const core = await openCore({ dataDir, caller: { role, run_id: runId, pid: process.pid, ...extra } });
  try { return await fn(core); } finally { await core.shutdownOwner(); await core.close(); }
}

// worker.write refuses an id outside the id grammar, but a store made before it can still hold one (a newline, 80 characters). The renderer is tested against such rows,
// so the first row of each is planted through the store layer, as a legacy store would hold it; later writes to it restate the existing row and go through the core.
function legacyWorker(core, values) { rows.append(core.owner.store, 'worker', values, 'test'); }

// Run `runId`: an orchestrator that attached; w1 with a task it handed back `holds` and whose
// acceptance check passed; w2 with a task whose acceptance check failed. `ended` closes the run with usage.
// `bare` leaves every usage column of w2 and the run unrecorded.
async function plant(dataDir, runId, { ended = true, bare = false, liveWorker = false, adapterPid = process.pid, forget = false, evil = false, wide = false, c1 = false, spoof = false } = {}) {
  await withOwner(dataDir, runId, 'orchestrator', async (orch) => {
    await orch.run.attach({ adapter_pid: adapterPid });
    const t0 = Date.now() - 60000;
    await orch.worker.write({ id: 'w1', substrate: 'claude-code', pid: process.pid, state: 'running', started_at: t0, model: 'sonnet-5.5' });
    const eight = { commands: [...Array(7).fill(PASS.commands[0]), FAIL.commands[0]] };
    const t1 = await orch.task.create({ spec: 'first task', acceptance: wide ? eight : PASS });
    const a = await orch.task.assign({ task_id: t1.id, worker_id: 'w1' });
    const wc = await openCore({ dataDir, caller: { role: 'worker', worker_id: 'w1', run_id: runId, pid: process.pid } });
    const fake = 'holds\nworker FORGED  claude-code  state stopped  cost $0\ntotals over 1 agents  cost $0';
    try {
      const result = evil ? { verdict: fake, summary: `summary\r\n${fake}` }
        : spoof ? { verdict: 'refuted  by reviewer-9  at 2020-01-01T00:00:00.000Z  verdict holds', summary: 'ok' }
          : { verdict: 'holds', summary: 'the change holds up '.repeat(20) };
      await wc.lease.release({ lease_id: a.new_lease.id, result });
    } finally { await wc.close(); }
    await orch.task.evaluate({ task_id: t1.id, worktree: dataDir.replace(/\/[^/]*$/, '') });
    await orch.worker.write({
      id: 'w1', state: 'stopped', exited_at: t0 + 42000, exit_code: 0, task_id: t1.id, turns: 5,
      input_tokens: 1000, output_tokens: 200, cache_read_tokens: 5000, cache_creation_tokens: 300, cost_usd: 0.25, tool_calls: 17,
      base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40),
    });
    const t2 = await orch.task.create({ spec: 'second task', acceptance: FAIL });
    await orch.task.evaluate({ task_id: t2.id, worktree: dataDir.replace(/\/[^/]*$/, '') });
    if (liveWorker) {
      await orch.worker.write({ id: 'w2', substrate: 'codex', pid: process.pid, state: 'running', started_at: t0, task_id: t2.id });
    } else {
      await orch.worker.write({
        id: 'w2', substrate: 'codex', pid: process.pid, state: 'running', started_at: t0,
      });
      await orch.worker.write({
        id: 'w2', state: 'dead', exited_at: t0 + 10000, exit_code: 1, task_id: t2.id,
        ...(bare ? {} : { turns: 2, input_tokens: 400, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0.05, tool_calls: 3 }),
      });
    }
    await orch.task.create({ spec: 'nobody ran this' });
    if (evil) {
      await orch.worker.write({ id: 'w1', model: `sonnet\n${'worker FORGED  x'}\ntotals over 9 agents` });
      // A worker whose own id carries newlines hands a result back: the `by` and the id are both store text.
      const eid = 'w3\nworker FORGED  z';
      legacyWorker(orch, { id: eid, run_id: runId, substrate: 'claude-code', pid: process.pid, state: 'running', started_at: t0 });
      const t3 = await orch.task.create({ spec: 'evil by' });
      const a3 = await orch.task.assign({ task_id: t3.id, worker_id: eid });
      const c3 = await openCore({ dataDir, caller: { role: 'worker', worker_id: eid, run_id: runId, pid: process.pid } });
      try { await c3.lease.release({ lease_id: a3.new_lease.id, result: { verdict: 'holds', summary: 'ok' } }); } finally { await c3.close(); }
      await orch.worker.write({ id: eid, state: 'stopped', exited_at: t0 + 5, task_id: t3.id });
    }
    if (wide) {
      await orch.worker.write({ id: 'w1', model: 'M'.repeat(80) });
      const lid = 'L'.repeat(80);
      legacyWorker(orch, { id: lid, run_id: runId, substrate: 'claude-code', pid: process.pid, state: 'running', started_at: t0 });
      const t4 = await orch.task.create({ spec: 'wide by' });
      const a4 = await orch.task.assign({ task_id: t4.id, worker_id: lid });
      const c4 = await openCore({ dataDir, caller: { role: 'worker', worker_id: lid, run_id: runId, pid: process.pid } });
      try { await c4.lease.release({ lease_id: a4.new_lease.id, result: { verdict: 'V'.repeat(200), summary: 'ok' } }); } finally { await c4.close(); }
      await orch.worker.write({ id: lid, state: 'stopped', exited_at: t0 + 5, task_id: t4.id });
    }
    if (c1) {
      // 79 characters then an emoji at the 80 cap; C1 controls and a bidi override in a sha.
      await orch.worker.write({ id: 'w1', model: `${'e'.repeat(79)}\u{1F600}tail`, head_sha: 'x\u0085y\u009b2Jz‮w' });
    }
    if (forget) {
      const op = await openCore({ dataDir, caller: { role: 'operator', run_id: runId, pid: process.pid } });
      try { await op.worker.forget({ worker_id: 'w2' }); } finally { await op.close(); }
    }
    if (ended) {
      await orch.run.end({
        exit_reason: evil ? 'idle\ntotals over 0 agents' : 'idle',
        usage: bare ? {} : { orch_model: 'opus-5.5', orch_turns: 9, orch_input_tokens: 90, orch_output_tokens: 80, orch_cache_read_tokens: 70, orch_cache_creation_tokens: 60, orch_cost_usd: 1.5 },
      });
    }
  });
}

function guarded(fn) {
  return async () => {
    const dir = sandbox();
    try { await fn(dir, `${dir}/.belay`); } finally { cleanup(dir); }
  };
}

test('receipts: an ended run prints the orchestrator line, each worker, and the totals', guarded(async (dir, dataDir) => {
  await plant(dataDir, 'run-a');
  const r = receipts([], dataDir, { json: false });
  assert.strictEqual(r.status, 0, `${r.stdout} / ${r.stderr}`);
  const lines = r.stdout.split('\n');
  assert.match(lines[0], /^run run-a \(chosen by run\.list\)$/);
  assert.match(lines[1], /^  started .*  ended .*  exit_reason idle$/);
  assert.match(r.stdout, /^orchestrator  model opus-5\.5  turns 9  wall \d+ms  cost \$1\.5  \(orchestrator tool calls: no column\)\n  in 90  out 80  cache-read 70  cache-create 60$/m);
  assert.match(r.stdout, /^worker w1  claude-code  state stopped  exit 0\n  model sonnet-5\.5  turns 5  wall 42000ms  cost \$0\.25  tools 17\n  in 1000  out 200  cache-read 5000  cache-create 300$/m);
  assert.match(r.stdout, /^worker w2  codex  state dead  exit 1/m);
  assert.match(r.stdout, /checks command:pass \d+ms/);
  assert.match(r.stdout, /checks command:fail \d+ms/);
  assert.match(r.stdout, /^  handoff "holds"  by w1  at \d{4}-\d\d-\d\dT[^\n]*\n    summary the change holds up/m);
  assert.match(r.stdout, /^unassigned task .*\(open\)/m);
  assert.match(r.stdout, /^totals over 3 agents  cost \$1\.8  tools 20\n  in 1490  out 330  cache-read 5070  cache-create 360$/m);
  assert.ok(!/not recorded: /.test(r.stdout), 'a complete run lists nothing under not recorded (SF4)');
  assert.strictEqual(r.stdout.split('orchestrator tool calls: no column').length, 2, 'said once');
  // SF3: no line is longer than 120 columns.
  for (const l of lines) assert.ok(l.length <= 120, `a line is ${l.length} columns: ${l}`);
  const summary = lines.filter((l) => l.startsWith('    summary ')).map((l) => l.slice('    summary '.length)).join('');
  assert.ok(summary.length <= 200 && summary.length >= 190, `the summary is cut to 200 characters, got ${summary.length}`);
}));

test('receipts: --json carries every field of design item 2, null where a column was not recorded', guarded(async (dir, dataDir) => {
  await plant(dataDir, 'run-b', { bare: true });
  const r = receipts(['run-b'], dataDir);
  assert.strictEqual(r.status, 0, `${r.stdout} / ${r.stderr}`);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.run_id, 'run-b');
  assert.strictEqual(j.run_id_source, 'argument');
  assert.strictEqual(j.run.exit_reason, 'idle');
  for (const k of ['model', 'turns', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'cost_usd', 'wall_ms', 'live']) {
    assert.ok(k in j.orchestrator, `orchestrator lacks ${k}`);
  }
  assert.strictEqual(j.orchestrator.model, null);
  assert.strictEqual(j.orchestrator.input_tokens, null);
  assert.strictEqual(j.orchestrator.live, false);
  assert.ok(j.orchestrator.wall_ms >= 0);
  const w1 = j.workers.find((w) => w.id === 'w1');
  const w2 = j.workers.find((w) => w.id === 'w2');
  for (const k of ['id', 'substrate', 'state', 'model', 'turns', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'cost_usd', 'tool_calls', 'wall_ms', 'live', 'exit_code', 'base_sha', 'head_sha', 'task']) {
    assert.ok(k in w1, `worker lacks ${k}`);
  }
  assert.strictEqual(w1.wall_ms, 42000);
  assert.strictEqual(w1.base_sha, 'a'.repeat(40));
  assert.strictEqual(w1.task.state, 'done');
  assert.deepStrictEqual(Object.keys(w1.task.checks[0]).sort(), ['executable', 'kind', 'ms', 'passed']);
  assert.strictEqual(w1.task.checks[0].passed, true);
  assert.strictEqual(w1.task.handoff.verdict, 'holds');
  assert.strictEqual(w1.task.handoff.by, 'w1');
  assert.ok(w1.task.handoff.lease_id && w1.task.handoff.at);
  assert.strictEqual(w1.task.handoff.result.verdict, 'holds');
  assert.strictEqual(w2.input_tokens, null, 'an unrecorded token column is null, not 0');
  assert.strictEqual(w2.tool_calls, null);
  assert.strictEqual(w2.task.handoff, null);
  assert.strictEqual(w2.task.checks[0].passed, false);
  assert.strictEqual(j.unassigned_tasks.length, 1);
  assert.deepStrictEqual(Object.keys(j.unassigned_tasks[0]).sort(), ['checks', 'id', 'state']);
  assert.ok('owner' in j);
  const text = receipts(['run-b'], dataDir, { json: false }).stdout;
  assert.match(text, /^worker w2  codex .*\n.*\n  in not recorded  out not recorded/m);
}));

test('receipts: a live worker and a live run have wall_ms null and live true', guarded(async (dir, dataDir) => {
  await plant(dataDir, 'run-c', { ended: false, liveWorker: true });
  const j = JSON.parse(receipts([], dataDir).stdout);
  assert.strictEqual(j.orchestrator.wall_ms, null);
  assert.strictEqual(j.orchestrator.live, true);
  assert.strictEqual(j.run.ended_at, null);
  const w2 = j.workers.find((w) => w.id === 'w2');
  assert.strictEqual(w2.wall_ms, null);
  assert.strictEqual(w2.live, true);
  const w1 = j.workers.find((w) => w.id === 'w1');
  assert.strictEqual(w1.live, false);
  const text = receipts([], dataDir, { json: false }).stdout;
  assert.match(text, /^  started \S+  alive  exit_reason not recorded$/m, 'a run with no end and a live adapter says alive (SF6)');
  assert.match(text, /^  model .*  wall live/m);
  assert.strictEqual(j.run.alive, true);
  // SF6: the same run with a dead adapter pid says what is known, not "live".
  const dead = spawnSync(process.execPath, ['--version'], { windowsHide: true });
  const dir2 = sandbox();
  try {
    await plant(`${dir2}/.belay`, 'run-c2', { ended: false, adapterPid: dead.pid });
    const j2 = JSON.parse(receipts([], `${dir2}/.belay`).stdout);
    assert.strictEqual(j2.run.alive, false);
    assert.strictEqual(j2.run.ended_at, null);
    assert.match(receipts([], `${dir2}/.belay`, { json: false }).stdout, /^  started \S+  not alive, no end recorded  exit_reason/m);
  } finally { cleanup(dir2); }
}));

test('receipts: with no run id the alive run is chosen, and run_id_source says so', guarded(async (dir, dataDir) => {
  await plant(dataDir, 'run-old-alive', { ended: false });
  await plant(dataDir, 'run-new-ended', { ended: true });
  const j = JSON.parse(receipts([], dataDir).stdout);
  assert.strictEqual(j.run_id, 'run-old-alive', 'the alive run wins over the newer ended one');
  assert.strictEqual(j.run_id_source, 'run.list');
  assert.strictEqual(JSON.parse(receipts(['run-new-ended'], dataDir).stdout).run_id_source, 'argument');
}));

test('receipts: an unknown run id is exit 1 naming it; two arguments is exit 2', guarded(async (dir, dataDir) => {
  await plant(dataDir, 'run-d');
  const r = receipts(['no-such-run'], dataDir);
  assert.strictEqual(r.status, 1, `${r.stdout} / ${r.stderr}`);
  assert.match(r.stdout + r.stderr, /no-such-run/);
  const two = receipts(['run-d', 'run-e'], dataDir, { json: false });
  assert.strictEqual(two.status, 2);
  assert.match(two.stdout + two.stderr, /usage: belay receipts/);
  assert.strictEqual(receipts(['run-d', 'run-e'], dataDir).status, 2);
  const opt = receipts(['--bogus'], dataDir);
  assert.strictEqual(opt.status, 2);
}));

test('receipts: reading creates no file and changes no byte in the data dir', guarded(async (dir, dataDir) => {
  await plant(dataDir, 'run-f');
  const before = stat(dataDir);
  for (const args of [[], ['run-f'], ['no-such-run']]) {
    receipts(args, dataDir);
    receipts(args, dataDir, { json: false });
  }
  assert.deepStrictEqual(stat(dataDir), before);
  const absent = `${dir}/.belay-absent`;
  const r = receipts([], absent, { json: false });
  assert.strictEqual(r.status, 0, `${r.stdout} / ${r.stderr}`);
  assert.strictEqual(r.stdout.trim(), '(no runs)');
  assert.ok(!fs.existsSync(absent), 'receipts created the data dir');

  // SF1: the same check while an owner is alive for the data dir. The owner's own checkpoint changes
  // memory.db bytes, so the comparison is the sorted file NAMES (as observe.test.cjs's checked()), and
  // the CLI is spawned asynchronously so this process's owner can answer it.
  const orch = await openCore({ dataDir, caller: { role: 'operator', run_id: 'run-f', pid: process.pid } }); // the run process: only it reopens an ended run
  try {
    await orch.run.attach({ adapter_pid: process.pid });
    const names = () => listRecursive(dataDir);
    const beforeNames = names();
    const othersBefore = stat(dataDir).filter((s) => !/\/memory\.db(-wal|-shm)? /.test(s));
    assert.ok(orch.isOwner(), 'this process must hold the owner lock for the live-owner case');
    for (const args of [['--json'], []]) {
      const out = await new Promise((resolve) => {
        const c = spawn(process.execPath, [CLI, 'receipts', '--data', dataDir, ...args], { cwd: ROOT, windowsHide: true });
        let stdout = '';
        c.stdout.on('data', (d) => { stdout += d; });
        c.on('close', (code) => resolve({ code, stdout }));
      });
      assert.strictEqual(out.code, 0);
      if (args.length) assert.strictEqual(JSON.parse(out.stdout).owner.alive, true, 'the CLI saw a live owner');
    }
    assert.deepStrictEqual(names(), beforeNames, 'a live-owner read changed the data dir listing');
    // SF10: size and mtime of every file other than memory.db and its sidecars, which the owner itself rewrites.
    const others = () => stat(dataDir).filter((s) => !/\/memory\.db(-wal|-shm)? /.test(s));
    assert.deepStrictEqual(others(), othersBefore, 'a live-owner read rewrote a file');
  } finally { await orch.shutdownOwner(); await orch.close(); }
}));

test('receipts: no CLI path to it loads the embedder', () => {
  const probe = `
    require(${JSON.stringify(CLI)});
    require(${JSON.stringify(`${ROOT}/src/cli/cmd-receipts.cjs`)});
    process.stdout.write(JSON.stringify(Object.keys(require.cache).filter(k => /embedder\\.cjs$|@huggingface/i.test(k))));
  `;
  const r = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), []);
});

test('receipts: totals skip nulls and count them under not_recorded', guarded(async (dir, dataDir) => {
  await plant(dataDir, 'run-g', { bare: true });
  const t = JSON.parse(receipts([], dataDir).stdout).totals;
  // Only w1 recorded usage: the orchestrator and w2 carried null in every column.
  assert.strictEqual(t.agents, 3);
  assert.strictEqual(t.input_tokens, 1000);
  assert.strictEqual(t.output_tokens, 200);
  assert.strictEqual(t.cost_usd, 0.25);
  assert.strictEqual(t.tool_calls, 17);
  assert.strictEqual(t.not_recorded.input_tokens, 2);
  assert.strictEqual(t.not_recorded.cost_usd, 2);
  // SF4: the orchestrator has no tool-call column, so it is not an agent that "carried null" for it.
  assert.strictEqual(t.not_recorded.tool_calls, 1, 'only w2 lacks tool_calls');
  const text = receipts([], dataDir, { json: false }).stdout;
  assert.match(text, /^  not recorded: input_tokens 2, output_tokens 2, cache_read_tokens 2, cache_creation_tokens 2, cost_usd 2, tool_calls 1$/m);
  // SF2: costs print at most 4 decimals with trailing zeros trimmed; JSON keeps the raw sum.
  const money = sandbox();
  try {
    const md = `${money}/.belay`;
    await withOwner(md, 'run-m', 'orchestrator', async (orch) => {
      await orch.run.attach({ adapter_pid: process.pid });
      await orch.worker.write({ id: 'a', substrate: 'codex', pid: process.pid, state: 'running', started_at: 1 });
      await orch.worker.write({ id: 'a', state: 'dead', exited_at: 2, cost_usd: 0.1 });
      await orch.worker.write({ id: 'b', substrate: 'codex', pid: process.pid, state: 'running', started_at: 1 });
      await orch.worker.write({ id: 'b', state: 'dead', exited_at: 2, cost_usd: 0.2 });
      await orch.run.end({ exit_reason: 'idle', usage: { orch_cost_usd: 1e-7 } });
    });
    const mj = JSON.parse(receipts([], md).stdout);
    assert.strictEqual(mj.totals.cost_usd, 1e-7 + 0.1 + 0.2, 'JSON keeps the raw sum');
    const mt = receipts([], md, { json: false }).stdout;
    assert.match(mt, /^totals over 3 agents  cost \$0\.3  tools not recorded$/m);
    assert.match(mt, /^orchestrator .* cost \$0\.0000 /m);
    assert.match(mt, /  cost \$0\.1  tools not recorded$/m);
  } finally { cleanup(money); }
  // Nothing recorded anywhere totals null, not 0.
  const empty = sandbox();
  try {
    const dd = `${empty}/.belay`;
    await withOwner(dd, 'run-h', 'orchestrator', async (orch) => { await orch.run.attach({ adapter_pid: process.pid }); });
    const e = JSON.parse(receipts([], dd).stdout).totals;
    assert.strictEqual(e.input_tokens, null);
    assert.strictEqual(e.cost_usd, null);
    assert.strictEqual(e.not_recorded.input_tokens, 1);
  } finally { cleanup(empty); }
}));

test('receipts: a forgotten worker is still a receipt, printed as forgotten and counted in the totals', guarded(async (dir, dataDir) => {
  await plant(dataDir, 'run-k', { forget: true });
  const j = JSON.parse(receipts([], dataDir).stdout);
  const w2 = j.workers.find((w) => w.id === 'w2');
  assert.ok(w2, 'the forgotten worker is listed');
  assert.strictEqual(w2.state, 'forgotten');
  assert.strictEqual(w2.cost_usd, 0.05, 'the forgotten row carries the spend forward');
  assert.strictEqual(j.workers.length, 2);
  assert.strictEqual(j.totals.agents, 3);
  assert.strictEqual(j.totals.cost_usd, 1.5 + 0.25 + 0.05);
  assert.match(receipts([], dataDir, { json: false }).stdout, /^worker w2  codex  state forgotten/m);
}));

test('receipts: text from the store cannot forge a line', guarded(async (dir, dataDir) => {
  await plant(dataDir, 'run-x', { evil: true });
  const r = receipts([], dataDir, { json: false });
  assert.strictEqual(r.status, 0, `${r.stdout} / ${r.stderr}`);
  const lines = r.stdout.split('\n');
  assert.strictEqual(lines.filter((l) => /^worker /.test(l)).length, 3, r.stdout);
  assert.ok(!lines.some((l) => l.startsWith('worker FORGED')), 'a forged worker line');
  const totals = lines.filter((l) => l.startsWith('totals'));
  assert.strictEqual(totals.length, 1, 'a forged totals line');
  assert.ok(totals[0].startsWith('totals over 4 agents'));
  assert.ok(!new RegExp('[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]').test(r.stdout), 'a control character survived');
  for (const l of lines) assert.ok(l.length <= 120, `a line is ${l.length} columns`);
  // JSON keeps the raw text.
  const j = JSON.parse(receipts([], dataDir).stdout);
  assert.ok(j.workers.find((w) => w.id === 'w1').task.handoff.verdict.includes('\nworker FORGED'));
  assert.ok(j.run.exit_reason.includes('\n'));
}));

test('receipts: no fact is lost to the width limit: long lines are broken, never cut', guarded(async (dir, dataDir) => {
  await plant(dataDir, 'run-w', { wide: true });
  const r = receipts([], dataDir, { json: false });
  assert.strictEqual(r.status, 0, `${r.stdout} / ${r.stderr}`);
  const lines = r.stdout.split('\n');
  for (const l of lines) assert.ok(Array.from(l).length <= 120, `a line is ${l.length} columns: ${l}`);
  assert.ok(r.stdout.includes('command:fail'), 'the failing 8th check must appear');
  assert.strictEqual((r.stdout.match(/command:(pass|fail)/g) || []).length, 8 + 1 + 0, 'all 8 checks of the first task plus w2\'s failing check');
  assert.ok(r.stdout.includes('M'.repeat(80)), 'the 80-character model');
  const usage = lines.findIndex((l) => l.includes('M'.repeat(80)));
  const block = lines.slice(usage, usage + 3).join('\n');
  assert.match(block, /cost \$0\.25/, 'cost follows a long model name');
  assert.match(block, /tools 17/, 'tools follows a long model name');
  assert.ok(r.stdout.includes('V'.repeat(80)), 'the verdict');
  assert.match(r.stdout, /L{80}/, 'the 80-character by / worker id');
  assert.match(r.stdout, /at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/, 'the handoff time');
  assert.strictEqual((r.stdout.match(/^ *(?:handoff|by |at ).*\d{4}-\d\d-\d\dT/gm) || []).length >= 2 || (r.stdout.match(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g) || []).length >= 4, true);
}));

test('receipts: C1 controls and bidi overrides are replaced, and a cap never splits an emoji', guarded(async (dir, dataDir) => {
  await plant(dataDir, 'run-u', { c1: true });
  const r = receipts([], dataDir, { json: false });
  assert.strictEqual(r.status, 0, `${r.stdout} / ${r.stderr}`);
  assert.ok(!new RegExp('[\\u0080-\\u009f\\u202a-\\u202e\\u2066-\\u2069\\u200e\\u200f]').test(r.stdout), 'a C1 or bidi control survived');
  assert.ok(!r.stdout.includes('\ufffd'), 'a surrogate pair was split');
  const model = r.stdout.split('\n').find((l) => l.startsWith('  model eee'));
  assert.ok(model.includes('e'.repeat(79) + '\u{1F600}'), 'the emoji at the boundary is kept whole');
  assert.ok(!model.includes('tail'));
  assert.match(r.stdout, /head x y 2Jz w/);
  assert.ok(JSON.parse(receipts([], dataDir).stdout).workers.find((w) => w.id === 'w1').head_sha.includes('\u0085'), 'JSON keeps the raw value');
}));

test('receipts: a value cannot spoof a field of the handoff line (c13)', guarded(async (dir, dataDir) => {
  await plant(dataDir, 'run-s', { spoof: true });
  const r = receipts([], dataDir, { json: false });
  assert.strictEqual(r.status, 0, `${r.stdout} / ${r.stderr}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('  handoff ') && l.includes('reviewer-9'));
  assert.ok(line, r.stdout);
  assert.match(line, /^  handoff "refuted by reviewer-9 at 2020-01-01T00:00:00\.000Z verdict holds"  by w1  at \d{4}-/);
  assert.ok(!r.stdout.includes('​'));
}));

test('receipts: an empty-string run id is exit 2 with the usage', guarded(async (dir, dataDir) => {
  await plant(dataDir, 'run-e');
  const r = receipts([''], dataDir, { json: false });
  assert.strictEqual(r.status, 2, `${r.stdout} / ${r.stderr}`);
  assert.match(r.stdout + r.stderr, /usage: belay receipts/);
}));
