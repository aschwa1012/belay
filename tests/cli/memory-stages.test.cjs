'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// memory-stages.test.cjs — `belay memory scrub|review|resolve`. The commands run in this process with a fake run manager (so no
// session is started) against a sandbox store planted by the lifecycle scaffolding; usage errors and the real-manager path (the fake
// executable, whose echo is not a hand-back) run as the built CLI in a subprocess.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { setup } = require('../core/lifecycle-env.cjs');
const { cleanup } = require('../core/helpers.cjs');
const { DEFAULTS } = require('../../src/core/memory-levers.cjs');
const R = require('../../src/cli/memory-render.cjs');
const { run } = require('../../src/cli/cmd-memory.cjs');
const { ROOT, CLI } = require('./stop-helpers.cjs');

const FAKE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const cmd = async (T, argv, stageDeps) => {
  const r = await run({ argv, cwd: T.dir, dataDir: T.dir, dataDirGiven: true, stageDeps });
  return { ...r, json: r.json };
};
// Plants the store, then releases it so the command is the only process with it open.
async function planted(fn) {
  const T = await setup();
  try { return await fn(T); } finally { try { T.store.close(); } catch { /* closed by the test */ } cleanup(T.dir); }
}
function fakeManager(answer, { cost = 0.01 } = {}) {
  const m = { spawned: [], stopped: [] };
  m.spawn = async (a) => { m.spawned.push(a); m.rec = { lastAssistantText: answer, costUsd: cost }; return {}; };
  m.wait = async () => ({ event: 'turn_end', is_error: false, timed_out: false });
  m.stop = async ({ worker_id }) => { m.stopped.push(worker_id); };
  m._worker = () => m.rec;
  return m;
}
const pending = (T, title, over = {}) => T.note(title, { ns: 'project/lc'.replace('project', 'pending'), state: 'pending', run_id: 'lc-apply', ...over });
const nsOf = (T, id) => T.row(id).namespace;

test('usage: the three verbs check their shape before any store is opened', () => {
  for (const [argv, re] of [
    [['resolve', 'n1'], /takes 2 to 3 positional/],
    [['resolve', 'n1', 'maybe'], /takes new, repeats <of> or supersedes <of>/],
    [['resolve', 'n1', 'new', 'n2'], /new takes no other note id/],
    [['resolve', 'n1', 'repeats'], /needs the id of the live note/],
    [['resolve', 'n1', 'supersedes', 'n2'], /needs --evidence/],
    [['resolve', 'n1', 'repeats', 'n2', '--evidence', 'x'], /takes no --evidence/],
    [['scrub', 'extra'], /takes 0 positional/],
    [['scrub', '--all'], /unknown option --all for belay memory scrub/],
    [['review', '--summary', 'x'], /unknown option --summary for belay memory review/],
  ]) assert.match(R.parseArgs(argv).error, re, argv.join(' '));
  assert.deepStrictEqual(R.parseArgs(['review', '--all', '--run', 'r1']).opts, { all: true, run: 'r1' });
  assert.match(R.usageText(), /belay memory scrub \[--run <id>\]/);
  const r = spawnSync(process.execPath, [CLI, 'memory', 'resolve', 'n1', 'supersedes', 'n2', '--data', ROOT], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
});

test('resolve: the operator settles a pending note; a repeat archives the pending row and deletes nothing', async () => {
  await planted(async (T) => {
    const live = T.note('the live note');
    const sameWriter = T.note('a different writer\'s live note', { written_by: 'worker:w9' });
    const a = pending(T, 'pending repeats', { written_by: 'worker:w3', matches: [{ id: live, similarity: 0.91 }] });
    const b = pending(T, 'pending new', { written_by: 'worker:w3' });
    const c = pending(T, 'pending supersedes', { written_by: 'worker:w3', matches: [{ id: sameWriter, similarity: 0.9 }] });
    const d = pending(T, 'pending with a stranger', { written_by: 'worker:w3', matches: [{ id: live, similarity: 0.9 }] });
    const rows = T.store.p('SELECT COUNT(*) AS n FROM memory_entries').get().n;
    T.store.close();
    const rep = await cmd(T, ['resolve', a, 'repeats', live]);
    assert.strictEqual(rep.code, 0, rep.text);
    assert.deepStrictEqual([rep.json.resolved[0].resolved, rep.json.resolved[0].pending_row_archived], ['repeats', true]);
    assert.match(rep.text, /pending row is archived in archive\/lc \(nothing deleted\)/);
    const nw = await cmd(T, ['resolve', b, 'new']);
    assert.strictEqual(nw.code, 0, nw.text);
    const sup = await cmd(T, ['resolve', c, 'supersedes', sameWriter, '--evidence', 'the code at head no longer does this']);
    assert.strictEqual(sup.code, 0, sup.text);
    const refused = await cmd(T, ['resolve', d, 'repeats', sameWriter]);
    assert.strictEqual(refused.code, 1, 'an id that is not one of the stored matches is refused');
    assert.match(refused.text, /not one of the matches/);
    const again = await cmd(T, ['resolve', a, 'new']);
    assert.strictEqual(again.code, 1, 'a settled note is no longer pending');
    const { Store } = require('../../src/core/store.cjs');
    const s = new Store(`${T.dir}/memory.db`, { stamp: true });
    try {
      assert.strictEqual(s.p('SELECT COUNT(*) AS n FROM memory_entries').get().n, rows, 'no row was deleted by any resolve');
      const ns = (id) => s.p('SELECT namespace FROM memory_entries WHERE id = ?').get(id).namespace;
      assert.deepStrictEqual([ns(a), ns(b), ns(c), ns(d)], ['archive/lc', 'project/lc', 'project/lc', 'pending/lc']);
      assert.strictEqual(JSON.parse(s.p('SELECT body FROM memory_entries WHERE id = ?').get(live).body).seen_total, 1);
    } finally { s.close(); }
  });
});

test('scrub by hand: the scope goes to the child, the hand-back is applied through the core, a second scrub finds nothing', async () => {
  await planted(async (T) => {
    const p = pending(T, 'pending to settle');
    T.store.close();
    const m = fakeManager(JSON.stringify({ scrub: [{ id: p, action: 'resolve', resolve: 'new', reason: 'a different lesson from any live note' }] }));
    const r = await cmd(T, ['scrub', '--run', 'lc-apply', '--goal', 'the goal', '--summary', 'the summary'], { makeManager: async () => m });
    assert.strictEqual(r.code, 0, r.text);
    assert.deepStrictEqual([r.json.ran, r.json.mode, r.json.result.counts.applied, m.spawned.length], [true, 'apply', 1, 1]);
    assert.match(r.text, /^scrub: ran as scrub-lc-apply-/);
    const brief = fs.readFileSync(/(\S+brief\.md)/.exec(m.spawned[0].prompt)[1], 'utf8');
    assert.ok(brief.includes('the goal') && brief.includes('the summary') && brief.includes(p));
    assert.deepStrictEqual(m.stopped, [m.spawned[0].worker_id]);
    const again = await cmd(T, ['scrub', '--run', 'lc-apply'], { makeManager: async () => assert.fail('nothing is in scope, so no child') });
    assert.deepStrictEqual([again.code, again.json.ran, again.json.reason], [0, false, 'empty scope']);
    assert.match(again.text, /nothing to do \(empty scope\)/);
  });
});

test('scrub by hand: a failed child is exit 1 with the items owed, and the next scrub offers them first', async () => {
  await planted(async (T) => {
    const p = pending(T, 'pending the child fails on');
    T.store.close();
    const bad = await cmd(T, ['scrub', '--run', 'lc-apply'], { makeManager: async () => fakeManager('not a hand-back at all') });
    assert.strictEqual(bad.code, 1);
    assert.match(bad.text, /failed: E_ARGS.*1 item\(s\) owed/);
    assert.deepStrictEqual(bad.json.owed, [p]);
    const m = fakeManager(JSON.stringify({ scrub: [] }));
    const next = await cmd(T, ['scrub', '--run', 'lc-apply'], { makeManager: async () => m });
    assert.strictEqual(next.code, 0);
    assert.ok(fs.readFileSync(/(\S+brief\.md)/.exec(m.spawned[0].prompt)[1], 'utf8').includes(p));
  });
});

test('review --all: runs on a queue below every trigger, applies the verdicts through the core, and refuses a run with notes off', async () => {
  await planted(async (T) => {
    const n = T.note('held by the scrubber', { reported_wrong: [T.report()] });
    await T.call(T.who.harness('apply'), 'memory.scrubApply', { scrub: [{ id: n, action: 'hold', kind: 'wrong', ground: 'report_confirmed', reason: 'the loader throws', cites: [T.cite] }], scope: [n], ...T.evidence });
    T.store.close();
    const m = fakeManager(JSON.stringify({ verdicts: [{ id: n, verdict: 'release', reason: 'the code supports the note' }] }));
    const r = await cmd(T, ['review', '--all', '--run', 'lc-apply', '--worktree', T.repo], { makeManager: async () => m });
    assert.strictEqual(r.code, 0, r.text);
    assert.deepStrictEqual([r.json.ran, r.json.trigger, r.json.result.counts.applied, m.spawned[0].model], [true, 'asked by hand', 1, 'claude-opus-5-5']);
    const empty = await cmd(T, ['review', '--run', 'lc-apply'], { makeManager: async () => assert.fail('an empty queue spawns nothing') });
    assert.deepStrictEqual([empty.code, empty.json.reason], [0, 'empty queue']);
    const plain = await cmd(T, ['review', '--run', 'lc-plain']);
    assert.strictEqual(plain.code, 1);
    assert.match(plain.text, /memory\.notes off/);
    const none = await cmd(T, ['scrub', '--run', 'no-such-run']);
    assert.strictEqual(none.code, 1);
  });
});

test('the built CLI with the fake executable: the real manager spawns the child, the echo is not a hand-back, the items are owed and nothing is left running', async () => {
  await planted(async (T) => {
    const p = pending(T, 'pending for the real manager');
    T.store.close();
    const env = { ...process.env, BELAY_TEST_MODE: '1', BELAY_CLAUDE_EXE: FAKE, BELAY_TEST_SKIP_EMBEDDER_WARMUP: '1' };
    const r = spawnSync(process.execPath, [CLI, 'memory', 'scrub', '--run', 'lc-apply', '--worktree', T.repo, '--data', T.dir, '--json'], { cwd: ROOT, windowsHide: true, encoding: 'utf8', env, timeout: 120000 });
    const out = r.stdout || r.stderr;
    const j = JSON.parse(out);
    assert.strictEqual(r.status, 1, r.stderr + r.stdout);
    assert.strictEqual(j.ran, true);
    assert.ok(j.error && ['E_ARGS', 'E_COST_CAP'].includes(j.error.code), JSON.stringify(j.error));
    assert.deepStrictEqual(j.owed, [p]);
    assert.ok(!fs.existsSync(`${T.dir}/owner.lock`), 'no owner outlives the command');
    const { Store } = require('../../src/core/store.cjs');
    const s = new Store(`${T.dir}/memory.db`, { stamp: true });
    try {
      const w = s.p("SELECT id, state, pid FROM worker WHERE id LIKE 'scrub-%' ORDER BY seq DESC").all();
      assert.ok(w.length && w.every((x) => x.id.startsWith('scrub-lc-apply-')), 'the child was a worker the harness spawned');
      assert.ok(['stopped', 'dead'].includes(w[0].state), `the child's last row is ${w[0].state}`);
      assert.ok(s.p("SELECT COUNT(*) AS n FROM memory_event WHERE kind = 'scrub_owed' AND code = 'E_ARGS'").get().n >= 1, 'the failure owes the item with its cause');
    } finally { s.close(); }
  });
});

test('DEFAULTS: the stage levers are present with the agreed values', () => {
  assert.deepStrictEqual([DEFAULTS.scrub_wall_s, DEFAULTS.scrub_cost_cap_usd, DEFAULTS.review_min_held, DEFAULTS.review_max_age_runs, DEFAULTS.review_wall_s, DEFAULTS.review_cost_cap_usd, DEFAULTS.scrub_model, DEFAULTS.archive_review_model],
    [300, 0.1, 3, 3, 600, 2, 'claude-haiku-5-5', 'claude-opus-5-5']);
});

test('without --run the newest ENDED run with notes on is used; a live run is refused unless named', async () => {
  await planted(async (T) => {
    const p = pending(T, 'pending in the live run');
    T.store.close();
    const never = () => assert.fail('no child');
    // every sandbox run is live (this process is its adapter): no default exists
    const live = await cmd(T, ['scrub'], { makeManager: async () => never() });
    assert.strictEqual(live.code, 1);
    assert.match(live.text, /only run with notes on is live/);
    assert.ok(live.json.error.live_run);
    const { Store } = require('../../src/core/store.cjs');
    const { Engine } = require('../../src/core/engine.cjs');
    const { callerFor } = require('../core/helpers.cjs');
    const s2 = new Store(`${T.dir}/memory.db`, { stamp: true });
    const E = new Engine({ dataDir: T.dir, store: s2, getEmbedder: null, owner: null, establishedBy: 'test' });
    await E.handle('run.end', { caller: callerFor('operator', { run_id: 'lc-apply' }), exit_reason: 'done' });
    s2.close();
    const m = fakeManager(JSON.stringify({ scrub: [] }));
    const ended = await cmd(T, ['scrub'], { makeManager: async () => m });
    assert.strictEqual(ended.json.run_id, 'lc-apply', 'the ended run is the default');
    assert.strictEqual(ended.code, 0, ended.text);
  });
});
