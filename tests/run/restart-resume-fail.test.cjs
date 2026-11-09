'use strict';
require('../helpers/tmp.cjs');
// restart-resume-fail.test.cjs — a resume that exits before ready: the fallback's reason says what happened (exit code, first stderr line), the error result
// the dead process printed is not a turn, and an operator's kill of that process is not undone by a fresh conversation.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { resumeFailure } = require('../../src/run/resume-fallback.cjs');
const KM = require('../../src/core/kill-mark.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const fwd = (p) => p.replace(/\\/g, '/');
const FAKE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));

async function rig(t, runId) {
  const data = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-resume-fail-')));
  const worktree = fwd(path.join(data, 'wt'));
  fs.mkdirSync(worktree, { recursive: true });
  const core = createFakeCore({ runId, resumeLineText: 'LINE' });
  const m = createRunManager({ core, dataDir: data, runId, paths: { claudeExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  t.after(async () => { delete process.env.FAKE_FAIL_RESUME; delete process.env.FAKE_FAIL_RESUME_RESULT; await m.shutdown().catch(() => {}); cleanup(data); });
  return { m, core, worktree, data };
}
const started = async (m, worktree) => { await m.spawn({ substrate: 'claude-code', worktree, prompt: 'hello', worker_id: 'w1' }); await m._waitTurn('w1', 20000); return m._worker('w1'); };

test('the fallback reason names the exit and the first stderr line, and the error result before ready is not a turn', async (t) => {
  const { m, core, worktree } = await rig(t, 'run-rf-reason');
  const w = await started(m, worktree);
  const turns = w.turns, oldPid = w.pid;
  process.env.FAKE_FAIL_RESUME = '1'; process.env.FAKE_FAIL_RESUME_RESULT = '1';
  const rows = []; const write = core.worker.write.bind(core.worker);
  core.worker.write = async (row) => { if (row.id === 'w1') rows.push({ state: row.state, pid: row.pid, turns: row.turns }); return write(row); };
  const r = await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 20000 });
  assert.strictEqual(r.branch, 'replace');
  assert.match(r.reason, /the resume failed \(the process exited before it was ready \(exit code 1\): No conversation found with session ID: /);
  assert.doesNotMatch(r.reason, /no ready event/);
  const failedPid = rows.find((x) => x.state === 'starting' && x.pid !== oldPid).pid;
  const ofFailed = rows.filter((x) => x.pid === failedPid);
  assert.deepStrictEqual(ofFailed.map((x) => x.state).filter((s) => s !== 'starting'), [], 'the process that never became ready is never written running');
  assert.ok(ofFailed.every((x) => x.turns === turns), 'and it counted no turn');
});

test('an operator kill of the resume that failed to start is not replaced by a fresh conversation', async (t) => {
  const { m, core, worktree, data } = await rig(t, 'run-rf-kill');
  const w = await started(m, worktree);
  const launches = w.launches, oldPid = w.pid;
  process.env.FAKE_FAIL_RESUME = '1';
  const write = core.worker.write.bind(core.worker);
  core.worker.write = async (row) => {
    if (row.id === 'w1' && row.state === 'starting' && row.pid !== oldPid) KM.mark(data, 'w1', row.pid, null); // the process is gone before its creation time is read, so the row (and the mark) carry none
    return write(row);
  };
  await assert.rejects(m.restart({ worker_id: 'w1', first_turn_timeout_ms: 20000 }), (e) => e.code === 'E_NO_READY');
  assert.strictEqual(w.launches, launches + 1, 'the resume only: nothing relaunched what the operator killed');
});

test('resumeFailure: the kill check is asked of the worker, and a kill returns no fallback', () => {
  const w = { id: 'w1', pid: 7, pidCreated: 'c' };
  const e = Object.assign(new Error('x'), { code: 'E_NO_READY', detail: { branch: 'resume', reason: 'r' } });
  assert.match(resumeFailure(w, e, {}, () => false), /the resume failed \(r\)/);
  assert.strictEqual(resumeFailure(w, e, {}, (x) => x === w), null);
});
