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
