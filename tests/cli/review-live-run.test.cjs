'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// review-live-run.test.cjs — `belay memory review` waits for any other live run (audit D35). A run's close shuts the store
// owner down under every connection, so a minutes-long, paid review begun beside a live run could lose its calls and leave a
// stray owner that refuses the next `belay run`. The run it acts for is the operator's own word and is not counted.

const { test } = require('node:test');
const assert = require('node:assert');
const { setup } = require('../core/lifecycle-env.cjs');
const { cleanup } = require('../core/helpers.cjs');
const { run } = require('../../src/cli/cmd-memory.cjs');

const cmd = (T, argv, stageDeps) => run({ argv, cwd: T.dir, dataDir: T.dir, dataDirGiven: true, stageDeps });
async function planted(fn) {
  const T = await setup();
  try { return await fn(T); } finally { try { T.store.close(); } catch { /* closed by the test */ } cleanup(T.dir); }
}
const never = () => assert.fail('nothing may be spawned or launched while another run is live');

test('a review with --project, which picks an ended run, is refused while another run is live, and spawns nothing', async () => {
  await planted(async (T) => {
    await T.call(T.who.operator('apply'), 'run.end', { exit_reason: 'test' }); // the newest ended run with notes on; five others stay live
    T.store.close();
    const r = await cmd(T, ['review', '--project', 'lc', '--all', '--worktree', T.repo], { makeManager: never, spawnDetached: never });
    assert.strictEqual(r.code, 1, r.text);
    assert.strictEqual(r.json.error.code, 'E_BUSY');
    assert.match(r.text, /is live in this data dir/);
    assert.ok(r.json.error.live_runs.includes('lc-propose') && !r.json.error.live_runs.includes('lc-apply'), 'it names the live runs, not the one acted for');
  });
});

test('--run naming an ended run is refused the same way, and so is the detached launcher (--start)', async () => {
  await planted(async (T) => {
    await T.call(T.who.operator('apply'), 'run.end', { exit_reason: 'test' });
    T.store.close();
    const r = await cmd(T, ['review', '--run', 'lc-apply', '--all', '--worktree', T.repo], { makeManager: never });
    assert.strictEqual(r.json.error.code, 'E_BUSY');
    const s = await cmd(T, ['review', '--run', 'lc-apply', '--project', 'lc', '--start', '--worktree', T.repo], { spawnDetached: never });
    assert.strictEqual(s.code, 1);
    assert.strictEqual(s.json.error.code, 'E_BUSY');
  });
});

test('with no other live run the review proceeds (the acted-for run itself may be live)', async () => {
  await planted(async (T) => {
    await T.endOthers('apply');
    T.store.close();
    const r = await cmd(T, ['review', '--run', 'lc-apply', '--all', '--worktree', T.repo], { makeManager: never });
    assert.notStrictEqual(r.json && r.json.error && r.json.error.code, 'E_BUSY');
    assert.strictEqual(r.code, 0, r.text); // an empty queue: nothing to do, nothing spawned
  });
});
