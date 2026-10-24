'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1'; // ADR 0034: a run here has no model to warm; the one suite that tests the warm-up opts in
// memory.test.cjs — build step 4b, amended by the
// orchestrator's Amendment section (B2, B3, B5). Drives the built CLI's `memory search` and
// `memory stats` as subprocesses, with the scaffolding of tests/cli/status.test.cjs and
// tests/cli/stop-helpers.cjs. `tasks`/`briefing` are tests/cli/observe.test.cjs's own file (B4).

const { test } = require('node:test');
const assert = require('node:assert');

const P = require('../../src/run/process.cjs');
const { openCore } = require('../../src/core/index.cjs');
const {
  ROOT, CLI, sandbox, cleanup, makeSpec, runCli, connectOrchestratorCore, listRecursive, runStopSync, waitForExit, releaseCore,
} = require('./stop-helpers.cjs');
const { spawn, spawnSync } = require('node:child_process');

const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;

const vec = (seed) => Array.from({ length: 384 }, (_, i) => (((i + seed) % 7) + 1) / 10);
const vec1024 = (seed) => Array.from({ length: 1024 }, (_, i) => (((i + seed) % 7) + 1) / 10);
const M = require('../../src/core/models.cjs');

function memorySearchText(args, dataDir) {
  return spawnSync(process.execPath, [CLI, 'memory', 'search', ...args, '--data', dataDir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
}
function memoryStatsText(args, dataDir) {
  return spawnSync(process.execPath, [CLI, 'memory', 'stats', ...args, '--data', dataDir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
}
function memorySearchJson(args, dataDir) {
  return spawnSync(process.execPath, [CLI, 'memory', 'search', ...args, '--data', dataDir, '--json'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
}
function memoryStatsJson(args, dataDir) {
  return spawnSync(process.execPath, [CLI, 'memory', 'stats', ...args, '--data', dataDir, '--json'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
}

// B3: reading never writes, asserted by the sorted NAME listing — the same comparison
// tests/cli/status.test.cjs's checkedStatusJson uses.
function checked(fn, dataDir, label) {
  const before = listRecursive(dataDir);
  const r = fn();
  assert.deepStrictEqual(listRecursive(dataDir), before, `${label}: changed the data dir listing`);
  return r;
}

test('memory: search against a store with no live owner is refused E_NO_EMBEDDER with exit 1 and creates nothing; stats reads through the copy and names no live owner', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  // Planted through a core opened as role orchestrator, B5's own recipe (run.attach, task.create, then
  // memory.store with a supplied vector), then shut down before any read below, so every belay memory
  // invocation in this test takes the copy path (invariant 6).
  const core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-x', pid: process.pid } });
  try {
    await core.run.attach({ adapter_pid: process.pid });
    await core.task.create({ spec: 'planted per B5, so this file is sensitive to a task.create regression too' });
    fs.writeFileSync(`${dir}/orch.gate`, '');
    await core.memory.store({ namespace: 'run/run-x', text: 'a stored row with a supplied vector', embedding: vec(1), embedding_model: 'fixture', dim: 384 });
  } finally {
    await core.shutdownOwner();
    await core.close();
  }

  const r = checked(() => memorySearchJson(['anything', 'run-x', '--mode', 'semantic'], dataDir), dataDir, 'memory search (dead store)');
  assert.strictEqual(r.status, 1, `memory search: ${r.stdout} / ${r.stderr}`);
  const j = JSON.parse(r.stderr);
  assert.strictEqual(j.error.code, 'E_NO_EMBEDDER');
  assert.match(j.reason, /needs a live owner to embed the query/);

  // Text output names the reason too, not only --json (B3).
  const rText = checked(() => memorySearchText(['anything', 'run-x', '--mode', 'semantic'], dataDir), dataDir, 'memory search (dead store, text)');
  assert.strictEqual(rText.status, 1);
  assert.match(rText.stderr, /needs a live owner to embed the query/);

  // The default mode is hybrid for a query string: with no owner it answers from its keyword half and names the semantic failure.
  const rDef = checked(() => memorySearchJson(['stored', 'run-x'], dataDir), dataDir, 'memory search (dead store, default mode)');
  assert.strictEqual(rDef.status, 0, `memory search (default): ${rDef.stdout} / ${rDef.stderr}`);
  const jDef = JSON.parse(rDef.stdout);
  assert.deepStrictEqual(jDef.modes_run, ['keyword']);
  assert.strictEqual(jDef.modes_failed.length, 1);
  assert.strictEqual(jDef.modes_failed[0].mode, 'semantic');

  const rStats = checked(() => memoryStatsJson(['run-x'], dataDir), dataDir, 'memory stats (dead store)');
  assert.strictEqual(rStats.status, 0, `memory stats: ${rStats.stdout} / ${rStats.stderr}`);
  const jStats = JSON.parse(rStats.stdout);
  assert.strictEqual(jStats.owner.alive, false);
  assert.match(jStats.owner.established_by, /no owner\.lock in the data dir/);

  const rStatsText = checked(() => memoryStatsText(['run-x'], dataDir), dataDir, 'memory stats (dead store, text)');
  assert.strictEqual(rStatsText.status, 0);
  assert.match(rStatsText.stdout, /^owner: /m, 'the stats owner line must be present');
  assert.match(rStatsText.stdout, /alive=false/);

  cleanup(dir);
});

// A run process is the store owner; a planted mid-turn worker keeps the run open for the life of the
// body, as tests/run/run-wake.test.cjs does. `envExtra` chooses the owner's model cache. The body gets
// { core, dataDir, runId, runCliProc, dir }; the teardown stops the run gracefully, never by signal first.
async function withLiveOwner(envExtra, body) {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, runId } = makeSpec(dir, { poll_ms: 300, close_grace_ms: 2000 });
  const runCliProc = runCli(specPath, dataDir, { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_ANSWER_DELAY_MS: '500', FAKE_ANSWER_GATE_FILE: `${dir}/orch.gate`, ...envExtra(dir) }); // the first answer waits for the gate: the owner vouches for this test by its process, then binds it (ADR 0045)
  let core = null;
  let plantedProc = null;
  try {
    core = await connectOrchestratorCore(dataDir, runId);
    plantedProc = spawn(process.execPath, [FAKE_CLAUDE], {
      cwd: dir, env: { ...process.env, FAKE_HANG: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    await core.worker.write({ id: 'w1', substrate: 'claude-code', pid: plantedProc.pid, pid_image: 'node.exe', state: 'running', turns: 0, mid_turn: 1, started_at: Date.now() });
    await core.task.create({ spec: 'planted per B5, so this file is sensitive to a task.create regression too' });
    const afterExit = await body({ core, dataDir, runId, runCliProc, dir });

    const rs = checked(() => memoryStatsJson([runId], dataDir), dataDir, 'memory stats (live owner)');
    assert.strictEqual(rs.status, 0, `memory stats: ${rs.stdout} / ${rs.stderr}`);
    const js = JSON.parse(rs.stdout);
    assert.strictEqual(js.owner.alive, true, 'the live owner must report alive');
    assert.strictEqual(js.owner.pid, runCliProc.proc.pid, "the owner pid must be the belay run process's own pid");
    // 4b review 2, finding 1: the relabel in cmd-memory.cjs is pinned here.
    assert.strictEqual(js.owner.established_by, `owner pid ${runCliProc.proc.pid} answered this request over the pipe (this CLI process is not the owner)`, 'the owner block must name the pipe, not the owner\'s in-process wording');

    const stop = runStopSync(dataDir, runId);
    assert.strictEqual(stop.status, 0, `stop: ${stop.stdout} / ${stop.stderr}`);
    assert.ok(await waitForExit(runCliProc.proc, 15000), 'the CLI run did not exit after the stop');
    if (typeof afterExit === 'function') afterExit(dataDir);
  } finally {
    if (plantedProc && P.pidAlive(plantedProc.pid)) { try { require('../crash.cjs').crash(plantedProc); } catch { /* best effort */ } }
    if (core && runCliProc.proc.exitCode === null) { try { await core.shutdownOwner(); } catch { /* best effort */ } }
    await releaseCore(core);
    if (runCliProc.proc.exitCode === null) { try { await P.killTree(runCliProc.proc); } catch { /* best effort */ } }
    cleanup(dir);
  }
}

test('memory: search against a live owner with no model in its cache is E_MODEL_ABSENT exactly, and stats names the owner by its lock and pid', async () => {
  await withLiveOwner((dir) => ({ BELAY_MODEL_CACHE: `${dir}/no-models` }), async ({ core, dataDir, runId, runCliProc }) => {
    await core.memory.store({ namespace: `run/${runId}`, text: 'a planted row', embedding: vec1024(1), embedding_model: M.DEFAULT_MODEL, dim: 1024 });
    // SF4: the listing is compared only after the run's process has exited (awaited by pid): while it
    // lives it may itself end and remove owner.lock and the WAL files during the search.
    const before = listRecursive(dataDir);
    // The core re-pings a live owner once with a 2,000 ms bound before calling it lost (build 12b E2), so a
    // healthy owner that stalled on a fork no longer needs a retry here.
    const r = memorySearchJson(['anything at all', '-k', '2', runId, '--mode', 'semantic'], dataDir);
    assert.strictEqual(r.status, 1, `memory search: ${r.stdout} / ${r.stderr}`);
    const j = JSON.parse(r.stderr);
    assert.strictEqual(j.error.code, 'E_MODEL_ABSENT', `unexpected refusal: ${JSON.stringify(j)}`);
    assert.ok(j.error.message.includes('belay embedder fetch'), j.error.message);
    return (dataDirAfterExit) => {
      const created = listRecursive(dataDirAfterExit).filter(p => !before.includes(p));
      assert.deepStrictEqual(created, [], 'memory search created a file');
    };
  });
});

// ---- ADR 0040 §5: the read verbs and verify, in process against a fake core ------------------------
// The core methods behind these verbs are the core's own tests' business; here the CLI is driven through
// run(ctx) with ctx.openCore handing in a fake that records each call, so the flag table, the exit codes
// and the text and JSON shapes are asserted without a store.

const fs = require('node:fs');
const MEM = require('../../src/cli/cmd-memory.cjs');
const RENDER = require('../../src/cli/memory-render.cjs');

function fakeCore(over = {}) {
  const calls = [];
  const rec = (name, answer) => async (args) => { calls.push([name, args]); return typeof answer === 'function' ? answer(args) : answer; };
  const core = {
    calls,
    closed: false,
    run: { list: rec('run.list', { runs: [{ id: 'run-z', alive: true }] }) },
    memory: {
      search: rec('memory.search', { warning: null, results: [], scanned: 0, model: null, dim: null, modes_run: ['keyword'], modes_failed: [], absence_established: false }),
      list: rec('memory.list', { rows: [] }),
      get_many: rec('memory.get_many', { rows: [], found: 0, missing: [] }),
      timeline: rec('memory.timeline', { anchor: { id: 'a' }, before: [], after: [], scope: 'namespace', scope_key: 'run/run-z' }),
      setStatus: rec('memory.setStatus', { id: 'a', status: 'verified', previous_status: 'unverified', status_receipt: 'commit:abcdef1', status_by: 'operator', status_at: 1 }),
      stats: rec('memory.stats', { n: 0, namespaces: 0, workers: 0, expired: 0, owner: { alive: false, pid: null, established_by: 'x' } }),
    },
    isOwner: () => false,
    shutdownOwner: async () => { core.shutdowns = (core.shutdowns || 0) + 1; },
    close: async () => { core.closed = true; },
  };
  // A method given as an override answers without recording; a null deletes the method.
  for (const [name, fn] of Object.entries(over)) { if (fn === null) delete core.memory[name]; else core.memory[name] = fn; }
  return core;
}

async function runMem(argv, core) {
  const dir = sandbox();
  fs.mkdirSync(`${dir}/.belay`, { recursive: true });
  try {
    return await MEM.run({ argv, cwd: dir, dataDir: `${dir}/.belay`, dataDirGiven: true, json: false, openCore: async () => core });
  } finally { cleanup(dir); }
}
const callOf = (core, name) => core.calls.find(c => c[0] === name);

test('memory flag table: every flag reaches the core call as the filter or argument the ADR names', async () => {
  const core = fakeCore();
  const r = await runMem(['search', 'pidAlive', 'run-q', '--mode', 'keyword', '--index', '--type', 'note', '--type', 'decision', '--status', 'verified',
    '--task', 't1', '--worker', 'w1', '--since', '1700000000000', '--namespace', 'ns-a', '--namespace', 'ns-b', '-k', '7'], core);
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(callOf(core, 'memory.search')[1], {
    query: 'pidAlive', namespaces: ['ns-a', 'ns-b'], k: 7, mode: 'keyword', view: 'index',
    filter: { types: ['note', 'decision'], statuses: ['verified'], task_id: 't1', worker_id: 'w1', since_ms: 1700000000000 },
  });
  assert.strictEqual(r.json.run_id, 'run-q');
  assert.ok(core.closed);

  const iso = fakeCore();
  await runMem(['search', 'abc', '--since', '2026-01-02T03:04:05Z'], iso);
  assert.strictEqual(callOf(iso, 'memory.search')[1].filter.since_ms, Date.parse('2026-01-02T03:04:05Z'));
  assert.strictEqual(callOf(iso, 'memory.search')[1].namespace, 'run/run-z', 'the default namespace is the chosen run');
  assert.ok(!('mode' in callOf(iso, 'memory.search')[1]), 'no mode unless asked: the core default applies');

  const one = fakeCore();
  await runMem(['search', 'abc', '--namespace', 'only'], one);
  assert.strictEqual(callOf(one, 'memory.search')[1].namespace, 'only');

  const l = fakeCore();
  await runMem(['list', 'run-q', '--limit', '5', '--offset', '10', '--status', 'refuted', '--index'], l);
  assert.deepStrictEqual(callOf(l, 'memory.list')[1], { namespace: 'run/run-q', limit: 5, offset: 10, view: 'index', filter: { statuses: ['refuted'] } });

  const t = fakeCore();
  await runMem(['timeline', 'mem-1', '--before', '2', '--after', '3', '--scope', 'worker'], t);
  assert.deepStrictEqual(callOf(t, 'memory.timeline')[1], { anchor_id: 'mem-1', before: 2, after: 3, scope: 'worker' });

  const s = fakeCore();
  s.memory.get_many = async (a) => { s.calls.push(['memory.get_many', a]); return { rows: [], found: 0, missing: [] }; };
  await runMem(['show', 'a', 'b'], s);
  assert.deepStrictEqual(callOf(s, 'memory.get_many')[1], { ids: ['a', 'b'] });
});

test('memory usage errors exit 2 and name the problem; the core is never opened', async () => {
  const cases = [
    [[], /needs a subcommand/],
    [['frobnicate'], /unknown memory subcommand frobnicate/],
    [['search'], /takes 1 to 2 positional/],
    [['search', 'q', '--mode', 'fuzzy'], /--mode must be one of/],
    [['search', 'q', '--bogus'], /unknown option --bogus for belay memory search/],
    [['search', 'q', '--limit', '3'], /unknown option --limit for belay memory search/],
    [['list', '--since', 'yesterday'], /--since must be an integer epoch/],
    [['list', '-k', '3'], /unknown option -k for belay memory list/],
    [['search', 'q', '-k', '0'], /-k must be an integer of at least 1/],
    [['search', 'q', '--status', 'maybe'], /--status must be one of/],
    [['search', 'q', '--type'], /--type needs a value/],
    [['show'], /takes 1 to 50 positional/],
    [['timeline', 'a', '--scope', 'galaxy'], /--scope must be one of/],
    [['timeline', 'a', '--before', '-1'], /--before must be an integer/],
    [['verify', 'a'], /needs --status/],
    [['verify', 'a', '--status', 'verified'], /needs --receipt/],
    [['stats', 'a', 'b'], /takes 0 to 1 positional/],
  ];
  for (const [argv, re] of cases) {
    let opened = false;
    const r = await MEM.run({ argv, cwd: ROOT, dataDir: `${ROOT}/.belay-none`, json: false, openCore: async () => { opened = true; return fakeCore(); } });
    assert.strictEqual(r.code, 2, `${argv.join(' ')}: ${r.text}`);
    assert.match(r.text, re, argv.join(' '));
    assert.match(r.text, /usage: belay memory search/, 'the usage text follows the error');
    assert.strictEqual(opened, false, `${argv.join(' ')} opened the core`);
  }
});

test('memory search: the warning is the first line of the text and the first key of the json; exit 0 when a mode ran, 1 when none did', async () => {
  const warning = 'semantic search did not run (E_NO_EMBEDDER); these are keyword matches only; no match here does not mean no such memory';
  const answer = {
    warning, results: [{ id: 'm1', score: 0.0328, near_duplicate: false, status: 'unverified', title: 'pid check', namespace: 'run/run-z', worker_id: 'w1', task_id: 't1', type: 'note', created_at: 5 }],
    scanned: 3, model: null, dim: null, modes_run: ['keyword'], modes_failed: [{ mode: 'semantic', code: 'E_NO_EMBEDDER', message: 'no embedder' }], absence_established: false,
  };
  const r = await runMem(['search', 'pid', '--mode', 'hybrid', '--index'], fakeCore({ search: async () => answer }));
  assert.strictEqual(r.code, 0, 'a partial hybrid search still ran');
  assert.strictEqual(r.text.split('\n')[0], warning);
  assert.match(r.text, /0\.0328 .*m1 .*pid check/);
  assert.match(r.text, /modes_run: keyword/);
  assert.match(r.text, /absence_established: false/);
  assert.match(r.text, /failed: semantic E_NO_EMBEDDER/);
  assert.strictEqual(Object.keys(r.json)[0], 'warning');
  assert.strictEqual(r.json.results[0].id, 'm1');

  const none = { ...answer, results: [], modes_run: [], modes_failed: [{ mode: 'keyword', code: 'E_QUERY_SHORT', message: 'short' }] };
  const rn = await runMem(['search', 'ab', '--mode', 'keyword'], fakeCore({ search: async () => none }));
  assert.strictEqual(rn.code, 1, 'no mode ran');
  assert.strictEqual(rn.text.split('\n')[0], warning);

  const empty = { warning: null, results: [], scanned: 4, model: 'm', dim: 4, modes_run: ['semantic', 'keyword'], modes_failed: [], absence_established: true };
  const re = await runMem(['search', 'zzz', '--mode', 'hybrid'], fakeCore({ search: async () => empty }));
  assert.strictEqual(re.code, 0);
  assert.match(re.text, /^\(no results\)\n/);
  assert.match(re.text, /absence_established: true/);
});

test('memory search: a core refusal exits 1 naming the code; E_NO_EMBEDDER keeps its reason line', async () => {
  const q = fakeCore({ search: async () => { const e = new Error('no term of three characters'); e.code = 'E_QUERY_SHORT'; throw e; } });
  const r = await runMem(['search', 'ab', '--mode', 'keyword'], q);
  assert.strictEqual(r.code, 1);
  assert.match(r.text, /E_QUERY_SHORT/);
  assert.strictEqual(r.json.error.code, 'E_QUERY_SHORT');
  const n = fakeCore({ search: async () => { const e = new Error('no embedder'); e.code = 'E_NO_EMBEDDER'; throw e; } });
  const rn = await runMem(['search', 'abc'], n);
  assert.strictEqual(rn.code, 1);
  assert.match(rn.json.reason, /needs a live owner/);
});

test('memory list and timeline render rows; show exits 1 naming each missing id and keeps the found rows', async () => {
  const rows = [
    { id: 'm1', status: 'verified', namespace: 'run/run-z', worker_id: 'w1', task_id: 't1', type: 'note', title: 'first', text: 'first body', created_at: 1 },
    { id: 'm2', status: null, namespace: 'run/run-z', worker_id: 'w1', task_id: 't1', type: 'note', title: null, text: 'second\nbody', created_at: 2 },
  ];
  const l = await runMem(['list', '--index'], fakeCore({ list: async () => ({ rows }) }));
  assert.strictEqual(l.code, 0);
  assert.match(l.text, /status\s+id\s+namespace\s+worker_id\s+task_id\s+type\s+title/);
  assert.match(l.text, /verified\s+m1/);
  assert.match(l.text, /unverified\s+m2.*second body/);
  assert.strictEqual((await runMem(['list'], fakeCore())).text, '(no rows)\n');

  const t = await runMem(['timeline', 'm2'], fakeCore({ timeline: async () => ({ anchor: rows[1], before: [rows[0]], after: [], scope: 'task', scope_key: 't1' }) }));
  assert.strictEqual(t.code, 0);
  assert.match(t.text, /^anchor: m2  scope: task  scope_key: t1\n/);
  assert.ok(t.text.indexOf('m1') < t.text.lastIndexOf('m2'), 'rows in order, the anchor after its before-rows');
  assert.match(t.text, /> second body/);

  const got = { rows: [{ ...rows[0], found: true }, { id: 'gone', found: false }, { id: 'also-gone', found: false }], found: 1, missing: ['gone', 'also-gone'] };
  const s = await runMem(['show', 'm1', 'gone', 'also-gone'], fakeCore({ get_many: async () => got }));
  assert.strictEqual(s.code, 1);
  assert.match(s.text, /first body/);
  assert.match(s.text, /2 ids not found: gone, also-gone/);
  assert.deepStrictEqual(s.json.missing, ['gone', 'also-gone']);
  const ok = await runMem(['show', 'm1'], fakeCore({ get_many: async () => ({ rows: [{ ...rows[0], found: true }], found: 1, missing: [] }) }));
  assert.strictEqual(ok.code, 0);
});

test('memory verify: mode W, passes status and receipt, shuts down an owner it elected, refuses a missing data dir, and surfaces E_RECEIPT', async () => {
  const core = fakeCore();
  core.isOwner = () => true;
  const r = await runMem(['verify', 'a', '--status', 'verified', '--receipt', 'commit:abcdef1'], core);
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(callOf(core, 'memory.setStatus')[1], { id: 'a', status: 'verified', receipt: 'commit:abcdef1' });
  assert.match(r.text, /^a: verified \(was unverified\)  receipt: commit:abcdef1  by: operator/);
  assert.strictEqual(core.shutdowns, 1, 'the owner this command elected is shut down');
  assert.ok(core.closed);

  const un = fakeCore();
  await runMem(['verify', 'a', '--status', 'unverified'], un);
  assert.deepStrictEqual(callOf(un, 'memory.setStatus')[1], { id: 'a', status: 'unverified' });

  const bad = fakeCore({ setStatus: async () => { const e = new Error('receipt names no row'); e.code = 'E_RECEIPT'; e.detail = { receipt: 'memory:zz', reason: 'no such row' }; throw e; } });
  const rb = await runMem(['verify', 'a', '--status', 'verified', '--receipt', 'memory:zz'], bad);
  assert.strictEqual(rb.code, 1);
  assert.strictEqual(rb.json.error.code, 'E_RECEIPT');
  assert.deepStrictEqual(rb.json.error.detail, { receipt: 'memory:zz', reason: 'no such row' });

  let opened = false;
  const missing = await MEM.run({ argv: ['verify', 'a', '--status', 'verified', '--receipt', 'commit:abcdef1'], cwd: ROOT, dataDir: `${ROOT}/.belay-does-not-exist`, dataDirGiven: true, json: false, openCore: async () => { opened = true; return fakeCore(); } });
  assert.strictEqual(missing.code, 1);
  assert.match(missing.text, /no such data dir/);
  assert.strictEqual(opened, false);
});

test('memory: a read verb never shuts an owner down, and a core without the new methods fails by name', async () => {
  const core = fakeCore();
  core.isOwner = () => true;
  await runMem(['list'], core);
  assert.ok(!core.shutdowns, 'a read verb does not shut down');
  const r = await runMem(['timeline', 'a'], fakeCore({ timeline: null }));
  assert.strictEqual(r.code, 1);
  assert.match(r.text, /has no memory\.timeline \(E_INTERNAL\)/);
});

test('memory render: parseSince accepts epoch ms and ISO only; the stats text names the new fields when the core sends them', () => {
  assert.strictEqual(RENDER.parseSince('42'), 42);
  assert.strictEqual(RENDER.parseSince('2026-01-01T00:00:00Z'), Date.parse('2026-01-01T00:00:00Z'));
  for (const bad of ['1.5', '-5', 'yesterday', '1e22', '']) assert.strictEqual(RENDER.parseSince(bad), undefined, bad);
  const text = RENDER.renderStatsText({ n: 3, namespaces: 1, workers: 1, expired: 0, by_type: { note: 2, decision: 1 }, by_status: { unverified: 3 }, unembedded: 1, fts: { present: true, version: '1', rows: 3 }, owner: { alive: false, pid: null, established_by: 'none' } });
  assert.match(text, /by_type: note=2 decision=1/);
  assert.match(text, /fts: present=true version=1 rows=3/);
  assert.match(text, /unembedded: 1/);
});

test('belay help names every memory verb on the memory row, and every electing verb as electing', () => {
  const row = require(CLI).usage().split(/\r?\n/).find((l) => /^\s+memory\s/.test(l));
  assert.ok(row, 'help has a memory row');
  const named = / R\s+memory (.*?):/.exec(row)[1].split('|').map((v) => v.split(' ')[0]);
  for (const verb of Object.keys(RENDER.VERBS)) assert.ok(named.includes(verb), `help names memory ${verb}`);
  for (const verb of ['report', 'held settle', 'review', 'scrub', 'resolve', 'promote']) assert.ok(row.includes(verb), `help says ${verb} elects an owner`);
});
