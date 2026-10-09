'use strict';
// receipts.test.cjs — build step W2-3, S4a: a worker's row
// carries its own receipt — the model system/init reported, summed cache tokens, an uncapped tool_use
// count, and the worktree's HEAD at spawn (base_sha) and at settle (head_sha). Every assertion reads the
// row the store holds (the real core where a merge matters, the strict in-memory fake core where the
// row itself must carry a fact), never a returned word. The fakes follow the real binary's receipt fields
// (tests/run/fakes/fake-claude.cjs).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createRunManager } = require('../../src/run/index.cjs');
const { revParseHead } = require('../../src/run/git-facts.cjs');
const W = require('../../src/run/worker.cjs');
const EX = require('../../src/run/exit.cjs');
const P = require('../../src/run/process.cjs');
const { createWriteRow } = require('../../src/run/write-row.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { releaseCore } = require('../cli/stop-helpers.cjs');
const { cleanup } = require('../core/helpers.cjs');

const fwd = (p) => String(p).replace(/\\/g, '/');
const FAKE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
const FAKE_CODEX = fwd(path.join(__dirname, 'fakes', 'fake-codex.cjs'));
const USER_SETTINGS = fwd(path.join(__dirname, 'fixtures', 'user-settings.json'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollUntil(fn, ms, step = 25) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 >= ms) return null;
    await sleep(step);
  }
}

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-receipts-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { root: d, data: fwd(d), worktree: fwd(path.join(d, 'wt')) };
}

// A real git repository as the worker's worktree, with one commit. Author identity is given per call.
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
function gitWorktree(sb) {
  git(sb.worktree, 'init', '-q');
  git(sb.worktree, 'commit', '-q', '--allow-empty', '-m', 'base');
  return git(sb.worktree, 'rev-parse', 'HEAD');
}

const mgr = (sb, core, exe = FAKE, runId = 'run-receipts') => createRunManager({
  core, dataDir: sb.data, runId, paths: { claudeExe: exe, codexExe: exe, userSettings: USER_SETTINGS },
});

async function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
}

async function openRealCore(sb, runId) {
  const core = await openCore({ dataDir: `${sb.data}/.belay`, caller: { role: 'orchestrator', run_id: runId, pid: process.pid } });
  await core.run.attach({ adapter_pid: process.pid });
  return core;
}

// ---------------------------------------------------------------- (r1)
test('receipts: a Claude Code worker\'s row carries init\'s model, summed cache tokens and an uncapped tool_calls count across turns', async () => {
  const sb = sandbox();
  const core = createFakeCore({ runId: 'run-receipts' });
  const m = mgr(sb, core);
  try {
    await withEnv({ FAKE_MODEL: 'fake-model-r1', FAKE_TOOL_USES: '25' }, async () => {
      await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w-r1' });
      await m._waitTurn('w-r1', 8000);
      await m.message({ worker_id: 'w-r1', text: 'two' });
      await m._waitTurn('w-r1', 8000);
    });
    const last = await pollUntil(() => { const c = core.currentWorker('w-r1'); return c && c.turns === 2 && c.tool_calls === 50 ? c : null; }, 5000);
    assert.ok(last, `the row never showed two turns and 50 tool calls: ${JSON.stringify(core.currentWorker('w-r1'))}`);
    assert.strictEqual(last.model, 'fake-model-r1', 'the model is the init\'s, not the requested string');
    assert.strictEqual(last.cache_read_tokens, 2 * 1900);
    assert.strictEqual(last.cache_creation_tokens, 2 * 7);
    assert.strictEqual(last.tool_calls, 50, 'tool_calls is uncapped: the digest keeps 20 and this row counts 50');
    assert.ok(m._worker('w-r1').digest.length <= 20, 'the digest is still capped at 20');
    // Before the first ready event the column is null (the `starting` row is written before init).
    assert.ok(core.rowsFor('w-r1')[0].model == null, `the starting row must not name a model: ${core.rowsFor('w-r1')[0].model}`);
  } finally { await m.shutdown(); cleanup(sb.data); }
});

// ---------------------------------------------------------------- (r2)
test('receipts: cost is set from the latest cumulative total, not summed, across a resume', async () => {
  const sb = sandbox();
  const core = await openRealCore(sb, 'run-r2');
  const m = mgr(sb, core, FAKE, 'run-r2');
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w-r2' });
    await m._waitTurn('w-r2', 8000);
    await m.message({ worker_id: 'w-r2', text: 'two' });
    await m._waitTurn('w-r2', 8000);
    const before = await pollUntil(async () => { const r = await core.worker.get({ worker_id: 'w-r2' }); return r.turns === 2 ? r : null; }, 5000);
    assert.ok(before, 'two turns never landed on the row');
    assert.ok(Math.abs(before.cost_usd - 0.002) < 1e-9, `cost after two turns ${before.cost_usd}`);
    await m.stop({ worker_id: 'w-r2', mode: 'kill', timeout_ms: 8000 });
    // A resumed session inherits the running total: its next result reports 0.002 + 0.001.
    const r = await withEnv({ FAKE_COST_BASE: '0.002' }, () => m.restart({ worker_id: 'w-r2', first_turn_timeout_ms: 8000 }));
    assert.strictEqual(r.branch, 'resume', r.reason);
    const after = await pollUntil(async () => { const x = await core.worker.get({ worker_id: 'w-r2' }); return x.turns === 3 && x.state === 'running' ? x : null; }, 5000);
    assert.ok(after, 'the resumed turn never landed on the row');
    assert.ok(Math.abs(after.cost_usd - 0.003) < 1e-9, `cost after the resume is the latest cumulative 0.003, not a sum: ${after.cost_usd}`);
  } finally { await m.shutdown(); await releaseCore(core); cleanup(sb.data); }
});

// ---------------------------------------------------------------- (r3)
test('receipts: a Codex worker\'s input_tokens excludes cached input, which lands in cache_read_tokens', async () => {
  const sb = sandbox();
  const core = createFakeCore({ runId: 'run-receipts' });
  const m = mgr(sb, core, FAKE_CODEX);
  try {
    // A longer fake turn: the spawn's ready gate must not race the process's own exit on a loaded host.
    await withEnv({ FAKE_CODEX_TURN_MS: '2000' }, async () => {
      await m.spawn({ substrate: 'codex', worktree: sb.worktree, prompt: 'one', worker_id: 'w-r3' });
      await m._waitTurn('w-r3', 8000);
    });
    // fake-codex reports input 120 of which 100 cached, output 20 (tests/run/fixtures/codex-stream.jsonl's shape).
    const row = await pollUntil(() => { const c = core.currentWorker('w-r3'); return c && c.turns === 1 && c.state === 'idle' ? c : null; }, 5000);
    assert.ok(row, `the codex row never reached idle after one turn: ${JSON.stringify(core.currentWorker('w-r3'))}`);
    assert.strictEqual(row.input_tokens, 20, 'input_tokens is the uncached remainder, as on Claude Code');
    assert.strictEqual(row.cache_read_tokens, 100);
    assert.strictEqual(row.output_tokens, 20);
    assert.ok(row.cache_creation_tokens === 0 || row.cache_creation_tokens == null);
  } finally { await m.shutdown(); cleanup(sb.data); }
});

// ---------------------------------------------------------------- (r4)
test('receipts: base_sha is recorded after spawn and head_sha at settle in a git worktree; both null outside one, without failing the spawn', async () => {
  const sb = sandbox();
  const plain = sandbox(); // an OS-temp directory, in no repository
  const core = await openRealCore(sb, 'run-r4');
  const m = mgr(sb, core, FAKE, 'run-r4');
  try {
    const base = gitWorktree(sb);
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w-git' });
    await m._waitTurn('w-git', 8000);
    const live = await pollUntil(async () => { const r = await core.worker.get({ worker_id: 'w-git' }); return r.base_sha ? r : null; }, 5000);
    assert.ok(live, 'base_sha never reached the row after spawn');
    assert.strictEqual(live.base_sha, base);
    assert.strictEqual(live.head_sha, null, 'a live row carries no head_sha');
    // The worker "commits": HEAD moves while it runs; the settle-time head is the new one.
    git(sb.worktree, 'commit', '-q', '--allow-empty', '-m', 'work');
    const moved = git(sb.worktree, 'rev-parse', 'HEAD');
    assert.notStrictEqual(moved, base);
    await m.stop({ worker_id: 'w-git', mode: 'graceful', timeout_ms: 8000 });
    const settled = await pollUntil(async () => { const r = await core.worker.get({ worker_id: 'w-git' }); return r.head_sha ? r : null; }, 5000);
    assert.ok(settled, 'head_sha never reached the row at settle');
    assert.strictEqual(settled.head_sha, moved);
    assert.strictEqual(settled.base_sha, base, 'base_sha survives to the settled row');

    // Outside a repository: the spawn succeeds and both columns stay null.
    // (The ceiling keeps git from finding a repository above the OS temp directory, when that is itself inside one.)
    const end = await withEnv({ GIT_CEILING_DIRECTORIES: fwd(os.tmpdir()) }, async () => {
      const row = await m.spawn({ substrate: 'claude-code', worktree: plain.worktree, prompt: 'one', worker_id: 'w-plain' });
      assert.strictEqual(row.state, 'running');
      await m._waitTurn('w-plain', 8000);
      await m.stop({ worker_id: 'w-plain', mode: 'graceful', timeout_ms: 8000 });
      return pollUntil(async () => { const r = await core.worker.get({ worker_id: 'w-plain' }); return r.state === 'stopped' ? r : null; }, 5000);
    });
    assert.ok(end, 'the plain worker never settled');
    assert.strictEqual(end.base_sha, null);
    assert.strictEqual(end.head_sha, null);
  } finally { await m.shutdown(); await releaseCore(core); cleanup(sb.data); cleanup(plain.data); }
});

// ---------------------------------------------------------------- (r5)
test('receipts: an adopted worker keeps model, counts and base_sha from its row', async () => {
  const sb = sandbox();
  const core = createFakeCore({ runId: 'run-receipts' }); // strict: no merge, so a row must carry each fact itself
  const first = mgr(sb, core);
  let second = null;
  try {
    const base = gitWorktree(sb);
    await withEnv({ FAKE_MODEL: 'fake-model-r5', FAKE_TOOL_USES: '3' }, async () => {
      await first.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w-r5' });
      await first._waitTurn('w-r5', 8000);
    });
    const before = await pollUntil(() => { const c = core.currentWorker('w-r5'); return c && c.turns === 1 && c.base_sha && c.state === 'running' ? c : null; }, 5000);
    assert.ok(before, `the first life's row never carried base_sha: ${JSON.stringify(core.currentWorker('w-r5'))}`);
    assert.strictEqual(before.base_sha, base);
    await first.stop({ worker_id: 'w-r5', mode: 'kill', timeout_ms: 8000 });

    second = mgr(sb, core);
    const r = await withEnv({ FAKE_MODEL: 'fake-model-r5', FAKE_TOOL_USES: '3' }, () => second.restart({ worker_id: 'w-r5', first_turn_timeout_ms: 8000 }));
    assert.strictEqual(r.branch, 'resume', r.reason);
    const w = second._worker('w-r5');
    assert.strictEqual(w.baseSha, base, 'the adopted record kept base_sha from its row and did not ask git again');
    assert.strictEqual(w.initModel, 'fake-model-r5');
    const after = await pollUntil(() => { const c = core.currentWorker('w-r5'); return c && c.turns === 2 && c.state === 'running' ? c : null; }, 5000);
    assert.ok(after, 'the resumed turn never landed on the row');
    assert.strictEqual(after.base_sha, base);
    assert.strictEqual(after.model, 'fake-model-r5');
    assert.strictEqual(after.tool_calls, 6, 'three tool uses in each life, counted on from the row');
    assert.strictEqual(after.cache_read_tokens, 2 * 1900);
  } finally { await first.shutdown(); if (second) await second.shutdown(); cleanup(sb.data); }
});

// ---------------------------------------------------------------- (r6)
test('receipts: git-facts never throws and times out to null', async () => {
  const sb = sandbox();
  try {
    const base = gitWorktree(sb);
    assert.strictEqual(await revParseHead(sb.worktree), base, 'a repository answers with its HEAD');
    assert.match(base, /^[0-9a-f]{40,64}$/);
    assert.strictEqual(await revParseHead(fwd(path.join(sb.root, 'no-such-dir'))), null, 'a missing directory is null');
    assert.strictEqual(await revParseHead(fwd(path.join(sb.root, 'wt', '.git', 'HEAD'))), null, 'a file as cwd is null');
    assert.strictEqual(await revParseHead(12345), null, 'a non-string cwd is null, not a throw');
    const plain = sandbox();
    try {
      await withEnv({ GIT_CEILING_DIRECTORIES: fwd(os.tmpdir()) }, async () => assert.strictEqual(await revParseHead(plain.worktree), null, 'a directory in no repository is null'));
    } finally { cleanup(plain.data); }
    const t0 = Date.now();
    assert.strictEqual(await revParseHead(sb.worktree, { timeoutMs: 1 }), null, 'a 1 ms bound times out to null');
    assert.ok(Date.now() - t0 < 5000, 'and does so promptly');
  } finally { cleanup(sb.data); }
});

// ---------------------------------------------------------------- (r10)
test('receipts: in a git worktree the dead row is written before head_sha, and head_sha lands in a follow-up row', async () => {
  const sb = sandbox();
  const core = createFakeCore({ runId: 'run-receipts' }); // strict: no merge, so each row shows exactly what it carried
  const m = mgr(sb, core);
  try {
    const base = gitWorktree(sb);
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w-r10' });
    await m._waitTurn('w-r10', 8000);
    require('../crash.cjs').crash(m._worker('w-r10').child);
    const followUp = await pollUntil(() => core.rowsFor('w-r10').find((r) => r.state === 'dead' && r.head_sha), 8000);
    assert.ok(followUp, `no dead row ever carried head_sha: ${JSON.stringify(core.rowsFor('w-r10').map((r) => [r.state, r.head_sha]))}`);
    assert.strictEqual(followUp.head_sha, base);
    const rows = core.rowsFor('w-r10');
    const firstDead = rows.findIndex((r) => r.state === 'dead');
    assert.ok(!rows[firstDead].head_sha, 'the first terminal row is written without waiting for git');
    assert.ok(rows.indexOf(followUp) > firstDead, 'head_sha arrives in a later row of the same state');
  } finally { await m.shutdown(); cleanup(sb.data); }
});

// ---------------------------------------------------------------- (r12)
test('receipts: a head follow-up does not land over a row written after the terminal one (forget inside the git window)', async () => {
  const sb = sandbox();
  const core = await openRealCore(sb, 'run-r12');
  // The follow-up's write is held on a gate the test opens, so the operator's forget lands inside the window
  // by construction, not by a timer: the held write signals `reached` and waits for `gate`.
  let reached, openGate;
  const reachedP = new Promise((res) => { reached = res; });
  const gate = new Promise((res) => { openGate = res; });
  const slow = { ...core, worker: { ...core.worker, write: async (r) => { if (r.head_sha) { reached(); await gate; } return core.worker.write(r); } } };
  const m = mgr(sb, slow, FAKE, 'run-r12');
  let op = null;
  try {
    gitWorktree(sb);
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w-r12' });
    await m._waitTurn('w-r12', 8000);
    require('../crash.cjs').crash(m._worker('w-r12').child);
    assert.ok(await pollUntil(async () => (await core.worker.get({ worker_id: 'w-r12' })).state === 'dead', 8000, 10), 'the dead row never landed');
    op = await openCore({ dataDir: `${sb.data}/.belay`, caller: { role: 'operator', run_id: 'cli', pid: process.pid } });
    let bound; // the follow-up must arrive at the held write, or the test is not testing the order
    const arrived = await Promise.race([reachedP.then(() => true), new Promise((res) => { bound = setTimeout(() => res(false), 8000); })]);
    clearTimeout(bound);
    assert.ok(arrived, 'the head follow-up never arrived at the held write within 8000 ms');
    const forgot = await op.worker.forget({ worker_id: 'w-r12' });
    assert.strictEqual(forgot.row_after.state, 'forgotten', 'the forget succeeds');
    openGate();
    await m._worker('w-r12').headPromise;
    await m._worker('w-r12').queue;
    const after = await core.worker.get({ worker_id: 'w-r12' });
    assert.strictEqual(after.state, 'forgotten', `the follow-up must not restate dead over the forget: ${after.state}`);
  } finally { openGate(); await m.shutdown(); await releaseCore(op); await releaseCore(core); cleanup(sb.data); }
});

// ---------------------------------------------------------------- (r13)
test('receipts: an exit-code fill-in is not dropped by this adapter\'s own in-flight direct dead write', async () => {
  const sb = sandbox();
  const core = await openRealCore(sb, 'run-r13');
  try {
    let delayNext = false;
    const wrapped = { ...core, worker: { ...core.worker, write: async (row) => {
      const d = delayNext; delayNext = false;
      const r = await core.worker.write(row);
      if (d) await sleep(300); // the append has happened; only the response is late
      return r;
    } } };
    const ctx = { core: wrapped, runId: 'run-r13', adapterPid: process.pid };
    ctx.writeRow = createWriteRow(ctx, { closed: false });
    const w = W.newWorkerRecord({ id: 'w-r13', substrate: 'claude-code', worktree: sb.worktree, dataDir: sb.data, captureBase: false });
    w.pid = process.pid; w.startedAt = Date.now();
    await ctx.writeRow(w, 'starting');
    await ctx.writeRow(w, 'running');
    w.child = null;
    EX.settle(w, null, null, 'pid-poll', ctx); // a pid poll settles first: no code yet
    await w.queue;
    delayNext = true;
    const direct = ctx.writeRow(w, 'dead'); // a direct terminal write, built without the code, response in flight
    await sleep(50);
    EX.settle(w, 1, null, 'exit-event', ctx); // the exit event delivers the code meanwhile
    await direct; await w.queue;
    const cur = await pollUntil(async () => { const r = await core.worker.get({ worker_id: 'w-r13' }); return r.exit_code === 1 ? r : null; }, 3000);
    assert.ok(cur, `the code never reached the row: ${JSON.stringify(await core.worker.get({ worker_id: 'w-r13' }))}`);
    assert.match(cur.death_established_by, /\+exit-event/);
  } finally { await releaseCore(core); cleanup(sb.data); }
});

// ---------------------------------------------------------------- (r11)
test('receipts: an adopted live worker that later settles asks git for its head', async () => {
  const sb = sandbox();
  const core = createFakeCore({ runId: 'run-receipts' });
  const first = mgr(sb, core);
  try {
    const base = gitWorktree(sb);
    await first.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w-r11' });
    await first._waitTurn('w-r11', 8000);
    assert.ok(await pollUntil(() => { const c = core.currentWorker('w-r11'); return c && c.state === 'running' ? c : null; }, 5000));
    const w = await W.adopt({ core, workerId: 'w-r11', dataDir: sb.data });
    assert.strictEqual(w.headSha, null, 'a live row carries no head');
    const ctx = { core, runId: 'run-receipts', adapterPid: process.pid };
    ctx.writeRow = createWriteRow(ctx, { closed: false });
    await ctx.writeRow(w, 'dead');
    const got = await pollUntil(() => core.rowsFor('w-r11').find((r) => r.state === 'dead' && r.head_sha), 8000);
    assert.ok(got, `the adopted worker's dead row never got a head_sha: ${JSON.stringify(core.rowsFor('w-r11').map((r) => [r.state, r.head_sha]))}`);
    assert.strictEqual(got.head_sha, base);
  } finally { await first.shutdown(); cleanup(sb.data); }
});
