'use strict';
require('../helpers/tmp.cjs');
// A worker spawned with `max_budget_usd` (the stage jobs' cost cap) launches with `--max-budget-usd`, and its row records the cap and
// the requested model (ADR 0024 amendment 4: the row is the harness's record). A second adapter that adopts it (worker.cjs `adopt`)
// takes both from the row, never from argv.json, which the worker can edit: an edited, deleted or corrupt argv.json leaves the
// relaunch with exactly the row's cap and model. Two managers over one fake core and data dir, as two adapters of the same run would be.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');

const fwd = (p) => String(p).split(path.sep).join('/');
const FAKE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
const USER_SETTINGS = fwd(path.join(__dirname, 'fixtures', 'user-settings.json'));
const argvFile = (data, id) => path.join(data, 'workers', id, 'argv.json');
const argvOf = (data, id) => JSON.parse(fs.readFileSync(argvFile(data, id), 'utf8')).spec.args;
const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

const TAMPER = {
  'argv.json untouched': () => {},
  'argv.json edited to raise the cap and change the model': (data, id) => {
    const j = JSON.parse(fs.readFileSync(argvFile(data, id), 'utf8')); const a = j.spec.args;
    a[a.indexOf('--max-budget-usd') + 1] = '5000'; a[a.indexOf('--model') + 1] = 'claude-opus-5-5';
    fs.writeFileSync(argvFile(data, id), JSON.stringify(j));
  },
  'argv.json edited to drop the cap': (data, id) => {
    const j = JSON.parse(fs.readFileSync(argvFile(data, id), 'utf8')); const a = j.spec.args;
    a.splice(a.indexOf('--max-budget-usd'), 2);
    fs.writeFileSync(argvFile(data, id), JSON.stringify(j));
  },
  'argv.json deleted': (data, id) => fs.rmSync(argvFile(data, id)),
  'argv.json corrupt': (data, id) => fs.writeFileSync(argvFile(data, id), '{ not json'),
};

for (const [name, tamper] of Object.entries(TAMPER)) {
  test(`adopt: ${name}; the relaunch has exactly the row's cost cap and model`, async (t) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-cap-'));
    fs.mkdirSync(path.join(d, 'wt'));
    const data = fwd(d);
    const core = createFakeCore();
    const mk = () => createRunManager({ core, dataDir: data, runId: 'run-cap', paths: { claudeExe: FAKE, userSettings: USER_SETTINGS } });
    const first = mk();
    let second = null;
    t.after(async () => { if (second) await second.shutdown().catch(() => {}); await first.shutdown().catch(() => {}); try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* tmp */ } });

    await first.spawn({ substrate: 'claude-code', worktree: fwd(path.join(d, 'wt')), prompt: 'one', worker_id: 'w-cap', max_budget_usd: 0.25, model: 'claude-sonnet-5-5' });
    assert.equal(flag(argvOf(d, 'w-cap'), '--max-budget-usd'), '0.25');
    assert.equal(core.currentWorker('w-cap').max_budget_usd, 0.25, 'the row records the cap');
    assert.equal(core.currentWorker('w-cap').model_requested, 'claude-sonnet-5-5', 'the row records the requested model');
    await first._waitTurn('w-cap', 20000);
    await first.stop({ worker_id: 'w-cap', mode: 'kill', timeout_ms: 5000 });
    tamper(d, 'w-cap');

    second = mk();
    await second.restart({ worker_id: 'w-cap', first_turn_timeout_ms: 20000 });
    const args = argvOf(d, 'w-cap');
    assert.equal(flag(args, '--max-budget-usd'), '0.25', 'the adopted relaunch keeps the row\'s cost cap');
    assert.equal(flag(args, '--model'), 'claude-sonnet-5-5', 'and the row\'s model');
    assert.equal(core.currentWorker('w-cap').max_budget_usd, 0.25, 'and the relaunch\'s rows still carry the cap');
  });
}

test('a worker spawned without a cap has none on its row, and an adopted relaunch passes none', async (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-cap-none-'));
  fs.mkdirSync(path.join(d, 'wt'));
  const data = fwd(d);
  const core = createFakeCore();
  const mk = () => createRunManager({ core, dataDir: data, runId: 'run-cap', paths: { claudeExe: FAKE, userSettings: USER_SETTINGS } });
  const first = mk();
  let second = null;
  t.after(async () => { if (second) await second.shutdown().catch(() => {}); await first.shutdown().catch(() => {}); try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* tmp */ } });
  await first.spawn({ substrate: 'claude-code', worktree: fwd(path.join(d, 'wt')), prompt: 'one', worker_id: 'w-nocap' });
  assert.equal(core.currentWorker('w-nocap').max_budget_usd, null);
  await first._waitTurn('w-nocap', 20000);
  await first.stop({ worker_id: 'w-nocap', mode: 'kill', timeout_ms: 5000 });
  second = mk();
  await second.restart({ worker_id: 'w-nocap', first_turn_timeout_ms: 20000 });
  assert.equal(flag(argvOf(d, 'w-nocap'), '--max-budget-usd'), null);
});

test('adopt: a dead row keeps its reported cost and tokens whole, and its cost base; the estimate is not folded in', async () => {
  const { adopt } = require('../../src/run/worker.cjs');
  const row = {
    id: 'wd', run_id: 'run-est', substrate: 'claude-code', state: 'dead', pid: null, worktree: '/tmp/x', turns: 1, cost_usd: 4.2, cost_base: 1.5, input_tokens: 110, output_tokens: 60,
    cache_read_tokens: 1000, cache_creation_tokens: 7, cost_source: 'transcript_estimate',
    cost_estimate: { source: 'transcript_estimate', usd: 1.2, input_tokens: 10, output_tokens: 20, cache_read_tokens: 300, cache_creation_tokens: 7 },
  };
  const core = { worker: { async get() { return row; } } };
  const w = await adopt({ core, workerId: 'wd', dataDir: fwd(os.tmpdir()) });
  assert.deepStrictEqual([w.costUsd, w.costBase, w.inputTokens, w.outputTokens, w.cacheReadTokens, w.cacheCreationTokens], [4.2, 1.5, 110, 60, 1000, 7]);
});
