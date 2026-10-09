'use strict';
// effort.test.cjs — build step S6b, ADR 0028: a worker's effort is a spawn argument, kept on the worker
// and passed as --effort on every launch, a relaunch after a park included. A real RunManager over
// tests/run/fakes/fake-claude.cjs and tests/run/fake-core.cjs, the shape of tests/run/park-2.test.cjs.
// No real Claude Code session is started.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-effort-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: d.replace(/\\/g, '/'), worktree: path.join(d, 'wt').replace(/\\/g, '/') };
}
function mgr(sb, core) {
  return createRunManager({
    core, dataDir: sb.data, runId: 'run-effort-test',
    paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
  });
}
async function teardown(ms, sb) {
  for (const m of ms) { if (m) { try { await m.shutdown(); } catch { /* best effort */ } } }
  cleanup(sb.data);
}
// The argv the worker's last launch was given: argv.json is rewritten by every launch.
function lastArgs(sb, id) {
  return JSON.parse(fs.readFileSync(`${sb.data}/workers/${id}/argv.json`, 'utf8')).spec.args;
}
const effortOf = (args) => (args.includes('--effort') ? args[args.indexOf('--effort') + 1] : null);

async function refusal(fn) {
  try { await fn(); } catch (e) { return e; }
  return null;
}

test('spawn: effort is refused E_ARGS for an unknown level and E_SUBSTRATE for codex, writing no row', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    for (const bad of ['ultra', '', 'HIGH', 3]) {
      const e = await refusal(() => m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'wbad', effort: bad }));
      assert.ok(e, `effort ${JSON.stringify(bad)} was accepted`);
      assert.strictEqual(e.code, 'E_ARGS');
      assert.match(e.message, /low, medium, high, xhigh, max/);
    }
    const c = await refusal(() => m.spawn({ substrate: 'codex', worktree: sb.worktree, prompt: 'one', worker_id: 'wcodex', effort: 'high' }));
    assert.ok(c, 'codex with effort was accepted');
    assert.strictEqual(c.code, 'E_SUBSTRATE');
    assert.match(c.message, /codex effort is not measured/);
    for (const id of ['wbad', 'wcodex']) {
      assert.ok(await refusal(() => core.worker.get({ worker_id: id })), `${id} has a row`);
      assert.ok(!fs.existsSync(`${sb.data}/workers/${id}`), `${id} has a directory`);
    }
  } finally { await teardown([m], sb); }
});

test('spawn: effort is on the worker row as effort_requested and on the argv of a park-resume relaunch', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m1 = mgr(sb, core);
  let m2 = null;
  try {
    const row = await m1.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1', effort: 'low' });
    assert.strictEqual(row.effort_requested, 'low');
    assert.strictEqual((await core.worker.get({ worker_id: 'w1' })).effort_requested, 'low');
    assert.strictEqual(effortOf(lastArgs(sb, 'w1')), 'low', 'the fresh launch');
    await m1._waitTurn('w1', 8000);

    // The same adapter parks and resumes: the relaunch goes through launch() with --resume.
    await m1.pause({ worker_id: 'w1', by: 'operator:1' });
    const resumedRes = await m1.resume({ worker_id: 'w1', by: 'operator:1' });
    assert.strictEqual(resumedRes.effort, 'low', 'resume names the level the relaunch was given (SF3)');
    const again = lastArgs(sb, 'w1');
    assert.ok(again.includes('--resume'), 'the second launch is a resume');
    assert.strictEqual(effortOf(again), 'low', 'a park-resume relaunch keeps the level');
    assert.strictEqual((await core.worker.get({ worker_id: 'w1' })).effort_requested, 'low');
    await m1._waitTurn('w1', 8000);

    // Another adapter adopts the parked worker: the level comes back from the row.
    await m1.pause({ worker_id: 'w1', by: 'operator:1' });
    m2 = mgr(sb, core);
    const adoptedRes = await m2.resume({ worker_id: 'w1', by: 'operator:2' });
    assert.strictEqual(adoptedRes.effort, 'low');
    const adopted = lastArgs(sb, 'w1');
    assert.ok(adopted.includes('--resume'));
    assert.strictEqual(effortOf(adopted), 'low', 'a cross-adapter resume keeps the level');
  } finally { await teardown([m2, m1], sb); }
});

test('spawn: a worker spawned without effort has a null effort_requested and no --effort on any launch', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w2' });
    assert.strictEqual(row.effort_requested, null);
    assert.strictEqual(effortOf(lastArgs(sb, 'w2')), null);
    await m._waitTurn('w2', 8000);
    await m.pause({ worker_id: 'w2', by: 'operator:1' });
    await m.resume({ worker_id: 'w2', by: 'operator:1' });
    assert.strictEqual(effortOf(lastArgs(sb, 'w2')), null);
  } finally { await teardown([m], sb); }
});
