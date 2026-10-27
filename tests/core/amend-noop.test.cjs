'use strict';
// amend-noop.test.cjs — task.create { amend: true } with a field beside the revision: a value the task already has is a no-op, a real
// change is refused by name; the busy refusal says to retry; the tool's answer shows the NEW acceptance and labels the old one.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, rejectsCode } = require('./worktree-helpers.cjs');

const { openCore } = core('index.cjs');
const V = require('../../src/mcp/views.cjs');
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };
const FAIL = { commands: [{ argv: [process.execPath, '-e', 'process.exit(3)'], timeout_ms: 20000 }] };

const fwd = (p) => p.split(path.sep).join('/');
let dir, orch;

before(async () => {
  dir = sandbox();
  const repo = makeRepo(dir);
  orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid, project_dir: repo });
});

after(async () => {
  try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
});

test('amend accepts a repeated files_owned and depends_on, and refuses a changed one by name', async () => {
  const dep = await orch.task.create({ spec: 'first', acceptance: PASS });
  const t = await orch.task.create({ id: 'noop-amend', spec: 'work', files_owned: ['src/a.js'], depends_on: [dep.id], acceptance: FAIL });
  const a = await orch.task.create({ id: t.id, amend: true, acceptance: PASS, files_owned: ['src/a.js'], depends_on: [dep.id], spec: 'work' });
  assert.deepStrictEqual([a.acceptance, a.files_owned, a.depends_on, a.amended.length], [PASS, ['src/a.js'], [dep.id], 1]);
  const e = await rejectsCode(orch.task.create({ id: t.id, amend: true, acceptance: FAIL, files_owned: ['src/b.js'], depends_on: [dep.id], repairs: 'x' }), 'E_ARGS');
  assert.deepStrictEqual(e.detail.fields, ['files_owned', 'repairs'], 'only the real changes are named');
  assert.strictEqual((await orch.task.get({ task_id: t.id })).amended.length, 1, 'the refused amend wrote nothing');
});

test('the busy refusal says to retry once the result lands', async () => {
  const started = fwd(path.join(dir, 'started')), gate = fwd(path.join(dir, 'gate'));
  const argv = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(started)}, ''); const t = setInterval(() => { if (require('fs').existsSync(${JSON.stringify(gate)})) clearInterval(t); }, 20);`];
  const t = await orch.task.create({ spec: 'slow', acceptance: { commands: [{ argv, timeout_ms: 60000 }] } });
  await orch.worker.write({ id: 'noop-w', substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: 's', last_event_at: Date.now(), worktree: dir });
  const w = await openCore({ dataDir: `${dir}/data`, caller: callerFor('worker', { worker_id: 'noop-w' }), embed: false });
  try {
    const l = (await orch.task.assign({ task_id: t.id, worker_id: 'noop-w' })).new_lease;
    await w.lease.release({ lease_id: l.id, reason: 'done', result: { branch: 'b' } });
    const running = orch.task.evaluate({ task_id: t.id, worktree: dir });
    while (!fs.existsSync(started)) await new Promise((r) => setImmediate(r));
    const e = await rejectsCode(orch.task.create({ id: t.id, amend: true, acceptance: FAIL }), 'E_BUSY');
    assert.match(e.message, /retry/);
    fs.writeFileSync(gate, '');
    await running;
  } finally { await w.close(); }
});

test('the tool answer to an amend shows the new acceptance and labels the replaced one', () => {
  const row = { id: 't', seq: 3, state: 'released', spec: 'work', acceptance: PASS, amended: [{ at: 1, by: 'orchestrator', acceptance: FAIL }] };
  const out = V.VIEWED.task_create(row);
  assert.deepStrictEqual(out.acceptance, PASS);
  assert.deepStrictEqual(out.replaced, [{ at: 1, by: 'orchestrator', acceptance: FAIL }]);
  assert.ok(!('amended' in out), 'nothing named amended that reads as the current acceptance');
  const fresh = V.VIEWED.task_create({ id: 't', seq: 1, state: 'created', spec: 'work', acceptance: PASS, amended: null });
  assert.ok(!('acceptance' in fresh) && !('replaced' in fresh), 'a plain create answers as before');
});
