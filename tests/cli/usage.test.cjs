'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// usage.test.cjs — `belay usage` (ADR 0041 section 6). The real core plants a ledger, the owner is shut
// down, and the built CLI reads it as a spawned process on a dead store, so every read goes through the
// copy and the data dir listing is compared before and after (reading never writes). The text rendering
// and the table_absent notice are also checked in process.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const usage = require('../../src/cli/cmd-usage.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { ROOT, CLI, sandbox, cleanup, listRecursive } = require('./stop-helpers.cjs');

async function plant(dataDir) {
  const core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-u', pid: process.pid } });
  try {
    await core.run.attach({ adapter_pid: process.pid });
    const row = (a) => core.usage.record({ substrate: 'claude-code', model: 'sonnet', ...a });
    await row({ worker_id: 'w1', task_id: 't1', turn: 1, input_tokens: 100, output_tokens: 10, cache_read_tokens: 1000, cache_creation_tokens: 50, cost_usd: 0.25, cost_basis: 'delta-of-cumulative' });
    await row({ worker_id: 'w1', task_id: 't1', turn: 2, input_tokens: 200, output_tokens: 20, cache_read_tokens: 2000, cache_creation_tokens: 0, cost_usd: 0.5, cost_basis: 'delta-of-cumulative' });
    await row({ worker_id: 'w2', task_id: 't2', turn: 1, input_tokens: 7, output_tokens: 3, cost_usd: 0.125, cost_basis: 'delta-of-cumulative (new process)' });
    await core.usage.record({ worker_id: 'w3', task_id: 't2', turn: 1, substrate: 'codex', model: 'gpt', input_tokens: 40, output_tokens: 4 }); // no dollars
  } finally { await core.shutdownOwner(); await core.close(); }
}

const cli = (args, dataDir) => spawnSync(process.execPath, [CLI, 'usage', ...args, '--data', dataDir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });

test('usage: per-turn rows, totals and the partial marker, read from the copy without writing', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    await plant(dataDir);
    const before = listRecursive(dataDir);
    const j = cli(['run-u', '--json'], dataDir);
    assert.strictEqual(j.status, 0, `${j.stdout} / ${j.stderr}`);
    assert.deepStrictEqual(listRecursive(dataDir), before, 'reading never writes');
    const out = JSON.parse(j.stdout);
    assert.strictEqual(out.run_id, 'run-u');
    assert.strictEqual(out.rows.length, 4);
    assert.deepStrictEqual([out.totals.turns, out.totals.input_tokens, out.totals.output_tokens, out.totals.cost_usd, out.totals.cost_basis_mixed], [4, 347, 37, 0.875, true]);

    const t = cli(['run-u'], dataDir);
    assert.strictEqual(t.status, 0);
    assert.match(t.stdout, /^run: run-u\n/);
    assert.match(t.stdout, /w3 +t2 +1 +gpt +40 +4 +0 +0 +- +none/, 'a turn with no dollars prints a dash and its basis');
    assert.match(t.stdout, /\$0\.2500/);
    assert.match(t.stdout, /partial: some turns reported no dollars/);
  } finally { cleanup(dir); }
});

test('usage: --by groups; a group mixing priced and unpriced turns says partial, one of priced turns does not', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    await plant(dataDir);
    const j = cli(['--by', 'task', '--json'], dataDir); // no run id: the only run is chosen, and the answer names it
    assert.strictEqual(j.status, 0, j.stderr);
    const out = JSON.parse(j.stdout);
    assert.deepStrictEqual([out.run_id, out.run_id_source], ['run-u', 'run.list']);
    const byKey = Object.fromEntries(out.groups.map(g => [g.key, g]));
    assert.deepStrictEqual([byKey.t1.turns, byKey.t1.cost_usd, byKey.t1.cost_basis_mixed], [2, 0.75, false]);
    assert.deepStrictEqual([byKey.t2.turns, byKey.t2.cost_usd, byKey.t2.cost_basis_mixed], [2, 0.125, true]);

    const t = cli(['run-u', '--by', 'task'], dataDir);
    assert.match(t.stdout, /^task +turns/m);
    assert.match(t.stdout, /^t1 +2 .*\$0\.7500$/m);
    assert.match(t.stdout, /^t2 +2 .*\$0\.1250 partial$/m);
    assert.match(t.stdout, /^total +4 /m);

    for (const by of ['worker', 'model', 'turn']) {
      const r = cli(['run-u', '--by', by, '--json'], dataDir);
      assert.strictEqual(r.status, 0, `${by}: ${r.stderr}`);
      assert.strictEqual(JSON.parse(r.stdout).totals.turns, 4);
    }
    assert.deepStrictEqual(JSON.parse(cli(['run-u', '--by', 'worker', '--json'], dataDir).stdout).groups.map(g => g.key).sort(), ['w1', 'w2', 'w3']);
  } finally { cleanup(dir); }
});

test('usage: an unknown run id and an empty ledger answer with no rows, exit 0', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    await plant(dataDir);
    const r = cli(['run-nope'], dataDir);
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /\(no usage rows\)/);
    const g = cli(['run-nope', '--by', 'model', '--json'], dataDir);
    assert.deepStrictEqual(JSON.parse(g.stdout).groups, []);
  } finally { cleanup(dir); }
});

test('usage: usage errors exit 2 and open nothing', () => {
  const dir = sandbox();
  try {
    for (const args of [['--by'], ['--by', 'color'], ['--nope'], ['a', 'b'], ['']]) {
      const r = cli(args, `${dir}/.belay`);
      assert.strictEqual(r.status, 2, args.join(' '));
      assert.match(r.stderr, /usage: belay usage/);
    }
    assert.deepStrictEqual(listRecursive(dir), [], 'no data dir was created');
  } finally { cleanup(dir); }
});

test('usage: a store without a ledger says so instead of printing zero', async () => {
  const dir = sandbox();
  try {
    const core = { run: { list: async () => ({ runs: [{ id: 'r', alive: false }] }) }, usage: { list: async () => ({ rows: [], totals: { turns: 0 }, table_absent: true }) }, close: async () => {} };
    const r = await usage.run({ argv: [], cwd: dir, dataDir: `${dir}/.belay`, dataDirGiven: true, json: false, openCore: async () => core });
    assert.strictEqual(r.code, 0);
    assert.match(r.text, /no usage table in this store/);
    assert.strictEqual(r.json.table_absent, true);
  } finally { cleanup(dir); }
});

test('usage: a core refusal exits 1 naming the code', async () => {
  const dir = sandbox();
  try {
    const core = { run: { list: async () => ({ runs: [] }) }, usage: { list: async () => { const e = new Error('bad group'); e.code = 'E_ARGS'; throw e; } }, close: async () => {} };
    const r = await usage.run({ argv: ['run-1', '--by', 'task'], cwd: dir, dataDir: `${dir}/.belay`, dataDirGiven: true, json: false, openCore: async () => core });
    assert.strictEqual(r.code, 1);
    assert.match(r.text, /bad group \(E_ARGS\)/);
  } finally { cleanup(dir); }
});
