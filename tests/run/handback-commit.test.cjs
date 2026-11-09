'use strict';
require('../helpers/tmp.cjs');
// handback-commit.test.cjs — belay commits for a Codex worker (its sandbox denies the worktree's index lock). Real git in a temp
// repository, the real core, and for the wiring the real run manager over the fake Codex executable. Each case states what the
// hand-back records: the commit made (and the head), or the reason none was, with the head left as it was.

const { test: nodeTest } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { guarded, makeRepo, write, commit, git } = require('../core/worktree-helpers.cjs');
const HC = require('../../src/run/handback-commit.cjs');
const { env, PASS, RUN } = require('./policy-review-env.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { callerFor } = require('../core/helpers.cjs');
const { openCore } = require('../../src/core/index.cjs');

const test = guarded(nodeTest);
const CODEX = path.join(__dirname, 'fakes', 'fake-codex.cjs').split('\\').join('/');
const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split('\\').join('/');
const USER_SETTINGS = path.join(__dirname, 'fixtures', 'user-settings.json').split('\\').join('/');

// A repository whose base has base/keep.txt and a tracked second file, a task with a belay worktree `wtName` under it, and a Codex worker
// that holds the task and has released it with `result`. -> { e, task, tree, base, w, handBack() }.
async function released(label, { wtName = null, result = { summary: 'add the thing', tests: 'ok' }, substrate = 'codex' } = {}) {
  const e = await env(label);
  const repo = makeRepo(e.dir);
  write(repo, 'src/mod.txt', 'one\n'); write(repo, 'src/gone.txt', 'bye\n'); commit(repo, 'more base');
  const t = await e.orch.task.create({ spec: 'edit src', acceptance: PASS, policy: null });
  const wt = (await e.op.task.worktreeCreate({ task_id: t.id, repo, ...(wtName ? { path: path.join(e.dir, wtName).split('\\').join('/') } : {}) })).worktree;
  await e.orch.worker.write({ id: 'cx1', substrate, pid: process.pid, state: 'idle', session_id: 's-cx1', last_event_at: Date.now(), worktree: wt.path });
  const c = await openCore({ dataDir: `${e.dir}/data`, caller: callerFor('worker', { worker_id: 'cx1' }), embed: false });
  e.workers.set('cx1', c);
  const a = await e.orch.task.assign({ task_id: t.id, worker_id: 'cx1' });
  const base = git(wt.path, 'rev-parse', 'HEAD');
  const r = { e, task: t, tree: wt.path, branch: wt.branch, base, w: { id: 'cx1', substrate, worktree: wt.path }, lease: a.new_lease.id, ctx: { core: e.h } };
  r.release = async (res = result) => c.lease.release({ lease_id: r.lease, reason: 'done', ...(res ? { result: res } : {}) });
  r.handBack = () => HC.handBack(r.w, r.ctx, t.id);
  r.row = () => e.orch.task.get({ task_id: t.id });
  r.count = () => Number(git(r.tree, 'rev-list', '--count', 'HEAD'));
  return r;
}

test('new, modified and deleted files are committed on the task branch, and the hand-back records belay\'s commit and the new head', async () => {
  const r = await released('hc-all');
  try {
    write(r.tree, 'src/mod.txt', 'two\n'); write(r.tree, 'src/new.txt', 'new\n'); fs.unlinkSync(path.join(r.tree, 'src/gone.txt'));
    await r.release();
    const got = await r.handBack();
    const head = git(r.tree, 'rev-parse', 'HEAD');
    assert.notStrictEqual(head, r.base);
    assert.deepStrictEqual([got.made, got.head, got.branch, got.files], [true, head, r.branch, 3]);
    assert.strictEqual(git(r.tree, 'show', '--name-status', '--format=', 'HEAD').split('\n').map((l) => l.replace(/\s+/g, ' ')).sort().join('|'), 'A src/new.txt|D src/gone.txt|M src/mod.txt');
    assert.strictEqual(git(r.tree, 'status', '--porcelain'), '', 'nothing is left uncommitted');
    assert.strictEqual(git(r.tree, 'log', '-1', '--format=%s'), 'add the thing');
    assert.ok(!/co-authored-by/i.test(git(r.tree, 'log', '-1', '--format=%B')), 'no Co-Authored-By');
    assert.strictEqual(git(r.tree, 'log', '-1', '--format=%an <%ae>'), 't <t@example.com>', 'the repository\'s configured identity');
    const row = await r.row();
    assert.deepStrictEqual([row.handoff.committed_by, row.handoff.commit.made, row.handoff.commit.head], ['belay', true, head]);
    assert.deepStrictEqual(row.handoff.result, { summary: 'add the thing', tests: 'ok' }, 'the worker\'s own words are untouched');
    assert.strictEqual(row.state, 'released');
  } finally { await r.e.close(); }
});

test('nothing to commit: no empty commit, the head is unchanged and recorded, and belay is not named as the committer', async () => {
  const r = await released('hc-none');
  try {
    await r.release();
    const got = await r.handBack();
    assert.deepStrictEqual([got.made, got.head, got.error], [false, r.base, undefined]);
    assert.strictEqual(r.count(), 2);
    const row = await r.row();
    assert.deepStrictEqual([row.handoff.commit.made, row.handoff.commit.head, row.handoff.committed_by], [false, r.base, undefined]);
  } finally { await r.e.close(); }
});

test('ignored files are not committed', async () => {
  const r = await released('hc-ignored');
  try {
    write(r.tree, 'src/mod.txt', 'two\n'); write(r.tree, 'node_modules/x/y.js', 'ignored\n');
    await r.release();
    const got = await r.handBack();
    assert.strictEqual(got.made, true);
    assert.strictEqual(git(r.tree, 'show', '--name-only', '--format=', 'HEAD'), 'src/mod.txt');
    assert.ok(fs.existsSync(path.join(r.tree, 'node_modules/x/y.js')));
  } finally { await r.e.close(); }
});

test('a stale index.lock is a recorded error: no commit, the head is the real one, and belay is not named as the committer', async () => {
  const r = await released('hc-lock');
  try {
    write(r.tree, 'src/mod.txt', 'two\n');
    fs.writeFileSync(git(r.tree, 'rev-parse', '--path-format=absolute', '--git-path', 'index.lock'), '');
    await r.release();
    const got = await r.handBack();
    assert.strictEqual(got.made, false);
    assert.match(got.error, /git add failed: .*index\.lock/s);
    assert.strictEqual(got.head, r.base);
    const row = await r.row();
    assert.deepStrictEqual([row.handoff.commit.made, row.handoff.commit.head, row.handoff.committed_by], [false, r.base, undefined]);
    assert.match(row.handoff.commit.error, /index\.lock/);
    assert.notStrictEqual(row.handoff_stale, true, 'no head was invented');
    assert.strictEqual(r.count(), 2);
  } finally { await r.e.close(); }
});

test('a commit git refuses (a failing pre-commit hook) is a recorded error with the files left in the tree', async () => {
  const r = await released('hc-hook');
  try {
    const hook = git(r.tree, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks/pre-commit');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n', { mode: 0o755 });
    write(r.tree, 'src/mod.txt', 'two\n');
    await r.release();
    const got = await r.handBack();
    assert.strictEqual(got.made, false);
    assert.match(got.error, /^git commit failed: .*hook says no/s);
    assert.strictEqual(git(r.tree, 'rev-parse', 'HEAD'), r.base);
    assert.strictEqual(git(r.tree, 'status', '--porcelain'), 'M  src/mod.txt');
    assert.strictEqual((await r.row()).handoff.committed_by, undefined);
  } finally { await r.e.close(); }
});

test('a second hand-back after a fix round commits again, and the head moves again', async () => {
  const r = await released('hc-second');
  try {
    write(r.tree, 'src/mod.txt', 'two\n'); await r.release();
    const first = await r.handBack();
    // The orchestrator sends the task back: it is assigned again and the worker edits and hands back a second time.
    const again = await r.e.orch.task.assign({ task_id: r.task.id, worker_id: 'cx1' });
    r.lease = again.new_lease.id;
    write(r.tree, 'src/mod.txt', 'three\n'); await r.release({ summary: 'fix round', tests: 'ok' });
    const second = await r.handBack();
    assert.deepStrictEqual([first.made, second.made], [true, true]);
    assert.notStrictEqual(second.head, first.head);
    assert.strictEqual(git(r.tree, 'log', '-1', '--format=%s'), 'fix round');
    assert.strictEqual(r.count(), 4);
    const row = await r.row();
    assert.deepStrictEqual([row.handoff.commit.head, row.handoff.committed_by], [second.head, 'belay']);
  } finally { await r.e.close(); }
});

test('belay refuses to commit when HEAD is detached or the worktree is on another branch than the row records', async () => {
  const r = await released('hc-branch');
  try {
    write(r.tree, 'src/mod.txt', 'two\n'); await r.release();
    git(r.tree, 'checkout', '-q', '--detach');
    const det = await r.handBack();
    assert.deepStrictEqual([det.made, det.head, /detached/.test(det.error)], [false, r.base, true]);
    git(r.tree, 'checkout', '-q', '-b', 'elsewhere');
    const other = await r.handBack();
    assert.deepStrictEqual([other.made, /on elsewhere, not on the task's branch/.test(other.error)], [false, true]);
    assert.strictEqual(git(r.tree, 'rev-parse', 'HEAD'), r.base);
    assert.strictEqual(git(r.tree, 'status', '--porcelain'), 'M src/mod.txt');
    assert.strictEqual(r.count(), 2);
  } finally { await r.e.close(); }
});

test('a worktree path with spaces commits', async () => {
  const r = await released('hc-space', { wtName: 'wt with spaces/inner dir' });
  try {
    assert.ok(r.tree.includes(' '));
    write(r.tree, 'src/a b.txt', 'spaced\n'); await r.release();
    const got = await r.handBack();
    assert.strictEqual(got.made, true);
    assert.strictEqual(git(r.tree, 'show', '--name-only', '--format=', 'HEAD'), '"src/a b.txt"'.replace(/"/g, ''));
  } finally { await r.e.close(); }
});

test('a Claude Code worker is never committed for, and a long or empty summary gives a bounded subject', async () => {
  const c = await released('hc-claude', { substrate: 'claude-code' });
  try {
    write(c.tree, 'src/mod.txt', 'two\n'); await c.release();
    assert.strictEqual(await c.handBack(), null);
    assert.strictEqual(git(c.tree, 'rev-parse', 'HEAD'), c.base);
    assert.strictEqual((await c.row()).handoff.commit, undefined);
  } finally { await c.e.close(); }
  assert.strictEqual(HC.subjectOf({ handoff: { result: { summary: '\n\n  first line  \nsecond' } } }, 'w'), 'first line');
  assert.strictEqual(HC.subjectOf({ handoff: { result: { summary: 'x'.repeat(200) } } }, 'w').length, 72);
  assert.strictEqual(HC.subjectOf({ handoff: { result: null } }, 'cx9'), 'codex worker cx9: hand-back');
  assert.strictEqual(HC.subjectOf({ handoff: { result: { summary: 7 } } }, 'cx9'), 'codex worker cx9: hand-back');
});

test('recordCommit writes only onto a released hand-back of that worker and lease', async () => {
  const r = await released('hc-core');
  try {
    const fact = { made: false, head: r.base, branch: r.branch };
    await assert.rejects(r.e.orch.task.recordCommit({ task_id: r.task.id, worker_id: 'cx1', commit: fact }), { code: 'E_PRECONDITION' }); // not yet released
    await r.release();
    await assert.rejects(r.e.orch.task.recordCommit({ task_id: r.task.id, worker_id: 'other', commit: fact }), { code: 'E_PRECONDITION' });
    await assert.rejects(r.e.orch.task.recordCommit({ task_id: r.task.id, worker_id: 'cx1', lease_id: 'nope', commit: fact }), { code: 'E_PRECONDITION' });
    await assert.rejects(r.e.orch.task.recordCommit({ task_id: r.task.id, worker_id: 'cx1', commit: { made: true, head: 'zz' } }), { code: 'E_ARGS' });
    await assert.rejects(r.e.orch.task.recordCommit({ task_id: r.task.id, commit: fact }), { code: 'E_ARGS' });
    assert.strictEqual((await r.row()).handoff.commit, undefined, 'every refusal wrote nothing');
    const row = await r.e.orch.task.recordCommit({ task_id: r.task.id, worker_id: 'cx1', lease_id: r.lease, commit: { made: true, head: 'a'.repeat(40), branch: r.branch, files: 1, message: 'm' } });
    assert.deepStrictEqual([row.handoff.committed_by, row.handoff.commit.head], ['belay', 'a'.repeat(40)]);
  } finally { await r.e.close(); }
});

// The wiring: the run manager's release evaluation commits for a Codex worker before it judges the tree, so the evaluation is of a commit.
async function managed(label, { lock = false } = {}) {
  const e = await env(label);
  const repo = makeRepo(e.dir);
  const t = await e.orch.task.create({ spec: 'write a.txt', acceptance: PASS, policy: null });
  const wt = (await e.op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
  const base = git(wt.path, 'rev-parse', 'HEAD');
  const gate = path.join(e.dir, 'gate').split('\\').join('/');
  const saved = process.env.FAKE_CODEX_GATE_FILE;
  process.env.FAKE_CODEX_GATE_FILE = gate;
  const m = createRunManager({ core: e.orch, dataDir: `${e.dir}/data`, runId: RUN, paths: { claudeExe: FAKE, codexExe: CODEX, userSettings: USER_SETTINGS } });
  e.mgrs.push(m);
  try {
    await m.spawn({ substrate: 'codex', worktree: wt.path, prompt: 'one', worker_id: 'cx1', task_id: t.id });
    const lease = (await e.orch.task.get({ task_id: t.id })).lease;
    write(wt.path, 'a.txt', 'a\n');
    if (lock) fs.writeFileSync(git(wt.path, 'rev-parse', '--path-format=absolute', '--git-path', 'index.lock'), '');
    const wc = await openCore({ dataDir: `${e.dir}/data`, caller: callerFor('worker', { worker_id: 'cx1', run_id: RUN }), embed: false });
    e.workers.set('cx1', wc);
    await wc.lease.release({ lease_id: lease.id, reason: 'done', result: { summary: 'write a.txt', branch: 'b', head: base } }); // the head a Codex coder can only name: the base
    fs.writeFileSync(gate, 'go');
    const w = m._worker('cx1');
    for (const end = Date.now() + 40000; !w.lastEvaluation && Date.now() < end;) await new Promise((res) => setTimeout(res, 20));
    assert.ok(w.lastEvaluation, 'the turn ended and an evaluation started');
    await w.lastEvaluation.promise;
    return { e, t, wt, base, row: await e.orch.task.get({ task_id: t.id }) };
  } finally { if (saved === undefined) delete process.env.FAKE_CODEX_GATE_FILE; else process.env.FAKE_CODEX_GATE_FILE = saved; }
}

test('through the run manager: a Codex hand-back is committed by belay, evaluated at that commit, and is done with the real head', async () => {
  const x = await managed('hc-managed');
  try {
    const head = git(x.wt.path, 'rev-parse', 'HEAD');
    assert.notStrictEqual(head, x.base);
    assert.deepStrictEqual([x.row.state, x.row.handoff.committed_by, x.row.handoff.commit.head], ['done', 'belay', head]);
    assert.strictEqual(x.row.results.head_sha, head);
    assert.notStrictEqual(x.row.results.uncommitted, true);
    assert.notStrictEqual(x.row.handoff_stale, true, 'the head the worker named (the base) is not what the hand-back stands at; belay\'s commit is');
  } finally { await x.e.close(); }
});

test('through the run manager: a commit that cannot be made is recorded and the evaluation says the work is uncommitted', async () => {
  const x = await managed('hc-managed-lock', { lock: true });
  try {
    assert.strictEqual(git(x.wt.path, 'rev-parse', 'HEAD'), x.base);
    assert.deepStrictEqual([x.row.handoff.commit.made, x.row.handoff.committed_by, /index\.lock/.test(x.row.handoff.commit.error)], [false, undefined, true]);
    assert.strictEqual(x.row.results.head_sha, x.base, 'judged at the real head, which is the base');
  } finally { await x.e.close(); }
});
