'use strict';
// follow-up.test.cjs — a held review's should-fix findings as a follow-up task: made by fix_from_review with follow_up, carrying
// `follows_up` and neither `repairs` nor `answers`, so it is never a fix round and never answers a refutation; capped by the
// run's max_follow_ups per root work, cancelled ones counted; and it never gates the work it follows. Real core, sandbox
// stores and a throwaway repository (worktree-helpers.cjs), never this checkout.

const { test, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, write, commit, git, rejectsCode } = require('./worktree-helpers.cjs');

const { openCore } = core('index.cjs');
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };
const SHOULD = { severity: 'should-fix', title: 'gap', note: 'the retry has no test' };
const BLOCKING = { severity: 'blocking', note: 'would break the build' };
const NOTE = { severity: 'note', note: 'naming nit' };
const toClean = [];
after(async () => { for (const f of toClean.reverse()) await f(); });

// One run with its own store: `levers` are run.attach's (max_fix_rounds, max_follow_ups).
async function ctx(levers) {
  const dir = sandbox();
  const repo = makeRepo(dir);
  const orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid, project_dir: repo, fix_hard_cap: levers.max_fix_rounds, ...levers }); // the hard cap equals max_fix_rounds here, so the refusals these tests check still happen
  const workers = [];
  toClean.push(async () => { for (const c of workers) await c.close(); try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); } });
  let k = 0;
  const handBack = async (taskId, result, tree) => {
    const id = `w-${++k}`;
    await orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: `s-${id}`, last_event_at: Date.now(), worktree: tree || dir });
    const w = await openCore({ dataDir: `${dir}/data`, caller: callerFor('worker', { worker_id: id }), embed: false });
    workers.push(w);
    const a = await orch.task.assign({ task_id: taskId, worker_id: id });
    return w.lease.release({ lease_id: a.new_lease.id, reason: 'done', ...(result ? { result } : {}) });
  };
  // A task done: plain (judged in the sandbox), or in its own tree with a commit.
  const done = async (spec, { tree = false, depends_on, acceptance, files_owned } = {}) => {
    let t = await orch.task.create({ spec, acceptance: acceptance || (tree ? { files_within_owned: true } : PASS), ...(tree ? { files_owned: files_owned || [`src/${spec.replace(/\W/g, '')}.cjs`] } : {}), ...(depends_on ? { depends_on } : {}) });
    if (tree) {
      t = await orch.task.worktreeCreate({ task_id: t.id });
      write(t.worktree.path, t.files_owned[0], 'work\n');
      commit(t.worktree.path, `work ${t.id}`);
    }
    await handBack(t.id, { branch: 'b' }, tree ? t.worktree.path : null);
    const e = await orch.task.evaluate({ task_id: t.id, ...(tree ? {} : { worktree: dir }) });
    assert.strictEqual(e.state, 'done', JSON.stringify(e.results && e.results.checks));
    return t;
  };
  // A review of one or several tasks, decided: verdict 'holds' or 'refuted', or undecided with verdict null.
  const review = async (tasks, verdict, findings = []) => {
    const r = await orch.task.create({ spec: `review ${[].concat(tasks).map((t) => t.id).join(',')}`, depends_on: [].concat(tasks).map((t) => t.id), acceptance: { verdict: true } });
    if (verdict) {
      await handBack(r.id, { verdict, summary: `summary-${r.id}`, findings });
      await orch.task.evaluate({ task_id: r.id, worktree: dir });
    }
    return r;
  };
  const reviewOf = async (id) => (await orch.task.get({ task_id: id })).review;
  const count = async () => (await orch.task.list({})).tasks.length;
  return { dir, repo, orch, handBack, done, review, reviewOf, count };
}

test('a hold gives a follow-up in a tree of its own that is no fix round: no repairs, no answers, rounds unchanged', async () => {
  const c = await ctx({ max_fix_rounds: 2, max_follow_ups: 1 });
  const w = await c.done('add the retry', { tree: true });
  const r = await c.review(w, 'holds', [SHOULD, BLOCKING, NOTE, 'a bare string']);
  const f = await c.orch.task.fixFromReview({ review_id: r.id, follow_up: true });
  assert.deepStrictEqual(f.follows_up, { review_id: r.id, review_ids: [r.id], task_id: w.id, root: w.id });
  assert.deepStrictEqual([f.depends_on, f.repairs ?? null, f.answers ?? null, f.from_review, f.follow_ups_left], [[w.id], null, null, r.id, 0]);
  assert.deepStrictEqual([f.worktree.branch, f.worktree.base_sha, f.worktree.inherited_from ?? null], [`belay/${f.id}`, (await c.orch.task.get({ task_id: w.id })).results.head_sha, null], 'its own branch, cut from the judged head');
  assert.deepStrictEqual([f.files_owned, f.acceptance], [w.files_owned, w.acceptance]);
  assert.match(f.spec, /the retry has no test/);
  assert.match(f.spec, /can be integrated without this task/);
  assert.doesNotMatch(f.spec, /would break the build|naming nit|bare string/, 'only the should-fix findings are quoted');
  // The work: still done, still holds, its fix rounds untouched; the follow-up is listed beside them.
  assert.strictEqual((await c.orch.task.get({ task_id: w.id })).state, 'done');
  assert.deepStrictEqual(await c.reviewOf(w.id), { state: 'holds', review_id: r.id, rounds: 0, rounds_left: 2, fix_rounds_used: 0, max_fix_rounds: 2, fix_hard_cap: 2, fix_hard_cap_source: null, follow_ups: [{ id: f.id, state: 'open' }], follow_ups_left: 0 });
  assert.strictEqual(await c.reviewOf(f.id), null, 'the follow-up has no review of its own yet');
  // The compact listing keeps both.
  const row = require('../../src/mcp/views.cjs').taskList(await c.orch.task.list({})).tasks;
  assert.deepStrictEqual(row.find((t) => t.id === f.id).follows_up, f.follows_up);
  assert.deepStrictEqual(row.find((t) => t.id === w.id).review.follow_ups, [{ id: f.id, state: 'open' }]);
});

test('the work still integrates while the follow-up is open: its own branch is not merged, its dirty tree does not matter', async () => {
  const c = await ctx({ max_fix_rounds: 2, max_follow_ups: 1 });
  const w = await c.done('integrable work', { tree: true });
  const judged = (await c.orch.task.get({ task_id: w.id })).results.head_sha;
  const r = await c.review(w, 'holds', [SHOULD]);
  const f = await c.orch.task.fixFromReview({ review_id: r.id, follow_up: true });
  write(f.worktree.path, w.files_owned[0], 'follow-up work\n');
  commit(f.worktree.path, 'follow-up work');
  write(f.worktree.path, 'src/scratch.cjs', 'uncommitted\n'); // the follow-up's tree is dirty: it is not the work's tree
  const rowW = await c.orch.integration.merge({ task_ids: [w.id], into: 'int/work' });
  assert.deepStrictEqual([rowW.merged[0].sha, rowW.merged[0].left_out ?? null], [judged, null]);
  assert.strictEqual(git(rowW.worktree, 'show', `HEAD:${w.files_owned[0]}`), 'work', 'the follow-up\'s commit did not land with the work');
  const got = await c.orch.task.get({ task_id: w.id });
  assert.deepStrictEqual([got.state, got.review.state], ['done', 'holds']);
});

test('a done follow-up integrates on its own; the work\'s tree can be removed while another follow-up is live', async () => {
  const c = await ctx({ max_fix_rounds: 2, max_follow_ups: 1 });
  const w = await c.done('own tree work', { tree: true });
  const judged = (await c.orch.task.get({ task_id: w.id })).results.head_sha;
  const r = await c.review(w, 'holds', [SHOULD]);
  const f = await c.orch.task.fixFromReview({ review_id: r.id, follow_up: true });
  // Its own tree and branch, cut from the head the work was judged at, and not inherited.
  assert.deepStrictEqual([f.worktree.branch, f.worktree.base_sha, f.worktree.inherited_from ?? null], [`belay/${f.id}`, judged, null]);
  assert.notStrictEqual(f.worktree.path, w.worktree.path);
  write(f.worktree.path, w.files_owned[0], 'follow-up work\n');
  commit(f.worktree.path, 'follow-up work');
  await c.handBack(f.id, { branch: 'b' }, f.worktree.path);
  assert.strictEqual((await c.orch.task.evaluate({ task_id: f.id })).state, 'done');
  const rowF = await c.orch.integration.merge({ task_ids: [f.id], into: 'int/follow' });
  assert.strictEqual(git(rowF.worktree, 'show', `HEAD:${w.files_owned[0]}`), 'follow-up work');
  // The work's tree goes while its follow-up stays: a live follow-up holds only its own tree.
  const g = await c.done('second work', { tree: true });
  const gf = await c.orch.task.fixFromReview({ review_id: (await c.review(g, 'holds', [SHOULD])).id, follow_up: true });
  for (const wk of (await c.orch.worker.list({})).workers.filter((x) => x.worktree === g.worktree.path)) await c.orch.worker.write({ id: wk.id, state: 'stopped', exited_at: Date.now() }); // the coder that handed g back is idle in its tree
  await c.orch.task.worktreeRemove({ task_id: g.id });
  assert.ok(require('node:fs').existsSync(gf.worktree.path), 'the live follow-up kept its own tree');
});

test('the cap cannot be walked around through a fix of a follow-up: every descendant counts against the original work', async () => {
  const c = await ctx({ max_fix_rounds: 2, max_follow_ups: 2 });
  const w = await c.done('chain root');
  const fu1 = await c.orch.task.fixFromReview({ review_id: (await c.review(w, 'holds', [SHOULD])).id, follow_up: true });
  await c.handBack(fu1.id, { branch: 'b' });
  assert.strictEqual((await c.orch.task.evaluate({ task_id: fu1.id, worktree: c.dir })).state, 'done');
  const fix1 = await c.orch.task.fixFromReview({ review_id: (await c.review(fu1, 'refuted', [BLOCKING])).id });
  assert.strictEqual(fix1.repairs, fu1.id);
  await c.handBack(fix1.id, { branch: 'b' });
  assert.strictEqual((await c.orch.task.evaluate({ task_id: fix1.id, worktree: c.dir })).state, 'done');
  const fu2 = await c.orch.task.fixFromReview({ review_id: (await c.review(fix1, 'holds', [SHOULD])).id, follow_up: true });
  assert.deepStrictEqual([fu2.follows_up.root, fu2.follow_ups_left], [w.id, 0], 'the follow-up of a fix of a follow-up counts against the original work');
  await c.handBack(fu2.id, { branch: 'b' });
  assert.strictEqual((await c.orch.task.evaluate({ task_id: fu2.id, worktree: c.dir })).state, 'done');
  const e = await rejectsCode(c.orch.task.fixFromReview({ review_id: (await c.review(fu2, 'holds', [SHOULD])).id, follow_up: true }), 'E_FOLLOW_UPS');
  assert.deepStrictEqual([e.detail.root, e.detail.used], [w.id, 2]);
});

test('several held reviews of one work: the follow-up quotes every uncovered review, and a call for another of them returns it', async () => {
  const c = await ctx({ max_fix_rounds: 2, max_follow_ups: 1 });
  const w = await c.done('two reviewers');
  const r1 = await c.review(w, 'holds', [{ ...SHOULD, note: 'first reviewer gap' }]);
  const r2 = await c.review(w, 'holds', [{ ...SHOULD, note: 'second reviewer gap' }]);
  const f = await c.orch.task.fixFromReview({ review_id: r1.id, follow_up: true });
  assert.match(f.spec, /first reviewer gap/);
  assert.match(f.spec, /second reviewer gap/);
  assert.deepStrictEqual([f.follows_up.review_id, f.follows_up.review_ids.slice().sort()], [r1.id, [r1.id, r2.id].sort()]);
  const n = await c.count();
  const again = await c.orch.task.fixFromReview({ review_id: r2.id, follow_up: true });
  assert.deepStrictEqual([again.id, again.existing, await c.count()], [f.id, true, n], 'not E_FOLLOW_UPS: the second review\'s findings are already in it');
});

test('a follow-up does not spend a fix round: with max_fix_rounds used up one is still made, and a refutation still hits E_FIX_ROUNDS', async () => {
  const c = await ctx({ max_fix_rounds: 2, max_follow_ups: 1 });
  const w = await c.done('rounds work');
  let judged = w;
  for (let n = 1; n <= 2; n++) {
    const r = await c.review(judged, 'refuted', [BLOCKING]);
    const fix = await c.orch.task.fixFromReview({ review_id: r.id });
    await c.handBack(fix.id, { branch: 'b' });
    assert.strictEqual((await c.orch.task.evaluate({ task_id: fix.id, worktree: c.dir })).state, 'done');
    judged = fix;
  }
  const r3 = await c.review(judged, 'holds', [SHOULD]);
  assert.deepStrictEqual(await c.reviewOf(w.id), { state: 'holds', review_id: r3.id, rounds: 2, rounds_left: 0, fix_rounds_used: 2, max_fix_rounds: 2, fix_hard_cap: 2, fix_hard_cap_source: null });
  const f = await c.orch.task.fixFromReview({ review_id: r3.id, follow_up: true });
  assert.deepStrictEqual(f.follows_up, { review_id: r3.id, review_ids: [r3.id], task_id: judged.id, root: w.id });
  const after = await c.reviewOf(w.id);
  assert.deepStrictEqual([after.rounds, after.rounds_left, after.follow_ups_left], [2, 0, 0]);
  // A later refutation of the follow-up's own work is a fix of the follow-up, counted for the follow-up and not the original.
  await c.handBack(f.id, { branch: 'b' });
  assert.strictEqual((await c.orch.task.evaluate({ task_id: f.id, worktree: c.dir })).state, 'done');
  const r4 = await c.review(f, 'refuted', [BLOCKING]);
  const fixOfFollow = await c.orch.task.fixFromReview({ review_id: r4.id });
  assert.strictEqual(fixOfFollow.repairs, f.id);
  // A refutation of the original work is not answered by a follow-up, even one that is done and reviewed to hold.
  const w2 = await c.done('refuted later');
  const r5 = await c.review(w2, 'holds', [SHOULD]);
  const f2 = await c.orch.task.fixFromReview({ review_id: r5.id, follow_up: true });
  await c.handBack(f2.id, { branch: 'b' });
  await c.orch.task.evaluate({ task_id: f2.id, worktree: c.dir });
  await c.review(f2, 'holds', []);
  const r6 = await c.review(w2, 'refuted', [BLOCKING]);
  assert.deepStrictEqual([(await c.reviewOf(w2.id)).state, (await c.reviewOf(w2.id)).review_id], ['refuted', r6.id], 'the follow-up answers nothing');
  const fix6 = await c.orch.task.fixFromReview({ review_id: r6.id });
  assert.deepStrictEqual([fix6.repairs, fix6.answers], [w2.id, [r6.id]]);
});

test('refusals write nothing: a refuted review, a pending one, a panel with an open refutation, a review that is not one', async () => {
  const c = await ctx({ max_fix_rounds: 2, max_follow_ups: 3 });
  const w = await c.done('refusal work');
  const pending = await c.review(w, null);
  const before = await c.count();
  let e = await rejectsCode(c.orch.task.fixFromReview({ review_id: pending.id, follow_up: true }), 'E_PRECONDITION');
  assert.match(e.message, /pending/);
  const refuted = await c.review(w, 'refuted', [SHOULD]);
  e = await rejectsCode(c.orch.task.fixFromReview({ review_id: refuted.id, follow_up: true }), 'E_PRECONDITION');
  assert.match(e.message, /without follow_up/);
  // A panel: the first reviewer's hold is outranked by the second's open refutation (decided later).
  const w2 = await c.done('panel work');
  const holds = await c.review(w2, 'holds', [SHOULD]);
  const refutes = await c.review(w2, 'refuted', [BLOCKING]);
  e = await rejectsCode(c.orch.task.fixFromReview({ review_id: holds.id, follow_up: true }), 'E_PRECONDITION');
  assert.strictEqual(e.detail.deciding_review, refutes.id);
  await rejectsCode(c.orch.task.fixFromReview({ review_id: w.id, follow_up: true }), 'E_ARGS');
  await rejectsCode(c.orch.task.fixFromReview({ review_id: 'nope', follow_up: true }), 'E_NOT_FOUND');
  await rejectsCode(c.orch.task.fixFromReview({ review_id: holds.id, follow_up: 'yes' }), 'E_ARGS');
  const rows = (await c.orch.task.list({})).tasks;
  assert.strictEqual(rows.filter((t) => t.follows_up).length, 0, 'no refusal wrote a row');
  assert.strictEqual(rows.length, before + 4, 'only the rows the test itself made (w2, two reviews, ...)');
});

test('no should-fix finding and no spec is refused; a spec given always wins', async () => {
  const c = await ctx({ max_fix_rounds: 2, max_follow_ups: 3 });
  const w = await c.done('spec work');
  const r = await c.review(w, 'holds', [BLOCKING, NOTE]);
  const e = await rejectsCode(c.orch.task.fixFromReview({ review_id: r.id, follow_up: true }), 'E_ARGS');
  assert.match(e.message, /pass spec/);
  const f = await c.orch.task.fixFromReview({ review_id: r.id, follow_up: true, spec: 'add the missing test for the retry' });
  assert.strictEqual(f.spec, 'add the missing test for the retry');
  const w2 = await c.done('spec work two');
  const r2 = await c.review(w2, 'holds', [SHOULD]);
  const g = await c.orch.task.fixFromReview({ review_id: r2.id, follow_up: true, spec: 'my own words' });
  assert.strictEqual(g.spec, 'my own words');
});

test('a review of several tasks needs repairs to name the one; the follow-up attaches to that task only', async () => {
  const c = await ctx({ max_fix_rounds: 2, max_follow_ups: 3 });
  const a = await c.done('multi a'), b = await c.done('multi b');
  const r = await c.review([a, b], 'holds', [SHOULD]);
  const e = await rejectsCode(c.orch.task.fixFromReview({ review_id: r.id, follow_up: true }), 'E_ARGS');
  assert.deepStrictEqual(e.detail.depends_on, [a.id, b.id]);
  await rejectsCode(c.orch.task.fixFromReview({ review_id: r.id, follow_up: true, repairs: 'elsewhere' }), 'E_ARGS');
  const f = await c.orch.task.fixFromReview({ review_id: r.id, follow_up: true, repairs: b.id });
  assert.deepStrictEqual([f.follows_up.task_id, f.depends_on, f.repairs ?? null], [b.id, [b.id], null]);
  assert.strictEqual((await c.reviewOf(a.id)).follow_ups, undefined, 'the other task has none');
  assert.deepStrictEqual((await c.reviewOf(b.id)).follow_ups.map((x) => x.id), [f.id]);
  // The same review for the other task is its own follow-up, not the first one returned.
  const g = await c.orch.task.fixFromReview({ review_id: r.id, follow_up: true, repairs: a.id });
  assert.notStrictEqual(g.id, f.id);
});

test('a repeat call returns the open follow-up with existing: true and writes nothing', async () => {
  const c = await ctx({ max_fix_rounds: 2, max_follow_ups: 1 });
  const w = await c.done('repeat work');
  const r = await c.review(w, 'holds', [SHOULD]);
  const f = await c.orch.task.fixFromReview({ review_id: r.id, follow_up: true });
  const n = await c.count();
  const again = await c.orch.task.fixFromReview({ review_id: r.id, follow_up: true });
  assert.deepStrictEqual([again.id, again.existing, again.follow_ups_left, await c.count()], [f.id, true, 0, n]);
});

test('E_FOLLOW_UPS at the cap: a cancelled follow-up counts, and a follow-up of a follow-up counts against the same root', async () => {
  const c = await ctx({ max_fix_rounds: 2, max_follow_ups: 1 });
  const w = await c.done('cap work');
  const r = await c.review(w, 'holds', [SHOULD]);
  const f = await c.orch.task.fixFromReview({ review_id: r.id, follow_up: true });
  await c.orch.task.cancel({ task_id: f.id });
  const n = await c.count();
  const e = await rejectsCode(c.orch.task.fixFromReview({ review_id: r.id, follow_up: true }), 'E_FOLLOW_UPS');
  assert.deepStrictEqual([e.detail.root, e.detail.used, e.detail.max_follow_ups, await c.count()], [w.id, 1, 1, n]);
  assert.deepStrictEqual((await c.reviewOf(w.id)).follow_ups_left, 0);

  const d = await ctx({ max_fix_rounds: 2, max_follow_ups: 2 });
  const w2 = await d.done('chain work');
  const f1 = await d.orch.task.fixFromReview({ review_id: (await d.review(w2, 'holds', [SHOULD])).id, follow_up: true });
  assert.strictEqual(f1.follow_ups_left, 1);
  await d.handBack(f1.id, { branch: 'b' });
  assert.strictEqual((await d.orch.task.evaluate({ task_id: f1.id, worktree: d.dir })).state, 'done');
  const f2 = await d.orch.task.fixFromReview({ review_id: (await d.review(f1, 'holds', [SHOULD])).id, follow_up: true });
  assert.deepStrictEqual([f2.follows_up.root, f2.follows_up.task_id, f2.follow_ups_left], [w2.id, f1.id, 0]);
  await d.handBack(f2.id, { branch: 'b' });
  await d.orch.task.evaluate({ task_id: f2.id, worktree: d.dir });
  await rejectsCode(d.orch.task.fixFromReview({ review_id: (await d.review(f2, 'holds', [SHOULD])).id, follow_up: true }), 'E_FOLLOW_UPS');
  // A different work in the same run has its own count.
  const w3 = await d.done('other work');
  await d.orch.task.fixFromReview({ review_id: (await d.review(w3, 'holds', [SHOULD])).id, follow_up: true });
});

test('max_follow_ups 0 refuses every follow-up', async () => {
  const c = await ctx({ max_fix_rounds: 2, max_follow_ups: 0 });
  const w = await c.done('off work');
  const r = await c.review(w, 'holds', [SHOULD]);
  await rejectsCode(c.orch.task.fixFromReview({ review_id: r.id, follow_up: true }), 'E_FOLLOW_UPS');
});

test('follows_up cannot be passed to task.create, alone, with a tree, or as a batch item', async () => {
  const c = await ctx({ max_fix_rounds: 2, max_follow_ups: 1 });
  const fu = { review_id: 'r', task_id: 't', root: 't' };
  const n = await c.count();
  let e = await rejectsCode(c.orch.task.create({ spec: 'sneaky', follows_up: fu }), 'E_ARGS');
  assert.match(e.message, /fix_from_review/);
  await rejectsCode(c.orch.task.create({ spec: 'sneaky', follows_up: fu, worktree: true }), 'E_ARGS');
  await rejectsCode(c.orch.task.create({ tasks: [{ spec: 'sneaky', follows_up: fu }] }), 'E_ARGS');
  assert.strictEqual(await c.count(), n);
});

test('the run lever: parsed with a default of 1, 0 allowed, bad values refused, and recorded on the run row', async () => {
  const { parseLevers } = require('../../src/cli/run-levers.cjs');
  assert.strictEqual(parseLevers({}).max_follow_ups, 1);
  assert.strictEqual(parseLevers({ max_follow_ups: 0 }).max_follow_ups, 0);
  for (const bad of [-1, 1.5, '2', null]) assert.match(parseLevers({ max_follow_ups: bad }).error, /max_follow_ups/);
  const c = await ctx({ max_follow_ups: 3 });
  assert.strictEqual((await c.orch.run.attach({ adapter_pid: process.pid, max_follow_ups: 3 })).run.max_follow_ups, 3);
  await rejectsCode(c.orch.run.attach({ adapter_pid: process.pid, max_follow_ups: -1 }), 'E_ARGS');
});

test('work judged with uncommitted changes: the follow-up is refused until the judged state is committed, then it starts from that commit', async () => {
  const c = await ctx({ max_fix_rounds: 2, max_follow_ups: 1 });
  let w = await c.orch.task.create({ spec: 'dirty work', acceptance: { files_within_owned: true }, files_owned: ['src/dirty.cjs'] });
  w = await c.orch.task.worktreeCreate({ task_id: w.id });
  write(w.worktree.path, 'src/dirty.cjs', 'judged\n'); // judged uncommitted
  await c.handBack(w.id, { branch: 'b' }, w.worktree.path);
  assert.strictEqual((await c.orch.task.evaluate({ task_id: w.id })).state, 'done');
  const r = await c.review(w, 'holds', [SHOULD]);
  const n = await c.count();
  const e = await rejectsCode(c.orch.task.fixFromReview({ review_id: r.id, follow_up: true }), 'E_PRECONDITION');
  assert.match(e.message, /commit exactly the judged state/);
  assert.strictEqual(await c.count(), n, 'nothing was written');
  commit(w.worktree.path, 'the judged state');
  const sha = git(w.worktree.path, 'rev-parse', 'HEAD');
  const f = await c.orch.task.fixFromReview({ review_id: r.id, follow_up: true });
  assert.strictEqual(f.worktree.base_sha, sha);
  assert.strictEqual(git(f.worktree.path, 'show', 'HEAD:src/dirty.cjs'), 'judged');
});
