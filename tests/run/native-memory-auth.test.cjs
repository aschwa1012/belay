'use strict';
// native-memory-auth.test.cjs: who opted in to a worker's native_memory is a fact of the worker row that no later write changes. A run that
// was refused cannot pass as the run that opted in (its dead row names it as the writer), a run id used again by a later run does not
// inherit the grant, and a settings rewrite that fails during a denied adoption leaves the refusal in force for the cached worker.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const NM = require('../../src/run/native-memory.cjs');
const L = require('../../src/run/launch.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split(path.sep).join('/');
const fwd = (p) => String(p).split(path.sep).join('/');
const PATHS = { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') };
const RESUME = 'task t1 state assigned; next step: (stated) none yet';
const REFUSED = /recorded by another run/;

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-nm-auth-'));
  fs.mkdirSync(path.join(d, 'wt'));
  return { d, data: fwd(d), worktree: fwd(path.join(d, 'wt')), mem: fwd(path.join(d, 'mem')) };
}
// A core sharing `base`'s worker rows whose run answers with `levers` and, for the lifetime, the run's rows `epochs` as [seq, ended].
const coreWith = (levers, base, epochs, runId) => {
  const core = Object.create(base);
  const rows = (epochs || []).map(([seq, ended]) => ({ id: runId, seq, ended_at: ended ? 1 : null }));
  core.run = { get: async () => ({ run: { id: runId, memory_levers: JSON.stringify(levers) }, epochs: rows }) };
  return core;
};
const make = (sb, core, runId) => createRunManager({ core, dataDir: sb.data, runId, paths: PATHS });
const settingsFile = (sb, id) => path.join(L.workerDir(sb.data, id), 'settings.json');
const settingsOf = (sb, id) => JSON.parse(fs.readFileSync(settingsFile(sb, id), 'utf8'));
const authOf = (base, id) => JSON.parse(base.currentWorker(id).native_memory_auth);

async function firstRun(sb, base, id, epochs) {
  const m1 = make(sb, coreWith({}, base, epochs, 'run-a'), 'run-a');
  await m1.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: id, native_memory: sb.mem });
  await m1.stop({ worker_id: id, mode: 'kill', timeout_ms: 8000 });
  return m1;
}
const closeAll = async (ms, sb) => { delete process.env.FAKE_MEMORY_AUTO; for (const m of ms.reverse()) await m.shutdown?.().catch(() => {}); cleanup(sb.d); };

test('a run that was refused is not the run that opted in: its dead row does not authorize a fresh manager of it', async () => {
  const sb = sandbox(); const base = createFakeCore({ runId: 'run-a', resumeLineText: RESUME }); const ms = [];
  process.env.FAKE_MEMORY_AUTO = 'echo';
  try {
    ms.push(await firstRun(sb, base, 'w-1', [[1, false]]));
    assert.deepEqual(authOf(base, 'w-1'), { run_id: 'run-a', lifetime: 1 });
    const mb = make(sb, coreWith({}, base, [[5, false]], 'run-b'), 'run-b'); ms.push(mb);
    await assert.rejects(mb.restart({ worker_id: 'w-1', first_turn_timeout_ms: 20000 }), (e) => REFUSED.test(e.message));
    const dead = base.currentWorker('w-1');
    assert.equal(dead.state, 'dead'); assert.equal(dead.run_id, 'run-b', 'the refusal row names its writer');
    assert.equal(dead.native_memory, sb.mem, 'the record is kept');
    assert.deepEqual(authOf(base, 'w-1'), { run_id: 'run-a', lifetime: 1 }, 'and so is who opted in: a refusal confers nothing');
    const mb2 = make(sb, coreWith({}, base, [[5, false]], 'run-b'), 'run-b'); ms.push(mb2); // a fresh manager of the refused run
    await assert.rejects(mb2.restart({ worker_id: 'w-1', first_turn_timeout_ms: 20000 }), (e) => REFUSED.test(e.message));
    assert.equal(settingsOf(sb, 'w-1').autoMemoryEnabled, false);
    assert.equal('autoMemoryDirectory' in settingsOf(sb, 'w-1'), false, "the folder is not in run-b's settings");
    assert.deepEqual(authOf(base, 'w-1'), { run_id: 'run-a', lifetime: 1 });
  } finally { await closeAll(ms, sb); }
});

test('a run id used again by a later run does not inherit the grant; a reattach within the same lifetime keeps it', async () => {
  const sb = sandbox(); const base = createFakeCore({ runId: 'run-a', resumeLineText: RESUME }); const ms = [];
  process.env.FAKE_MEMORY_AUTO = 'echo';
  try {
    ms.push(await firstRun(sb, base, 'w-2', [[1, false]]));
    const again = make(sb, coreWith({}, base, [[1, false], [2, true], [3, false]], 'run-a'), 'run-a'); ms.push(again); // run-a ended at seq 2 and was started again
    await assert.rejects(again.restart({ worker_id: 'w-2', first_turn_timeout_ms: 20000 }), (e) => REFUSED.test(e.message));
    assert.equal('autoMemoryDirectory' in settingsOf(sb, 'w-2'), false);
    const same = make(sb, coreWith({}, base, [[1, false], [2, false], [3, false]], 'run-a'), 'run-a'); ms.push(same); // epochs of one life
    await same.restart({ worker_id: 'w-2', first_turn_timeout_ms: 45000 });
    assert.equal(same._worker('w-2').state, 'running');
    assert.equal(settingsOf(sb, 'w-2').autoMemoryDirectory, sb.mem);
  } finally { await closeAll(ms, sb); }
});

test('a lifetime that cannot be read grants nothing, and an old row with no grant needs the own-run lever', async () => {
  const w = { id: 'w', nativeMemory: 'C:/x/mem', nativeMemoryAuth: JSON.stringify({ run_id: 'run-a', lifetime: 1 }) };
  const broken = { run: { get: async () => { throw new Error('store busy'); } } };
  const e = await NM.adoptDenied(w, 'run-a', {}, broken);
  assert.ok(e && e.detail.reason === 'foreign_native_memory');
  const none = await NM.adoptDenied({ ...w, nativeMemoryAuth: null }, 'run-a', {}, { run: { get: async () => ({ epochs: [] }) } });
  assert.ok(none && none.detail.reason === 'foreign_native_memory');
  assert.equal(await NM.adoptDenied({ ...w, nativeMemoryAuth: '{not json' }, 'run-a', { native_memory: 'C:/x/mem' }, broken), null, 'the lever naming the folder is still a grant');
});

test('a settings rewrite that fails in a denied adoption does not stop the stop, and the later restart is still refused', async () => {
  const sb = sandbox(); const base = createFakeCore({ runId: 'run-a', resumeLineText: RESUME }); const ms = [];
  process.env.FAKE_MEMORY_AUTO = 'echo';
  const realWrite = fs.writeFileSync; let injected = 0;
  try {
    ms.push(await firstRun(sb, base, 'w-3', [[1, false]]));
    const before = fs.readFileSync(settingsFile(sb, 'w-3'), 'utf8');
    assert.equal(JSON.parse(before).autoMemoryDirectory, sb.mem);
    const mb = make(sb, coreWith({}, base, [[5, false]], 'run-b'), 'run-b'); ms.push(mb);
    fs.writeFileSync = function (p, ...rest) {
      if (fwd(p) === fwd(settingsFile(sb, 'w-3'))) { injected += 1; throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); }
      return realWrite.call(this, p, ...rest);
    };
    let stopped;
    try { stopped = await mb.stop({ worker_id: 'w-3', mode: 'kill', timeout_ms: 8000 }); } finally { fs.writeFileSync = realWrite; } // the adopt's rewrite throws; the stop completes
    assert.ok(injected >= 1, 'the rewrite was attempted and failed');
    assert.ok(stopped);
    assert.equal(fs.readFileSync(settingsFile(sb, 'w-3'), 'utf8'), before, 'the old settings, which enable the folder, are still on disk');
    assert.ok(mb._worker('w-3').adoptRefusal, 'the refusal is on the cached worker');
    await assert.rejects(mb.restart({ worker_id: 'w-3', first_turn_timeout_ms: 20000 }), (e) => REFUSED.test(e.message));
    assert.notEqual(mb._worker('w-3').state, 'running');
    assert.equal(settingsOf(sb, 'w-3').autoMemoryDirectory, sb.mem, 'and nothing launched from them');
  } finally { fs.writeFileSync = realWrite; await closeAll(ms, sb); }
});
