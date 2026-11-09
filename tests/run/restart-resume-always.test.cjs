'use strict';
require('../helpers/tmp.cjs');
// restart-resume-always.test.cjs — a restart resumes the worker's session whatever its age (the cache window only informs the receipt); a fresh conversation is for
// a worker with no session or thread id, or for a resume that did not come up, and that fallback is made once.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { decideBranch, CLAUDE_RESUME_WINDOW_MS, CODEX_RESUME_WINDOW_MS } = require('../../src/run/restart.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const fwd = (p) => p.replace(/\\/g, '/');
const FAKE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
const FAKE_CODEX = fwd(path.join(__dirname, 'fakes', 'fake-codex.cjs'));

async function rig(t, runId) {
  const data = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-resume-always-')));
  const worktree = fwd(path.join(data, 'wt'));
  fs.mkdirSync(worktree, { recursive: true });
  const core = createFakeCore({ runId, resumeLineText: 'LINE' });
  const m = createRunManager({ core, dataDir: data, runId, paths: { claudeExe: FAKE, codexExe: FAKE_CODEX, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  t.after(async () => { delete process.env.FAKE_FAIL_RESUME; delete process.env.FAKE_CODEX_FAIL_RESUME; await m.shutdown().catch(() => {}); cleanup(data); });
  return { m, core, worktree };
}

test('decideBranch: a session id is resumed at any age, the window only marks the cache cold; no session id replaces', () => {
  const old = (substrate, ageMs) => ({ substrate, sessionId: 's1', lastEventAt: Date.now() - ageMs });
  const claude = decideBranch(old('claude-code', CLAUDE_RESUME_WINDOW_MS + 60 * 60 * 1000));
  assert.strictEqual(claude.branch, 'resume');
  assert.strictEqual(claude.cache_cold, true);
  assert.match(claude.reason, /cache is likely cold/);
  const codex = decideBranch(old('codex', CODEX_RESUME_WINDOW_MS + 60 * 60 * 1000));
  assert.deepStrictEqual([codex.branch, codex.cache_cold], ['resume', true]);
  const fresh = decideBranch(old('claude-code', 1000));
  assert.deepStrictEqual([fresh.branch, fresh.cache_cold], ['resume', false]);
  assert.strictEqual(decideBranch({ substrate: 'claude-code', sessionId: 's1', lastEventAt: null }).branch, 'resume', 'no age is no reason to replace');
  const none = decideBranch({ substrate: 'claude-code', sessionId: null, lastEventAt: Date.now() });
  assert.strictEqual(none.branch, 'replace');
  assert.match(none.reason, /no session or thread id/);
  assert.strictEqual(decideBranch(old('claude-code', 1000), 'the resume failed').branch, 'replace', 'forceReplace is the fallback');
});

test('restart of a Claude Code worker whose last event is hours old resumes its session', async (t) => {
  const { m, worktree } = await rig(t, 'run-ra-old');
  await m.spawn({ substrate: 'claude-code', worktree, prompt: 'hello', worker_id: 'w1' });
  await m._waitTurn('w1', 20000);
  const w = m._worker('w1');
  const session = w.sessionId;
  w.lastEventAt = Date.now() - 3 * 60 * 60 * 1000;
  const r = await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 20000 });
  assert.strictEqual(r.branch, 'resume');
  assert.match(r.reason, /cache is likely cold/);
  assert.strictEqual(r.session_id, session);
});

test('a resume that does not come up falls back to a fresh conversation once, with the reason recorded', async (t) => {
  const { m, core, worktree } = await rig(t, 'run-ra-fall');
  await m.spawn({ substrate: 'claude-code', worktree, prompt: 'hello', worker_id: 'w1' });
  await m._waitTurn('w1', 20000);
  const w = m._worker('w1');
  const launches = w.launches;
  process.env.FAKE_FAIL_RESUME = '1';
  const states = []; const write = core.worker.write.bind(core.worker);
  core.worker.write = async (row) => { if (row.id === 'w1') states.push(row.state); return write(row); };
  const r = await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 20000 });
  assert.strictEqual(states.includes('dead'), false, 'no dead row between the attempts: no death wake for a relaunch');
  assert.strictEqual(r.cache_cold, false, 'the receipt carries cache_cold');
  assert.strictEqual(r.branch, 'replace');
  assert.match(r.reason, /the resume failed .*replaced with a fresh conversation/);
  assert.strictEqual(w.launches, launches + 2, 'the failed resume and the one replacement, no more');
  assert.strictEqual(r.worker.state === 'dead', false);
});

test('a worker with no session id is replaced without trying a resume', async (t) => {
  const { m, worktree } = await rig(t, 'run-ra-none');
  await m.spawn({ substrate: 'claude-code', worktree, prompt: 'hello', worker_id: 'w1' });
  await m._waitTurn('w1', 20000);
  const w = m._worker('w1');
  const launches = w.launches;
  w.sessionId = null;
  const r = await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 20000 });
  assert.strictEqual(r.branch, 'replace');
  assert.match(r.reason, /no session or thread id/);
  assert.strictEqual(w.launches, launches + 1);
});

test('Codex: an old thread is resumed, and a thread the server no longer has falls back to a fresh one once', async (t) => {
  const { m, worktree } = await rig(t, 'run-ra-codex');
  await m.spawn({ substrate: 'codex', worktree, prompt: 'hello', worker_id: 'c1' });
  await m._waitTurn('c1', 20000);
  const w = m._worker('c1');
  w.lastEventAt = Date.now() - 3 * 60 * 60 * 1000;
  const ok = await m.restart({ worker_id: 'c1', first_turn_timeout_ms: 20000 });
  assert.strictEqual(ok.branch, 'resume');
  await m._waitTurn('c1', 20000).catch(() => {});
  const launches = w.launches;
  process.env.FAKE_CODEX_FAIL_RESUME = '1';
  const r = await m.restart({ worker_id: 'c1', first_turn_timeout_ms: 20000 });
  assert.strictEqual(r.branch, 'replace');
  assert.match(r.reason, /the resume failed/);
  assert.strictEqual(w.launches, launches + 2);
});

test('withFallback: a failed resume with no second launch writes the deferred dead row; a failed second attempt carries the first one reason', async () => {
  const { withFallback } = require('../../src/run/resume-fallback.cjs');
  const noReady = (branch) => Object.assign(new Error('no ready'), { code: 'E_NO_READY', detail: { branch, reason: 'exited' } });
  let dead = 0;
  const refused = withFallback(async (w) => { w.deadDeferred = true; throw Object.assign(new Error('refused'), { code: 'E_PRECONDITION', detail: {} }); }, async () => { dead += 1; });
  await assert.rejects(refused({}, {}), /refused/);
  assert.strictEqual(dead, 1, 'no second launch followed: the dead row is written');
  const calls = [];
  const twice = withFallback(async (w, o) => { calls.push(o.forceReplace || 'resume'); w.deadDeferred = true; throw noReady(o.forceReplace ? 'replace' : 'resume'); }, async () => { dead += 1; });
  await assert.rejects(twice({}, {}), (e) => /the resume failed \(exited\)/.test(e.detail.resume_failed));
  assert.strictEqual(calls.length, 2, 'once more, never a third');
  assert.strictEqual(dead, 1, 'a second launch followed: nothing deferred is written here');
});
