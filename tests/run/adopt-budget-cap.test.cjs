'use strict';
require('../helpers/tmp.cjs');
// A worker spawned with `max_budget_usd` (the stage jobs' cost cap) launches with
// `--max-budget-usd`. A second adapter that adopts it (worker.cjs `adopt`) rebuilds the record from the row
// and argv.json (lifecycle.cjs `readLaunchOptions`), which must carry the cap, or its relaunch runs without one.
// Two managers over one fake core and data dir, as two adapters of the same run would be.

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
const argvOf = (data, id) => JSON.parse(fs.readFileSync(path.join(data, 'workers', id, 'argv.json'), 'utf8')).spec.args;
const capOf = (args) => { const i = args.indexOf('--max-budget-usd'); return i >= 0 ? args[i + 1] : null; };

test('a relaunch by an adopting adapter keeps the worker\'s --max-budget-usd', async (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-audit-cap-'));
  fs.mkdirSync(path.join(d, 'wt'));
  const data = fwd(d);
  const core = createFakeCore();
  const mk = () => createRunManager({ core, dataDir: data, runId: 'run-cap', paths: { claudeExe: FAKE, userSettings: USER_SETTINGS } });
  const first = mk();
  let second = null;
  t.after(async () => { if (second) await second.shutdown().catch(() => {}); await first.shutdown().catch(() => {}); try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* tmp */ } });

  await first.spawn({ substrate: 'claude-code', worktree: fwd(path.join(d, 'wt')), prompt: 'one', worker_id: 'w-cap', max_budget_usd: 0.25 });
  const before = capOf(argvOf(d, 'w-cap'));
  await first._waitTurn('w-cap', 20000);
  await first.stop({ worker_id: 'w-cap', mode: 'kill', timeout_ms: 5000 });

  second = mk();
  await second.restart({ worker_id: 'w-cap', first_turn_timeout_ms: 20000 });
  const after = capOf(argvOf(d, 'w-cap'));
  assert.equal(before, '0.25');
  assert.equal(after, '0.25', 'the adopted relaunch must keep the cost cap the worker was spawned with');
});

test('readLaunchOptions reads the cost cap, and a launch without one has none', () => {
  const LC = require('../../src/run/lifecycle.cjs');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-cap-argv-'));
  try {
    const write = (args) => fs.writeFileSync(path.join(d, 'argv.json'), JSON.stringify({ spec: { args } }));
    write(['-p', '--max-budget-usd', '0.5', '--model', 'm']);
    assert.equal(LC.readLaunchOptions(d).maxBudgetUsd, 0.5);
    write(['-p', '--model', 'm']);
    assert.equal(LC.readLaunchOptions(d).maxBudgetUsd, null);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
