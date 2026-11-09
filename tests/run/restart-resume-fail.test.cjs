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

// Cost across a resume. Claude Code carries the session total after a graceful exit and starts again at zero after a kill (measured); the row
// follows whichever the new process shows at its first report, and never goes down or counts a spend twice.
async function costAfterRestart(t, id, env) {
  const { m, core, worktree } = await rig(t, id);
  const w = await started(m, worktree);
  w.costUsd = 0.03; // what the first process left on the row
  const costs = []; const write = core.worker.write.bind(core.worker);
  core.worker.write = async (row) => { if (row.id === 'w1') costs.push(row.cost_usd); return write(row); };
  const saved = process.env.FAKE_COST_BASE;
  Object.assign(process.env, env);
  try { await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 20000 }); } finally { if (saved === undefined) delete process.env.FAKE_COST_BASE; else process.env.FAKE_COST_BASE = saved; }
  assert.ok(costs.every((c) => c >= 0.03 - 1e-9), `no row written lower than the cost so far: ${costs}`);
  return w.costUsd;
}

test('a resume that carries the session total is not counted twice', async (t) => {
  const cost = await costAfterRestart(t, 'run-rf-carry', { FAKE_COST_BASE: '0.03' }); // the new process reports 0.031
  assert.ok(Math.abs(cost - 0.031) < 1e-9, `0.031, got ${cost}`);
});

test('a resume whose total restarted from zero (a killed process) adds to the cost so far', async (t) => {
  const cost = await costAfterRestart(t, 'run-rf-zero', {}); // the new process reports 0.001
  assert.ok(Math.abs(cost - 0.031) < 1e-9, `0.031, got ${cost}`);
});

test('cost-carry: the one ambiguous case reads as carried, and the row never falls', () => {
  const CC = require('../../src/run/cost-carry.cjs');
  const w = { costUsd: 0.03, costBase: 0 };
  CC.arm(w);
  assert.strictEqual(CC.total(w, 0.03), 0.03, 'a report equal to the previous total is a carry');
  assert.ok(Math.abs(CC.total(w, 0.04) - 0.04) < 1e-9, 'decided once; later reports add to the same base');
  const z = { costUsd: 0.03, costBase: 0 };
  CC.arm(z);
  assert.ok(Math.abs(CC.total(z, 0) - 0.03) < 1e-9, 'a $0 report from a restarted total leaves the row where it was');
  assert.ok(Math.abs(CC.total(z, 0.01) - 0.04) < 1e-9);
});

test('the fallback reason quotes the failed resume, not an earlier life stderr', async (t) => {
  const { m, worktree } = await rig(t, 'run-rf-stderr');
  process.env.FAKE_ECHO_MCP_TOOL_TIMEOUT = '1';
  t.after(() => { delete process.env.FAKE_ECHO_MCP_TOOL_TIMEOUT; });
  await started(m, worktree); // the first life wrote a stderr line
  delete process.env.FAKE_ECHO_MCP_TOOL_TIMEOUT;
  process.env.FAKE_FAIL_RESUME = '1';
  const r = await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 20000 });
  assert.match(r.reason, /No conversation found with session ID/);
  assert.doesNotMatch(r.reason, /FAKE_ENV/);
});

test('a kill mark counts when either side lacks the creation time, and not for another pid', () => {
  const data = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-km-')));
  try {
    KM.mark(data, 'w1', 5, null);
    assert.strictEqual(KM.isKilledLoose(data, 'w1', 5, '123'), true);
    KM.mark(data, 'w1', 5, '123');
    assert.strictEqual(KM.isKilledLoose(data, 'w1', 5, null), true);
    assert.strictEqual(KM.isKilledLoose(data, 'w1', 5, '999'), false, 'two known and different creation times are two processes');
    assert.strictEqual(KM.isKilledLoose(data, 'w1', 6, '123'), false);
  } finally { cleanup(data); }
});
