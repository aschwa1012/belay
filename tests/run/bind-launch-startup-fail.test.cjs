'use strict';
// bind-launch-startup-fail.test.cjs — ADR 0045 decision 2 and amendment 2: a failed start leaves no key and no child. launchBound
// protects the launch itself; spawn and restart then write the `starting` and `running` rows after the child exists, and a rejected
// row write there used to fail the operation with the child and its bind still live. Real owner, real run manager, fake Claude. The
// failure is injected into the core's worker write (a rejected promise at exactly the named row), and a "thief" claims every bind the
// instant it is opened so the key can be tried afterwards.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const { createRunManager } = require('../../src/run/index.cjs');
const P = require('../../src/run/process.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { claimBind } = require('../../src/core/bind.cjs');
const { pipeName } = require('../../src/core/lock.cjs');
const { cleanup } = require('../core/helpers.cjs');

const fwd = (p) => String(p).split(path.sep).join('/');
const FAKE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
const USER_SETTINGS = path.join(__dirname, 'fixtures', 'user-settings.json');
const RUN = 'run-startfail';

function keyedCall(dataDir, key) {
  return new Promise((resolve, reject) => {
    const s = net.connect(pipeName(dataDir));
    let buf = '';
    const timer = setTimeout(() => { s.destroy(); reject(new Error('no answer')); }, 8000);
    s.on('data', (d) => { buf += d.toString('utf8'); if (buf.includes('\n')) { clearTimeout(timer); s.destroy(); resolve(JSON.parse(buf.split('\n')[0])); } });
    s.on('error', (e) => { clearTimeout(timer); reject(e); });
    s.on('connect', () => s.write(JSON.stringify({ id: 1, method: 'memory.store', params: { text: 'forged as the worker', embed: false, caller: { role: 'operator', run_id: RUN } }, key }) + '\n'));
  });
}

async function withRun(fn) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-startfail-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  const data = fwd(path.join(d, 'data'));
  fs.mkdirSync(data, { recursive: true });
  const core = await openCore({ dataDir: data, caller: { role: 'orchestrator', run_id: RUN, pid: process.pid }, embed: false });
  const loot = [];
  const open = core.bindOpen.bind(core);
  core.bindOpen = async (identity, opts) => { const b = await open(identity, opts); loot.push({ bind_id: b.bind_id, ...(await claimBind(b.pipe, { timeoutMs: 3000 })) }); return b; };
  // Rejects the Nth worker write whose state is `state` (counting from the moment `arm` is called), once.
  const fault = { state: null, nth: 0, seen: 0, fired: 0 };
  const write = core.worker.write.bind(core.worker);
  core.worker.write = async (row) => {
    if (fault.state && row.state === fault.state && ++fault.seen === fault.nth) { fault.fired++; throw Object.assign(new Error(`injected: the ${row.state} row write failed`), { code: 'E_INTERNAL' }); }
    return write(row);
  };
  const arm = (state, nth = 1) => { Object.assign(fault, { state, nth, seen: 0, fired: 0 }); };
  const m = createRunManager({ core, dataDir: data, runId: RUN, paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: USER_SETTINGS } });
  try { return await fn({ core, m, loot, arm, fault, data, worktree: fwd(path.join(d, 'wt')) }); }
  finally { await m.shutdown().catch(() => {}); try { if (core.isOwner()) await core.shutdownOwner(); } catch { /* best effort */ } try { await core.close(); } catch { /* best effort */ } cleanup(d); }
}

async function settled(core, m, id, bindIndex, loot, data) {
  const w = m._worker(id);
  assert.strictEqual(w.bindId, null, 'the worker record holds no bind');
  assert.strictEqual((await core.bindStatus(loot[bindIndex].bind_id)).state, 'revoked');
  const r = await keyedCall(data, loot[bindIndex].key);
  assert.strictEqual(r.error && r.error.code, 'E_UNBOUND', `the captured key must be dead: ${JSON.stringify(r)}`);
  assert.strictEqual(r.error.detail.reason, 'key');
  const gone = await P.waitPidGone(w.pid, { timeoutMs: 15000 });
  assert.ok(gone !== null, `the child (pid ${w.pid}) is still alive after the failed start`);
  const row = await core.worker.get({ worker_id: id });
  assert.ok(['dead', 'stopped'].includes(row.state), `the worker row is ${row.state}`);
}

// spawn writes `starting` twice (before the launch, after it) and `running` once.
for (const [name, state, nth] of [['the starting row after the launch', 'starting', 2], ['the running row', 'running', 1]]) {
  test(`spawn: a rejected write of ${name} revokes the bind, ends the child and leaves the key dead`, { timeout: 90000 }, async () => {
    await withRun(async ({ core, m, loot, arm, fault, data, worktree }) => {
      arm(state, nth);
      await assert.rejects(m.spawn({ substrate: 'claude-code', worktree, prompt: 'hi', worker_id: 'w-sf', startup_timeout_ms: 20000 }), /injected/);
      assert.strictEqual(fault.fired, 1, 'the fault was injected');
      assert.strictEqual(loot.length, 1);
      await settled(core, m, 'w-sf', 0, loot, data);
    });
  });
}

for (const [name, state] of [['the starting row after the relaunch', 'starting'], ['the running row', 'running']]) {
  test(`restart: a rejected write of ${name} revokes the new bind, ends the new child and leaves its key dead`, { timeout: 90000 }, async () => {
    await withRun(async ({ core, m, loot, arm, fault, data, worktree }) => {
      const first = await m.spawn({ substrate: 'claude-code', worktree, prompt: 'hi', worker_id: 'w-sfr', startup_timeout_ms: 20000 });
      assert.strictEqual(loot.length, 1);
      arm(state, 1);
      await assert.rejects(m.restart({ worker_id: 'w-sfr' }), /injected/);
      assert.strictEqual(fault.fired, 1, 'the fault was injected');
      assert.strictEqual(loot.length, 2, 'the relaunch opened its own bind');
      assert.notStrictEqual(m._worker('w-sfr').pid, undefined);
      await settled(core, m, 'w-sfr', 1, loot, data);
      assert.ok(first.pid, 'control: the first launch had a pid of its own');
    });
  });
}

test('control: with no fault the same spawn reaches running and its bind stays live', { timeout: 90000 }, async () => {
  await withRun(async ({ core, m, loot, worktree }) => {
    const w = await m.spawn({ substrate: 'claude-code', worktree, prompt: 'hi', worker_id: 'w-ok', startup_timeout_ms: 20000 });
    assert.strictEqual(w.state, 'running');
    assert.strictEqual((await core.bindStatus(loot[0].bind_id)).state, 'claimed');
    assert.ok(P.pidAlive(w.pid));
  });
});
