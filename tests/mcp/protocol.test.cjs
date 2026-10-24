// protocol.test.cjs — the adapter as a process: what argv it refuses, that `initialize` answers fast
// and touches nothing, that identity comes from argv alone, that a role refuses the other role's tools
// by name, and that a call taking seconds does not stop the loop answering.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { launch, runArgv, sandboxDir, FAKE, BIN } = require('./rpc.cjs');

// The wire log is written asynchronously (src/mcp/log-writer.cjs): a line logged before a reply can land after the
// client has read that reply. A live adapter's log is polled until the line appears; the bound is the failure.
async function logMatching(file, re, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* not created yet */ }
    if (re.test(text) || Date.now() - t0 >= ms) return text;
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('argv refusals exit 2 with one line on stderr', async () => {
  const cases = [
    { args: ['--role', 'worker', '--run', 'r1'], why: 'worker without --worker-id' },
    { args: ['--role', 'orchestrator'], why: 'no --run' },
    { args: ['--run', 'r1'], why: 'no --role' },
    { args: ['--role', 'operator', '--run', 'r1'], why: 'unknown role' },
    { args: ['--headless', '--role', 'orchestrator', '--run', 'r1'], why: '--headless is out of scope' },
    { args: ['--role', 'orchestrator', '--run', 'r1', '--swarm'], why: 'unknown argument' },
    { args: ['--role', 'orchestrator', '--run', 'r1', '--worker-id', 'wk-1'], why: 'orchestrator with a worker id' },
  ];
  for (const c of cases) {
    const r = await runArgv(c.args);
    assert.strictEqual(r.code, 2, `${c.why}: expected exit 2, got ${r.code} (stderr: ${r.err.trim()})`);
    const lines = r.err.trim().split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1, `${c.why}: expected one stderr line, got ${lines.length}`);
    assert.match(lines[0], /^belay-mcp: /, `${c.why}: stderr names the binary`);
    assert.strictEqual(r.out, '', `${c.why}: nothing on stdout`);
  }
});

test('a --log path inside the data dir is refused unless it is under workers/<worker-id>/', async () => {
  const parent = sandboxDir('logrefuse');
  const data = `${parent}/store`;
  const base = ['--run', 'r1', '--data', data];
  const refused = [
    { why: 'directly in the data dir', args: ['--role', 'orchestrator', ...base, '--log', `${data}/wire.log`] },
    { why: 'the data dir itself', args: ['--role', 'orchestrator', ...base, '--log', data] },
    { why: 'in workers/ but under no worker', args: ['--role', 'orchestrator', ...base, '--log', `${data}/workers/wire.log`] },
    { why: 'beside memory.db under another fixed name', args: ['--role', 'orchestrator', ...base, '--log', `${data}/tmp/wire.log`] },
    { why: 'a worker logging into another worker\'s directory', args: ['--role', 'worker', '--worker-id', 'wk-1', ...base, '--log', `${data}/workers/wk-2/adapter.log`] },
    // The exception is the caller's own directory, and an orchestrator has no worker id, so it has no
    // directory inside the data dir to claim.
    { why: 'an orchestrator logging into a worker\'s directory', args: ['--role', 'orchestrator', ...base, '--log', `${data}/workers/wk-1/adapter.log`] },
  ];
  for (const c of refused) {
    const r = await runArgv(c.args);
    assert.strictEqual(r.code, 2, `${c.why}: expected exit 2, stderr: ${r.err}`);
    assert.match(r.err, /--log must not point inside the data dir except under workers\//, c.why);
    const lines = r.err.trim().split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1, `${c.why}: one stderr line`);
  }

  // api.md §1 names the one exception: the caller's own worker directory, beside the adapter.log the
  // run manager already writes there. The directory has to exist for a log to land in it; the run
  // manager creates it before it launches the worker that carries this argv.
  fs.mkdirSync(`${data}/workers/wk-1`, { recursive: true });
  const own = `${data}/workers/wk-1/adapter.log`;
  const ok = await runArgv(['--role', 'worker', '--worker-id', 'wk-1', ...base, '--log', own]);
  assert.strictEqual(ok.code, 0, `a worker's own directory is the exception, stderr: ${ok.err}`);
  assert.match(fs.readFileSync(own, 'utf8'), /## start role=worker/, 'the log was actually written there');

  const beside = await runArgv(['--role', 'orchestrator', ...base, '--log', `${parent}/wire.log`]);
  assert.strictEqual(beside.code, 0, `a log beside the data dir is fine, stderr: ${beside.err}`);
});

test('a malformed BELAY_FAKE_PATHS is a startup exit 2, never an exit from inside a request', async () => {
  const parent = sandboxDir('fakepaths');
  const argv = ['--role', 'orchestrator', '--run', 'r1', '--data', `${parent}/store`];
  const cases = [
    { why: 'not JSON at all', env: { BELAY_FAKE_PATHS: '{not json' }, re: /BELAY_FAKE_PATHS is not valid JSON/ },
    { why: 'a JSON scalar', env: { BELAY_FAKE_PATHS: '7' }, re: /BELAY_FAKE_PATHS must be a JSON object/ },
    { why: 'a JSON array', env: { BELAY_FAKE_PATHS: '["claudeExe"]' }, re: /BELAY_FAKE_PATHS must be a JSON object/ },
    { why: 'JSON null', env: { BELAY_FAKE_PATHS: 'null' }, re: /BELAY_FAKE_PATHS must be a JSON object/ },
  ];
  for (const c of cases) {
    const r = await runArgv(argv, c.env);
    assert.strictEqual(r.code, 2, `${c.why}: expected exit 2, stderr: ${r.err}`);
    assert.match(r.err, c.re, c.why);
    const lines = r.err.trim().split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1, `${c.why}: one stderr line`);
    assert.strictEqual(r.out, '', `${c.why}: nothing was ever answered on stdout`);
  }

  // Both variables are read once at module load, so the refusal lands before a client can connect:
  // an adapter that answered `initialize` and then died mid-request would look to Claude Code like a
  // server that crashed under load rather than one that was misconfigured.
  const a = launch({ role: 'orchestrator', data: `${parent}/store2`, env: { BELAY_FAKE_PATHS: '{not json' } });
  const { code } = await a.exited;
  assert.strictEqual(code, 2, 'the same refusal reaches a client as a dead server, not a bad answer');
  assert.strictEqual(fs.existsSync(`${parent}/store2`), false, 'and nothing was created on the way out');
});

test('BELAY_FAKE_CORE is refused unless it names a fixture under this repo\'s tests/', async () => {
  const parent = sandboxDir('fakecore');
  const stray = `${parent}/evil-core.cjs`;
  fs.writeFileSync(stray, 'module.exports = { openCore: async () => ({}) };');
  const r = await runArgv(['--role', 'orchestrator', '--run', 'r1', '--data', `${parent}/store`],
    { BELAY_FAKE_CORE: stray });
  assert.strictEqual(r.code, 2, `expected exit 2, stderr: ${r.err}`);
  assert.match(r.err, /BELAY_FAKE_CORE must name a fixture under/);
});

test('initialize answers without opening a store and leaves the data dir empty', async (t) => {
  const parent = sandboxDir('init');
  const data = `${parent}/store`;   // deliberately not created; opening the store would create it
  const a = launch({ role: 'orchestrator', data });
  t.after(async () => { await a.close(); a.kill(); });
  const t0 = process.hrtime.bigint();
  const r = await a.initialize();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`initialize: ${ms.toFixed(1)} ms`);
  assert.strictEqual(r.result.serverInfo.name, 'belay');
  assert.strictEqual(r.result.protocolVersion, '2025-06-18');
  // The dir and sandbox assertions below are the strict check that initialize opens no store. The time bound only has to
  // stay under what opening one costs; a loaded host took 1.07 s for the whole test, so the bound is 5 s.
  assert.ok(ms < 5000, `initialize took ${ms.toFixed(1)} ms`);
  assert.strictEqual(fs.existsSync(data), false, 'initialize created the data dir');
  assert.deepStrictEqual(fs.readdirSync(parent), [], 'initialize wrote into the sandbox');
  // tools/list is also answerable without a store.
  assert.strictEqual((await a.list()).length, require('../../src/mcp/tools.cjs').toolsFor('orchestrator').length);
  assert.strictEqual(fs.existsSync(data), false, 'tools/list created the data dir');
});

test('identity is the argv identity, and no request can change it', async (t) => {
  const data = sandboxDir('ident');
  const a = launch({ role: 'worker', data, workerId: 'wk-argv', run: 'run-argv' });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();
  // The fake core stamps every row with caller.worker_id; a request that tries to claim another one
  // must not change what is written. A worker_id argument is a harness field and is refused by name at the
  // boundary, and so is a forged caller (memory_store takes only the properties its schema names).
  const forged = await a.call('memory_store', { text: 'hello', worker_id: 'wk-forged' });
  assert.strictEqual(forged.isError, true);
  assert.strictEqual(forged.structuredContent.error, 'E_ARGS');
  assert.strictEqual(forged.structuredContent.detail.field, 'worker_id');
  const caller = await a.call('memory_store', { text: 'hello', caller: { worker_id: 'wk-forged', role: 'orchestrator' } });
  assert.deepStrictEqual([caller.isError, caller.structuredContent.error, caller.structuredContent.detail.field], [true, 'E_ARGS', 'caller']);
  const r = await a.call('memory_store', { text: 'hello' });
  assert.strictEqual(r.isError, false);
  assert.strictEqual(r.structuredContent.worker_id, 'wk-argv');
  assert.strictEqual(r.structuredContent.namespace, 'run/run-argv');
});

test('--data is normalised to one canonical spelling, whatever form it is given in', async (t) => {
  // Every other test in this suite hands the adapter a path that is already forward-slashed and
  // absolute, so none of them can catch the normaliser breaking: a fixture shaped like the expected
  // output cannot test a normaliser. These four cases are deliberately not in the output's shape.
  // The fake core echoes the dataDir it was opened with, which isolates the adapter's own
  // normalisation from the core's.
  const BACKSLASH = String.fromCharCode(92);
  const parent = sandboxDir('canon');
  const native = `${parent}/store`.split('/').join(BACKSLASH);
  const cases = [
    { why: 'native separators', data: native, cwd: undefined, expect: `${parent}/store` },
    { why: 'trailing separator', data: `${parent}/store/`, cwd: undefined, expect: `${parent}/store` },
    { why: 'relative to cwd', data: 'store', cwd: parent, expect: `${parent}/store` },
    { why: 'omitted, defaults to .belay', data: undefined, cwd: parent, expect: `${parent}/.belay` },
  ];
  for (const c of cases) {
    const a = launch({ role: 'orchestrator', data: c.data, cwd: c.cwd });
    t.after(async () => { await a.close(); a.kill(); });
    await a.initialize();
    const seen = (await a.call('status', {})).structuredContent.data_dir;
    assert.strictEqual(seen, c.expect, `${c.why}: expected ${c.expect}, got ${seen}`);
    assert.ok(!seen.includes(BACKSLASH), `${c.why}: the canonical spelling carries no backslash`);
  }
});

test('a worker-role process refuses every orchestrator tool by name with E_ROLE', async (t) => {
  const data = sandboxDir('role');
  const a = launch({ role: 'worker', data, workerId: 'wk-1' });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();
  const listed = new Set((await a.list()).map((x) => x.name));
  for (const name of ['worker_spawn', 'worker_message', 'worker_stop', 'worker_restart', 'task_create', 'task_assign']) {
    assert.ok(!listed.has(name), `${name} must not be listed to a worker`);
    const r = await a.call(name, {});
    assert.strictEqual(r.isError, true, `${name} must be refused`);
    assert.strictEqual(r.structuredContent.error, 'E_ROLE');
    assert.match(r.structuredContent.message, new RegExp(name), 'the refusal names the tool');
    assert.strictEqual(r.structuredContent.row, undefined, 'a refusal carries no row');
  }
});

test('an orchestrator-role process refuses every worker tool with E_ROLE', async (t) => {
  const data = sandboxDir('role2');
  const a = launch({ role: 'orchestrator', data });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();
  for (const name of ['lease_renew', 'lease_release', 'checkpoint_write']) {
    const r = await a.call(name, {});
    assert.strictEqual(r.isError, true, `${name} must be refused`);
    assert.strictEqual(r.structuredContent.error, 'E_ROLE');
  }
});

test('an unknown tool name is an error result, not a crash', async (t) => {
  const data = sandboxDir('unknown');
  const a = launch({ role: 'orchestrator', data });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();
  const r = await a.call('swarm_init', {});
  assert.strictEqual(r.isError, true);
  assert.strictEqual(r.structuredContent.error, 'E_ARGS');
  assert.strictEqual((await a.call('status', {})).isError, false, 'the loop still answers');
});

test('worker_spawn takes seconds and does not block status or the other calls', async (t) => {
  const data = sandboxDir('spawn');
  const a = launch({ role: 'orchestrator', data });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();
  const t0 = Date.now();
  const spawning = a.call('worker_spawn', { substrate: 'claude-code', worktree: data, prompt: 'go', __delay_ms: 4000 });
  const st = await a.call('status', {});
  const statusMs = Date.now() - t0;
  assert.strictEqual(st.isError, false);
  // The spawn holds for 4 s; a status that waited on it would take at least that. A hosted runner needed 100 ms, so 2.5 s.
  assert.ok(statusMs < 2500, `status answered in ${statusMs} ms while worker_spawn was still running`);
  const sp = await spawning;
  const spawnMs = Date.now() - t0;
  assert.strictEqual(sp.isError, false);
  assert.strictEqual(sp.structuredContent.state, 'running');
  console.log(`status ${statusMs} ms during a ${spawnMs} ms worker_spawn`);
});

test('the run manager is handed this binary\'s own path as paths.mcpBinary', async (t) => {
  const data = sandboxDir('paths');
  const a = launch({ role: 'orchestrator', data });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();
  const r = await a.call('worker_spawn', { substrate: 'claude-code', worktree: data, prompt: 'go', view: 'debug' });
  assert.strictEqual(r.isError, false);
  // api.md §1 leaves paths optional with a default resolved from src/run. The adapter passes its own
  // path instead, which is the one that is right when belay runs from another checkout.
  assert.deepStrictEqual(Object.keys(r.structuredContent.__paths), ['mcpBinary']);
  assert.strictEqual(r.structuredContent.__paths.mcpBinary, BIN);
  assert.ok(fs.existsSync(BIN), 'the path handed over names a file that exists');
});

test('twenty concurrent task_list calls all answer, each with its own id', async (t) => {
  const data = sandboxDir('concurrent');
  const a = launch({ role: 'orchestrator', data });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();
  const sent = [];
  for (let i = 0; i < 20; i += 1) sent.push(a.send('tools/call', { name: 'task_list', arguments: { __delay_ms: 30 } }));
  const results = await Promise.all(sent);
  const ids = results.map((r) => r.id);
  assert.strictEqual(new Set(ids).size, 20, 'twenty distinct ids came back');
  for (const r of results) {
    assert.strictEqual(r.result.isError, false);
    assert.ok(Array.isArray(r.result.structuredContent.tasks));
  }
});

test('stdin end shuts the run manager down gracefully and exits 0', async () => {
  const parent = sandboxDir('shutdown');
  const data = `${parent}/store`;
  const log = `${parent}/wire.log`;   // never inside the data dir; api.md §1 fixes what lives there
  const a = launch({ role: 'orchestrator', data, log });
  await a.initialize();
  await a.call('worker_spawn', { substrate: 'codex', worktree: data, prompt: 'go' });
  const code = await a.close();
  assert.strictEqual(code, 0, `exit code ${code}, stderr: ${a.stderr}`);
  const wire = fs.readFileSync(log, 'utf8');
  assert.match(wire, /## stdin end/, 'the wire log records the stdin end');
  assert.match(wire, /run\.attach epoch=\S+ reattached=\S+ workers_marked_dead=\d+/,
    'attach\'s result is recorded, including any workers it declared dead');
  assert.match(wire, /shutdown stopped=\d+.* ms=/, 'shutdown names the workers it stopped');
  a.kill();
});

test('the attach result is kept, logged, and carried by status', async (t) => {
  const parent = sandboxDir('attach');
  const data = `${parent}/store`;
  const log = `${parent}/wire.log`;
  const a = launch({ role: 'orchestrator', data, log, env: { BELAY_FAKE_REATTACH: '1' } });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();

  // The sandbox holds no memory.db, so there is no epoch to settle and status says nothing about an
  // attach rather than guessing. The store-present case is the test below.
  const before = (await a.call('status', {})).structuredContent;
  assert.strictEqual(before.attach, undefined, 'status invents no attach before one has happened');

  // worker_spawn is the first call that needs the run manager, which is what runs run.attach.
  assert.strictEqual((await a.call('worker_spawn', { substrate: 'codex', worktree: data, prompt: 'go' })).isError, false);

  const after = (await a.call('status', {})).structuredContent;
  assert.deepStrictEqual(after.attach, { reattached: true, workers_marked_dead: ['wk-dead-1', 'wk-dead-2'] },
    'a reattach that declared workers dead is visible to the session that caused it');
  // Additive to api.md §4, not a change to it: every field the core returned is still there, unchanged.
  for (const k of Object.keys(before)) {
    assert.deepStrictEqual(after[k], before[k], `status.${k} was altered by the adapter`);
  }
  assert.deepStrictEqual(Object.keys(after).filter((k) => !(k in before)), ['attach'], 'attach is the only field added');

  const attachLine = /## run\.attach epoch=2 reattached=true workers_marked_dead=2 \[wk-dead-1, wk-dead-2\]/;
  assert.match(await logMatching(log, attachLine), attachLine,
    'the wire log names the workers the attach declared dead');
});

test('an orchestrator settles the epoch before its first answer when a store is already there', async (t) => {
  const parent = sandboxDir('epoch');
  const data = `${parent}/store`;
  const log = `${parent}/wire.log`;
  // Only the store's presence decides whether there is an epoch to settle, and `memory.db` is what
  // api.md §4's store-present rung stats, so an empty one is enough to stand for a previous session.
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(`${data}/memory.db`, '');
  const a = launch({ role: 'orchestrator', data, log, env: { BELAY_FAKE_REATTACH: '1' } });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();

  // The very first tool call, and it is a read. No worker tool is ever called in this test.
  const s = (await a.call('status', {})).structuredContent;
  assert.deepStrictEqual(s.attach, { reattached: true, workers_marked_dead: ['wk-dead-1', 'wk-dead-2'] },
    'the reconstruction must not wait for a worker tool the session may never call');
  assert.match(await logMatching(log, /## run\.attach epoch=2 reattached=true/), /## run\.attach epoch=2 reattached=true/);

  // A worker-role adapter on the same store never attaches: run.attach is orchestrator-only, and a
  // worker never elects an owner (api.md §1, §3).
  const w = launch({ role: 'worker', data, workerId: 'wk-1', env: { BELAY_FAKE_REATTACH: '1' } });
  t.after(async () => { await w.close(); w.kill(); });
  await w.initialize();
  assert.strictEqual((await w.call('status', {})).structuredContent.attach, undefined,
    'a worker adapter has no epoch of its own to settle');
});

test('stdin ending while the run manager is still being created waits for it, then stops it', async () => {
  const parent = sandboxDir('midcreate');
  const data = `${parent}/store`;
  const log = `${parent}/wire.log`;
  // run.attach is made slow, so stdin ends while openRunManagerOnce is still in flight. Exiting on
  // the core-only branch here would leave a worker the manager is about to own with nobody to stop it.
  const a = launch({ role: 'orchestrator', data, log, env: { BELAY_FAKE_ATTACH_DELAY_MS: '1200' } });
  await a.initialize();
  // Deliberately not awaited: the point is that stdin ends first. The adapter may exit before it
  // answers, so the pending reply is allowed to go unanswered.
  a.send('tools/call', { name: 'worker_spawn', arguments: { substrate: 'codex', worktree: data, prompt: 'go' } }).catch(() => {});
  const t0 = Date.now();
  const code = await a.close(20000);
  const ms = Date.now() - t0;
  a.kill();
  assert.strictEqual(code, 0, `exit code ${code}, stderr: ${a.stderr}`);
  assert.ok(ms >= 1000, `shutdown returned in ${ms} ms, too fast to have waited for the 1,200 ms attach`);
  const wire = fs.readFileSync(log, 'utf8');
  assert.match(wire, /## shutdown stopped=\d+.* ms=/, 'the run manager was created and then shut down');
  console.log(`shutdown waited ${ms} ms for a run manager mid-creation`);
});

test('a graceful shutdown that threw exits non-zero and says so', async () => {
  const parent = sandboxDir('shutdownfail');
  const data = `${parent}/store`;
  const a = launch({ role: 'orchestrator', data, env: { BELAY_FAKE_SHUTDOWN_THROW: '1' } });
  await a.initialize();
  assert.strictEqual((await a.call('worker_spawn', { substrate: 'codex', worktree: data, prompt: 'go' })).isError, false);
  const code = await a.close();
  a.kill();
  // Invariant 5 applied to the adapter's own exit: a parent that could not stop its workers has not
  // succeeded, and exit 0 is what a supervisor reads as success.
  assert.strictEqual(code, 1, `expected a non-zero exit, got ${code}; stderr: ${a.stderr}`);
  assert.match(a.stderr, /shutdown error: fake run manager could not stop its workers/,
    'the stderr names what failed, not just that something did');
});

test('a worker-role process closes its core on stdin end and exits 0', async () => {
  const data = sandboxDir('shutdown2');
  const a = launch({ role: 'worker', data, workerId: 'wk-1' });
  await a.initialize();
  await a.call('memory_stats', {});
  const code = await a.close();
  assert.strictEqual(code, 0, `exit code ${code}, stderr: ${a.stderr}`);
  a.kill();
});

test('without BELAY_FAKE_CORE the adapter reaches the real core, not the fixture', async (t) => {
  // The fixture and src/core answer memory_stats differently, so the row itself says which was
  // loaded. Previously this test asserted only that the fixture file existed, which was true either
  // way and proved nothing.
  assert.ok(fs.existsSync(FAKE), 'the fixture exists, so a fallback to it would be possible');

  const fake = launch({ role: 'orchestrator', data: sandboxDir('which-fake') });
  t.after(async () => { await fake.close(); fake.kill(); });
  await fake.initialize();
  const fakeStats = (await fake.call('memory_stats', {})).structuredContent;
  assert.strictEqual(fakeStats.owner.pipe, 'fake', 'the fixture names itself');

  const real = launch({ role: 'orchestrator', data: sandboxDir('which-real'), fake: false });
  t.after(async () => { await real.close(); real.kill(); });
  await real.initialize();
  const realStats = (await real.call('memory_stats', {})).structuredContent;
  assert.notStrictEqual(realStats.owner.pipe, 'fake', 'without the variable the real core is loaded');
  assert.ok(Object.prototype.hasOwnProperty.call(realStats, 'sqlite_version'),
    'the real core answers with its own stats shape');
});
