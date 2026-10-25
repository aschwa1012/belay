'use strict';
// fix-from-review-rounds.test.cjs — task.fixFromReview over several rounds: each fix's default spec is the original work's spec
// and only the latest review's findings, never an earlier round's spec or findings; and a fix is worked in the tree of the work
// it fixes, so the coder idle in that tree can take it, and the tree is removed for every task that shares it. Real core, a
// sandbox store and a throwaway repository (worktree-helpers.cjs), never this checkout.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, write, commit, rejectsCode } = require('./worktree-helpers.cjs');

const { openCore } = core('index.cjs');

let dir, repo, orch;
const workers = new Map();
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };

before(async () => {
  dir = sandbox();
  repo = makeRepo(dir);
  orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid, project_dir: repo, max_fix_rounds: 3 });
});

after(async () => {
  for (const c of workers.values()) await c.close();
  try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
});

async function worker(id, worktree) {
  if (workers.has(id)) return workers.get(id);
  await orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: `s-${id}`, last_event_at: Date.now(), worktree });
  const c = await openCore({ dataDir: `${dir}/data`, caller: callerFor('worker', { worker_id: id }), embed: false });
  workers.set(id, c);
  return c;
}

async function handBack(taskId, workerId, worktree, result) {
  const w = await worker(workerId, worktree);
  const a = await orch.task.assign({ task_id: taskId, worker_id: workerId });
  return w.lease.release({ lease_id: a.new_lease.id, reason: 'done', ...(result ? { result } : {}) });
}

// One coder hands back round n; the task is judged; a review over it is refuted with a summary and a finding that name the
// round. A task with a tree is worked there (the coder idle in it, a commit per round) and judged there with no worktree argument.
async function round(task, n) {
  const tree = task.worktree ? task.worktree.path : null;
  if (tree) {
    write(tree, 'src/retry.cjs', `round ${n}\n`);
    commit(tree, `round ${n}`);
  }
  await handBack(task.id, tree ? 'coder' : 'plain-coder', tree || dir, { branch: 'b', head: 'h' });
  const judged = await orch.task.evaluate({ task_id: task.id, ...(tree ? {} : { worktree: dir }) });
  assert.strictEqual(judged.state, 'done', `round ${n}: ${JSON.stringify(judged.results && judged.results.checks)}`);
  const r = await orch.task.create({ spec: `review round ${n}`, depends_on: [task.id], acceptance: { verdict: true } });
  await handBack(r.id, `judge-${n}-${task.id}`, dir, { verdict: 'refuted', summary: `summary-of-round-${n}`, findings: [{ severity: 'blocking', clause: 'a', note: `finding-of-round-${n}` }] });
  assert.strictEqual((await orch.task.evaluate({ task_id: r.id, worktree: dir })).results.checks.at(-1).passed, false);
  return r;
}

const count = (s, needle) => s.split(needle).length - 1;

// Each fix's spec names the original work once and only its own review's findings, and does not grow with the rounds.
function assertSpec(f, n, SPEC, fixes) {
  assert.strictEqual(count(f.spec, SPEC), 1, `round ${n}: the original spec once: ${f.spec}`);
  assert.match(f.spec, new RegExp(`summary-of-round-${n}`));
  assert.match(f.spec, new RegExp(`finding-of-round-${n}`));
  for (let m = 1; m < n; m++) {
    assert.doesNotMatch(f.spec, new RegExp(`(summary|finding)-of-round-${m}`), `round ${n} carries round ${m}'s findings`);
    assert.ok(!f.spec.includes(fixes[m - 1].spec), `round ${n} quotes round ${m}'s spec`);
  }
  if (n > 1) assert.ok(f.spec.length <= fixes[0].spec.length + 60, `round ${n}'s spec does not grow: ${f.spec.length} vs ${fixes[0].spec.length}`);
}

test('three fix rounds: each spec is the original spec plus only the latest review\'s findings', async () => {
  const SPEC = 'make the cache expire';
  const w = await orch.task.create({ spec: SPEC, acceptance: PASS });
  let judged = w;
  const fixes = [];
  for (let n = 1; n <= 3; n++) {
    const f = await orch.task.fixFromReview({ review_id: (await round(judged, n)).id });
    assert.deepStrictEqual([f.depends_on, f.repairs], [[judged.id], w.id], `round ${n}`);
    assertSpec(f, n, SPEC, fixes);
    fixes.push(f);
    judged = f;
  }
});

test('three fix rounds in a tree: each fix is worked in the work\'s tree, on its branch, by the same coder', async () => {
  const SPEC = 'add the retry to src/retry.cjs';
  let w = await orch.task.create({ spec: SPEC, acceptance: { files_within_owned: true }, files_owned: ['src/retry.cjs'] });
  w = await orch.task.worktreeCreate({ task_id: w.id });
  const tree = w.worktree;
  let judged = w;
  const fixes = [];
  for (let n = 1; n <= 3; n++) {
    const f = await orch.task.fixFromReview({ review_id: (await round(judged, n)).id });
    assertSpec(f, n, SPEC, fixes);
    // The work's own path, branch and base: the coder idle in it takes the fix, and the files check judges the whole branch.
    assert.deepStrictEqual([f.worktree.path, f.worktree.branch, f.worktree.base_sha, f.worktree.inherited_from], [tree.path, tree.branch, tree.base_sha, w.id]);
    fixes.push(f);
    judged = f;
  }
  // The last fix, too, is taken by the same coder and judged in the shared tree; a fourth fix is past max_fix_rounds 3.
  await rejectsCode(orch.task.fixFromReview({ review_id: (await round(judged, 4)).id }), 'E_FIX_ROUNDS');
});

test('a fix of work with no tree has no tree', async () => {
  const plain = await orch.task.create({ spec: 'plain work', acceptance: PASS });
  await handBack(plain.id, 'c-plain', dir);
  await orch.task.evaluate({ task_id: plain.id, worktree: dir });
  const r = await orch.task.create({ spec: 'review plain', depends_on: [plain.id], acceptance: { verdict: true } });
  await handBack(r.id, 'j-plain', dir, { verdict: 'refuted', summary: 's', findings: [] });
  await orch.task.evaluate({ task_id: r.id, worktree: dir });
  assert.strictEqual((await orch.task.fixFromReview({ review_id: r.id })).worktree ?? null, null);
});

test('removing a shared tree: refused while the fix is unfinished, then recorded removed on both tasks', async () => {
  let w = await orch.task.create({ spec: 'shared work', acceptance: { files_within_owned: true }, files_owned: ['src/shared.cjs'] });
  w = await orch.task.worktreeCreate({ task_id: w.id });
  write(w.worktree.path, 'src/shared.cjs', 'x\n');
  commit(w.worktree.path, 'shared');
  await handBack(w.id, 'c-shared', w.worktree.path, { branch: w.worktree.branch });
  assert.strictEqual((await orch.task.evaluate({ task_id: w.id })).state, 'done');
  const r = await orch.task.create({ spec: 'review shared', depends_on: [w.id], acceptance: { verdict: true } });
  await handBack(r.id, 'j-shared', dir, { verdict: 'refuted', summary: 's', findings: [] });
  await orch.task.evaluate({ task_id: r.id, worktree: dir });
  const f = await orch.task.fixFromReview({ review_id: r.id });
  await orch.worker.write({ id: 'c-shared', substrate: 'claude-code', pid: process.pid, state: 'stopped', session_id: 's-c-shared', last_event_at: Date.now(), worktree: w.worktree.path });
  const e = await rejectsCode(orch.task.worktreeRemove({ task_id: w.id }), 'E_PRECONDITION');
  assert.ok(e.message.includes(`task ${f.id} (open)`), e.message);
  assert.ok(fs.existsSync(w.worktree.path), 'nothing was removed');
  await orch.task.cancel({ task_id: f.id });
  const out = await orch.task.worktreeRemove({ task_id: w.id });
  assert.ok(out.worktree.removed_at);
  const fNow = await orch.task.get({ task_id: f.id });
  assert.ok(fNow.worktree.removed_at, 'the fix that shared the tree records it removed');
  assert.strictEqual(fNow.worktree.inherited_from, w.id);
});

// Work done in its own tree and refuted, with its fix created (open) on the same branch.
async function workWithOpenFix(name) {
  let w = await orch.task.create({ spec: `${name} work`, acceptance: { files_within_owned: true }, files_owned: [`src/${name}.cjs`] });
  w = await orch.task.worktreeCreate({ task_id: w.id });
  write(w.worktree.path, `src/${name}.cjs`, 'work\n');
  commit(w.worktree.path, `${name} work`);
  await handBack(w.id, `c-${name}`, w.worktree.path, { branch: w.worktree.branch });
  assert.strictEqual((await orch.task.evaluate({ task_id: w.id })).state, 'done');
  const r = await orch.task.create({ spec: `review ${name}`, depends_on: [w.id], acceptance: { verdict: true } });
  await handBack(r.id, `j-${name}`, dir, { verdict: 'refuted', summary: 's', findings: [] });
  await orch.task.evaluate({ task_id: r.id, worktree: dir });
  return { w, f: await orch.task.fixFromReview({ review_id: r.id }) };
}

test('integrate refuses the done work while its fix, on the same branch, is open; once the fix is done both merge', async () => {
  const { w, f } = await workWithOpenFix('land');
  const e = await rejectsCode(orch.integration.merge({ task_ids: [w.id], into: 'int/land' }), 'E_PRECONDITION');
  assert.ok(e.message.includes(`task ${f.id} (open)`), e.message);
  assert.deepStrictEqual([e.detail.task_id, e.detail.open_task_id], [w.id, f.id]);
  assert.strictEqual((await orch.integration.list({})).integrations.filter((i) => i.into_branch === 'int/land').length, 0, 'nothing was written');
  // The fix commits on the shared branch and is judged done; now the work and the fix merge, the fix as already merged.
  write(w.worktree.path, 'src/land.cjs', 'fixed\n');
  commit(w.worktree.path, 'land fix');
  await handBack(f.id, 'c-land', w.worktree.path, { branch: w.worktree.branch });
  assert.strictEqual((await orch.task.evaluate({ task_id: f.id })).state, 'done');
  const row = await orch.integration.merge({ task_ids: [w.id, f.id], into: 'int/land' });
  assert.ok(['merged', 'evaluated'].includes(row.state), row.state);
});

test('two removals of one shared tree at once: one removes it, the other reports it already removed, in either order', async () => {
  const { w, f } = await workWithOpenFix('twice');
  await orch.task.cancel({ task_id: f.id });
  await orch.worker.write({ id: 'c-twice', substrate: 'claude-code', pid: process.pid, state: 'stopped', session_id: 's-c-twice', last_event_at: Date.now(), worktree: w.worktree.path });
  const [a, b] = await Promise.all([orch.task.worktreeRemove({ task_id: w.id }), orch.task.worktreeRemove({ task_id: f.id })]);
  const [first, second] = a.removal.already ? [b, a] : [a, b];
  assert.ok(first.worktree.removed_at && !first.removal.already, 'one call removes the tree');
  assert.deepStrictEqual([second.removal.already, second.removal.removed_through, !!second.worktree.removed_at], [true, first.id, true]);
  // Asked again afterwards, through either task: already removed, never a second git call or a refusal.
  assert.strictEqual((await orch.task.worktreeRemove({ task_id: second.id })).removal.already, true);
  assert.ok(!fs.existsSync(w.worktree.path));
});

test('a fix in a shared tree that names fewer files owns the work\'s files too, so the branch it is judged on passes', async () => {
  let w = await orch.task.create({ spec: 'narrow work', acceptance: { files_within_owned: true }, files_owned: ['src/narrow-a.cjs'] });
  w = await orch.task.worktreeCreate({ task_id: w.id });
  write(w.worktree.path, 'src/narrow-a.cjs', 'a\n');
  commit(w.worktree.path, 'narrow a');
  await handBack(w.id, 'c-narrow', w.worktree.path, { branch: w.worktree.branch });
  assert.strictEqual((await orch.task.evaluate({ task_id: w.id })).state, 'done');
  const r = await orch.task.create({ spec: 'review narrow', depends_on: [w.id], acceptance: { verdict: true } });
  await handBack(r.id, 'j-narrow', dir, { verdict: 'refuted', summary: 's', findings: [] });
  await orch.task.evaluate({ task_id: r.id, worktree: dir });
  const f = await orch.task.fixFromReview({ review_id: r.id, files_owned: ['src/narrow-b.cjs'] });
  assert.deepStrictEqual(f.files_owned, ['src/narrow-a.cjs', 'src/narrow-b.cjs']);
  write(w.worktree.path, 'src/narrow-b.cjs', 'b\n');
  commit(w.worktree.path, 'narrow b');
  await handBack(f.id, 'c-narrow', w.worktree.path, { branch: w.worktree.branch });
  const judged = await orch.task.evaluate({ task_id: f.id });
  assert.strictEqual(judged.state, 'done', JSON.stringify(judged.results.checks));
});

// The fix of workWithOpenFix commits on the shared branch and is judged done.
async function finishFix(w, f, name, text = 'fixed\n') {
  write(w.worktree.path, `src/${name}.cjs`, text);
  commit(w.worktree.path, `${name} fix`);
  await handBack(f.id, `c-${name}`, w.worktree.path, { branch: w.worktree.branch });
  assert.strictEqual((await orch.task.evaluate({ task_id: f.id })).state, 'done');
}
const integrationOf = async (id) => (await orch.task.get({ task_id: id })).integration;

test('a shared branch lands as one: merging the fix marks the work merged, merging the work marks the fix, and a later round is not', async () => {
  const a = await workWithOpenFix('unit-a');
  await finishFix(a.w, a.f, 'unit-a');
  const ra = await orch.integration.merge({ task_ids: [a.f.id], into: 'int/unit-a' });
  assert.deepStrictEqual([(await integrationOf(a.f.id)).state, (await integrationOf(a.f.id)).via], ['merged', undefined]);
  const wa = await integrationOf(a.w.id);
  assert.deepStrictEqual([wa.state, wa.via, wa.id, wa.into], ['merged', a.f.id, ra.id, 'int/unit-a'], 'the work landed with its fix');
  const listed = (await orch.task.list({})).tasks.find((t) => t.id === a.w.id).integration;
  assert.deepStrictEqual([listed.state, listed.via], ['merged', a.f.id], 'task.list says the same');

  const b = await workWithOpenFix('unit-b');
  await finishFix(b.w, b.f, 'unit-b');
  await orch.integration.merge({ task_ids: [b.w.id], into: 'int/unit-b' });
  const fb = await integrationOf(b.f.id);
  assert.deepStrictEqual([fb.state, fb.via], ['merged', b.w.id], 'the fix, done before the merge, landed with the work');
  // A second round after the merge: its fix is done after that merge, so the merge did not land it.
  const r2 = await orch.task.create({ spec: 'review unit-b again', depends_on: [b.f.id], acceptance: { verdict: true } });
  await handBack(r2.id, 'j-unit-b-2', dir, { verdict: 'refuted', summary: 's', findings: [] });
  await orch.task.evaluate({ task_id: r2.id, worktree: dir });
  const f2 = await orch.task.fixFromReview({ review_id: r2.id });
  assert.strictEqual(await integrationOf(f2.id), null, 'an open fix has no integration');
  await finishFix(b.w, f2, 'unit-b', 'fixed again\n');
  assert.deepStrictEqual(await integrationOf(f2.id), { state: 'not_merged', into: null });
});

const { git } = require('./worktree-helpers.cjs');
const judgedHeadOf = async (id) => (await orch.task.get({ task_id: id })).results.head_sha;

test('integrate merges the head the work was judged at: a cancelled fix\'s commit on the shared branch is left out and named', async () => {
  const { w, f } = await workWithOpenFix('abandon');
  const judged = await judgedHeadOf(w.id);
  assert.strictEqual(judged, git(w.worktree.path, 'rev-parse', 'HEAD'), 'the evaluation recorded the head it judged');
  write(w.worktree.path, 'src/abandon.cjs', 'ABANDONED FIX\n');
  commit(w.worktree.path, 'abandoned fix');
  const stray = git(w.worktree.path, 'rev-parse', 'HEAD');
  await orch.task.cancel({ task_id: f.id });
  const row = await orch.integration.merge({ task_ids: [w.id], into: 'int/abandon' });
  const m = row.merged[0];
  assert.deepStrictEqual([m.sha, m.judged_by, m.covers, m.left_out], [judged, w.id, [w.id], { branch: w.worktree.branch, head: stray, judged, commits: 1 }]);
  assert.deepStrictEqual(row.left_out, [{ task_id: w.id, branch: w.worktree.branch, head: stray, judged, commits: 1 }]);
  assert.strictEqual(git(row.worktree, 'show', 'HEAD:src/abandon.cjs'), 'work', 'the abandoned commit did not land');
});

test('a commit made after done, with no fix at all, is left out of the merge', async () => {
  let t = await orch.task.create({ spec: 'late work', acceptance: { files_within_owned: true }, files_owned: ['src/late.cjs'] });
  t = await orch.task.worktreeCreate({ task_id: t.id });
  write(t.worktree.path, 'src/late.cjs', 'judged\n');
  commit(t.worktree.path, 'late judged');
  await handBack(t.id, 'c-late', t.worktree.path, { branch: t.worktree.branch });
  assert.strictEqual((await orch.task.evaluate({ task_id: t.id })).state, 'done');
  const judged = await judgedHeadOf(t.id);
  write(t.worktree.path, 'src/late.cjs', 'after done\n');
  commit(t.worktree.path, 'after done');
  const row = await orch.integration.merge({ task_ids: [t.id], into: 'int/late' });
  assert.deepStrictEqual([row.merged[0].sha, row.merged[0].left_out.commits], [judged, 1]);
  assert.strictEqual(git(row.worktree, 'show', 'HEAD:src/late.cjs'), 'judged');
});

test('a done task that records no judged head is refused, naming the branch head; the work and a done fix merge the fix\'s head', async () => {
  // Judged with its tree already removed, so its evaluation records no head (as a row from before the field would).
  let t = await orch.task.create({ spec: 'headless work', acceptance: PASS });
  t = await orch.task.worktreeCreate({ task_id: t.id });
  write(t.worktree.path, 'src/headless.cjs', 'x\n');
  commit(t.worktree.path, 'headless');
  const tip = git(t.worktree.path, 'rev-parse', 'HEAD');
  await orch.task.worktreeRemove({ task_id: t.id });
  await handBack(t.id, 'c-headless', dir);
  assert.strictEqual((await orch.task.evaluate({ task_id: t.id, worktree: dir })).results.head_sha, undefined);
  const e = await rejectsCode(orch.integration.merge({ task_ids: [t.id], into: 'int/headless' }), 'E_PRECONDITION');
  assert.deepStrictEqual([e.detail.task_id, e.detail.branch_head], [t.id, tip]);
  // A shared branch merges the newest judged head among its done tasks, whichever of them is named.
  const { w, f } = await workWithOpenFix('newest');
  await finishFix(w, f, 'newest');
  const row = await orch.integration.merge({ task_ids: [w.id], into: 'int/newest' });
  assert.deepStrictEqual([row.merged[0].sha, row.merged[0].judged_by, row.merged[0].covers.sort(), row.left_out], [await judgedHeadOf(f.id), f.id, [w.id, f.id].sort(), null]);
});

// A task in its own tree whose judged change is left uncommitted at evaluation.
async function judgedUncommitted(name) {
  let t = await orch.task.create({ spec: `${name} work`, acceptance: { files_within_owned: true }, files_owned: [`src/${name}.cjs`] });
  t = await orch.task.worktreeCreate({ task_id: t.id });
  write(t.worktree.path, `src/${name}.cjs`, 'judged\n');
  await handBack(t.id, `c-${name}`, t.worktree.path, { branch: t.worktree.branch });
  const row = await orch.task.evaluate({ task_id: t.id });
  assert.strictEqual(row.state, 'done');
  return row;
}

test('work judged uncommitted: the evaluation says so, integrate refuses until it is committed as judged, then lands it', async () => {
  const t = await judgedUncommitted('dirty');
  assert.deepStrictEqual([t.results.uncommitted, t.results.warning], [true, 'uncommitted changes: commit before integrate']);
  assert.strictEqual(t.results.head_sha, t.worktree.base_sha, 'HEAD was still the base');
  assert.strictEqual(git(t.worktree.path, 'status', '--porcelain'), '?? src/', 'the real index is untouched: the file is still untracked');
  commit(t.worktree.path, 'dirty, committed as judged');
  const row = await orch.integration.merge({ task_ids: [t.id], into: 'int/dirty' });
  assert.deepStrictEqual([row.merged[0].sha, row.merged[0].covers, row.left_out], [git(t.worktree.path, 'rev-parse', 'HEAD'), [t.id], null]);
  assert.strictEqual(git(row.worktree, 'show', 'HEAD:src/dirty.cjs'), 'judged', 'the judged change landed');
  assert.strictEqual((await orch.task.get({ task_id: t.id })).integration.state, 'merged');
});

test('a commit that differs from the judged state is refused, naming the judged tree, the branch head and the remedy', async () => {
  const t = await judgedUncommitted('differs');
  const e1 = await rejectsCode(orch.integration.merge({ task_ids: [t.id], into: 'int/differs' }), 'E_PRECONDITION');
  assert.match(e1.message, /uncommitted work behind/, 'a dirty tree is refused first, as before');
  write(t.worktree.path, 'src/differs.cjs', 'more than was judged\n');
  commit(t.worktree.path, 'differs');
  const e = await rejectsCode(orch.integration.merge({ task_ids: [t.id], into: 'int/differs' }), 'E_PRECONDITION');
  assert.match(e.message, /commit exactly the judged state, or merge it as a new task/);
  assert.deepStrictEqual([e.detail.judged_tree, e.detail.branch_head], [t.results.tree_sha, git(t.worktree.path, 'rev-parse', 'HEAD')]);
  assert.strictEqual((await orch.integration.list({})).integrations.filter((i) => i.into_branch === 'int/differs').length, 0, 'nothing was written');
});
