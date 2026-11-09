'use strict';
require('../helpers/tmp.cjs');
// policy-codex-fix-round.test.cjs — a fix round goes back to the original Codex builder. A Codex worker is one process per turn, so between
// turns its row is idle with an exited pid; the round's assignment must still be granted, and a message resumes it. Real core, real run
// manager, the fake Codex executable, real git. The round is the policy runner's own (fix_eval).

const { test: nodeTest } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { guarded, makeRepo } = require('../core/worktree-helpers.cjs');
const { env, RUN } = require('./policy-review-env.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { callerFor } = require('../core/helpers.cjs');
const { openCore } = require('../../src/core/index.cjs');
const RR = require('../../src/run/policy-rounds-run.cjs');

const test = guarded(nodeTest);
const CODEX = path.join(__dirname, 'fakes', 'fake-codex.cjs').split('\\').join('/');
const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split('\\').join('/');
const USER_SETTINGS = path.join(__dirname, 'fixtures', 'user-settings.json').split('\\').join('/');
const FAIL = { commands: [{ argv: [process.execPath, '-e', 'process.exit(3)'], timeout_ms: 20000 }] };
const until = async (fn, ms = 40000) => { for (const end = Date.now() + ms; ;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)); } };

test('fix_eval to an idle Codex builder with an exited pid is assigned, delivered with no commit wording, and the message resumes it', async () => {
  const e = await env('cx-fix');
  const repo = makeRepo(e.dir);
  const t = await e.orch.task.create({ spec: 'write a.txt', acceptance: FAIL, policy: { fix: 'builder' } });
  const wt = (await e.op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
  const gate = `${e.dir}/gate`;
  process.env.FAKE_CODEX_GATE_FILE = gate;
  const m = createRunManager({ core: e.orch, dataDir: `${e.dir}/data`, runId: RUN, paths: { claudeExe: FAKE, codexExe: CODEX, userSettings: USER_SETTINGS } });
  e.mgrs.push(m);
  try {
    await m.spawn({ substrate: 'codex', worktree: wt.path, prompt: 'one', worker_id: 'cx1', task_id: t.id });
    const lease = (await e.orch.task.get({ task_id: t.id })).lease;
    const wc = await openCore({ dataDir: `${e.dir}/data`, caller: callerFor('worker', { worker_id: 'cx1', run_id: RUN }), embed: false });
    e.workers.set('cx1', wc);
    fs.writeFileSync(path.join(wt.path, 'a.txt'), 'a\n');
    await wc.lease.release({ lease_id: lease.id, reason: 'done', result: { summary: 'wrote a' } });
    fs.writeFileSync(gate, 'go');
    const w = m._worker('cx1');
    await until(() => w.lastEvaluation);
    await w.lastEvaluation.promise;
    await until(async () => ((await e.orch.worker.list({})).workers.find((x) => x.id === 'cx1') || {}).state === 'idle');
    const row = (await e.orch.worker.list({})).workers.find((x) => x.id === 'cx1');
    assert.deepStrictEqual([row.substrate, row.state, row.pid_alive], ['codex', 'idle', false], 'between turns: idle, its process gone');
    assert.strictEqual((await e.orch.task.get({ task_id: t.id })).state, 'released', 'the failing evaluation left it released');
    const sent = [];
    const penv = {
      runId: RUN, core: e.h,
      assign: async (a) => { const { prompt, ...rest } = a; const r = await e.orch.task.assign(rest); sent.push(prompt); await m.message({ worker_id: a.worker_id, text: prompt || 'go' }); return { ...r, delivered: { sent: true } }; },
    };
    const text = 'belay: your hand-back of task T failed belay own evaluation (x). Fix it in your worktree, commit, and release the task again.';
    const res = await RR.RUNNERS.fix_eval({ step: 'fix_eval', task_id: t.id, worker: 'cx1', prompt: text }, penv);
    assert.strictEqual(res.outcome, 'done', JSON.stringify(res));
    const after = await e.orch.task.get({ task_id: t.id });
    assert.deepStrictEqual([after.state, after.lease.holder], ['assigned', 'cx1']);
    assert.ok(!/commit/.test(sent[0]), sent[0]);
    assert.ok(await until(() => (m._worker('cx1').turns || 0) >= 2 ? true : null), 'the message started the next turn');
  } finally { delete process.env.FAKE_CODEX_GATE_FILE; await e.close(); }
});
