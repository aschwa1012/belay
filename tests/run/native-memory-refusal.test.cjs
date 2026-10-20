'use strict';
// native-memory-refusal.test.cjs — follow-ups to the native_memory lever: a refused launch settles the worker as dead (worker_wait
// must not answer the paused or stopped state of the life before), and a folder that is not a directory is refused before anything is
// created, with a failed file write leaving no phantom worker. Driven over the fake executable.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const L = require('../../src/run/launch.cjs');
const NM = require('../../src/run/native-memory.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const fwd = (p) => String(p).replace(/\\/g, '/');

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-nmr-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { d, data: fwd(d), worktree: fwd(path.join(d, 'wt')), mem: fwd(path.join(d, 'mem')) };
}
const mgr = (sb, core, userSettings = path.join(__dirname, 'fixtures', 'user-settings.json')) => createRunManager({
  core, dataDir: sb.data, runId: 'run-nmr', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings },
});
const settingsFile = (sb, id) => path.join(L.workerDir(sb.data, id), 'settings.json');
const settingsOf = (sb, id) => JSON.parse(fs.readFileSync(settingsFile(sb, id), 'utf8'));
const plant = (sb, id) => fs.writeFileSync(settingsFile(sb, id), JSON.stringify({ ...settingsOf(sb, id), autoDreamEnabled: true }));

for (const lever of [false, true]) {
  const tag = lever ? 'lever on' : 'lever off';
  const opts = (sb, id) => ({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: id, ...(lever ? { native_memory: sb.mem } : {}) });

  test(`worker_wait after a refused resume of a parked worker answers dead, not paused (${tag})`, async () => {
    const sb = sandbox(); const core = createFakeCore(); const m = mgr(sb, core); const id = 'w-wpark';
    if (lever) process.env.FAKE_MEMORY_AUTO = 'echo';
    try {
      await m.spawn(opts(sb, id));
      await m.pause({ worker_id: id, by: 'test' });
      assert.equal((await m.wait({ worker_ids: [id], timeout_ms: 5000 })).event, 'paused', 'before the refusal the park is what wait answers');
      plant(sb, id);
      await assert.rejects(m.resume({ worker_id: id, by: 'test' }), (e) => e.code === 'E_NATIVE_MEMORY_MISMATCH');
      assert.equal(core.currentWorker(id).state, 'dead');
      const r = await m.wait({ worker_ids: [id], timeout_ms: 5000 });
      assert.equal(r.event, 'dead');
      assert.equal(r.established_by, 'native_memory_settings_mismatch');
      assert.equal(r.already, true);
    } finally { delete process.env.FAKE_MEMORY_AUTO; await m.shutdown().catch(() => {}); cleanup(sb.d); }
  });

  test(`worker_wait after a refused restart of a stopped worker answers dead, not stopped (${tag})`, async () => {
    const sb = sandbox(); const core = createFakeCore(); const m = mgr(sb, core); const id = 'w-wstop';
    if (lever) process.env.FAKE_MEMORY_AUTO = 'echo';
    try {
      await m.spawn(opts(sb, id));
      await m.stop({ worker_id: id, mode: 'kill', timeout_ms: 8000 });
      assert.equal((await m.wait({ worker_ids: [id], timeout_ms: 5000 })).event, 'stopped');
      plant(sb, id);
      await assert.rejects(m.restart({ worker_id: id, first_turn_timeout_ms: 45000 }), (e) => e.code === 'E_NATIVE_MEMORY_MISMATCH');
      const r = await m.wait({ worker_ids: [id], timeout_ms: 5000 });
      assert.equal(r.event, 'dead');
      assert.equal(r.established_by, 'native_memory_settings_mismatch');
    } finally { delete process.env.FAKE_MEMORY_AUTO; await m.shutdown().catch(() => {}); cleanup(sb.d); }
  });
}

test('prepareFolder and checkFolder: a regular file at the folder or above it is refused, and nothing is created', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-nmr-f-'));
  try {
    const file = path.join(d, 'afile'); fs.writeFileSync(file, 'x');
    for (const bad of [fwd(file), fwd(path.join(file, 'sub', 'mem'))]) {
      for (const fn of [NM.checkFolder, NM.prepareFolder]) {
        assert.throws(() => fn(bad), (e) => e.code === 'E_ARGS' && e.detail.reason === 'not_a_directory' && e.detail.blocking.toLowerCase() === fwd(file).toLowerCase(), bad);
      }
    }
    assert.deepStrictEqual(fs.readdirSync(d), ['afile'], 'no directory was created beside the file');
    assert.doesNotThrow(() => NM.checkFolder(fwd(path.join(d, 'new', 'mem'))), 'an absent folder is fine');
    assert.equal(fs.existsSync(path.join(d, 'new')), false, 'checkFolder creates nothing');
  } finally { cleanup(d); }
});

test('spawn: a native_memory that is an existing file is refused with no worker directory, no row, and the id free for a corrected retry', async () => {
  const sb = sandbox(); const core = createFakeCore(); const m = mgr(sb, core); const id = 'w-file';
  try {
    fs.writeFileSync(sb.mem, 'a file where the folder should be');
    await assert.rejects(m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: id, native_memory: sb.mem }), (e) => e.code === 'E_ARGS' && e.detail.reason === 'not_a_directory');
    assert.equal(fs.existsSync(L.workerDir(sb.data, id)), false, 'no worker directory');
    assert.deepStrictEqual(core.rowsFor(id), [], 'no worker row');
    assert.ok(!m._worker(id), 'no record');
    fs.unlinkSync(sb.mem);
    process.env.FAKE_MEMORY_AUTO = 'echo';
    const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: id, native_memory: sb.mem });
    assert.equal(row.state, 'running', 'the same id spawns once the folder is fine');
  } finally { delete process.env.FAKE_MEMORY_AUTO; await m.shutdown().catch(() => {}); cleanup(sb.d); }
});

test('spawn: a failure while the worker files are written leaves no record and no directory, and a retry with the same id works', async () => {
  const sb = sandbox(); const core = createFakeCore(); const id = 'w-wfail';
  const us = path.join(sb.d, 'user-settings.json');
  fs.writeFileSync(us, '{ not json'); // an unparseable user settings file fails the launch inside the file write
  const m = mgr(sb, core, us);
  try {
    await assert.rejects(m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: id }), (e) => e.code === 'E_ARGS');
    assert.ok(!m._worker(id), 'the record was dropped');
    assert.equal(fs.existsSync(L.workerDir(sb.data, id)), false, 'the directory this spawn created is removed');
    assert.deepStrictEqual(core.rowsFor(id), []);
    fs.writeFileSync(us, '{}');
    const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: id });
    assert.equal(row.state, 'running');
  } finally { await m.shutdown().catch(() => {}); cleanup(sb.d); }
});

test('spawn: a failed file write does not remove a worker directory that existed before the spawn', async () => {
  const sb = sandbox(); const core = createFakeCore(); const id = 'w-keep';
  const us = path.join(sb.d, 'user-settings.json'); fs.writeFileSync(us, '{ not json');
  const m = mgr(sb, core, us);
  try {
    fs.mkdirSync(L.workerDir(sb.data, id), { recursive: true }); fs.writeFileSync(path.join(L.workerDir(sb.data, id), 'keep.txt'), 'k');
    await assert.rejects(m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: id }), (e) => e.code === 'E_ARGS');
    assert.equal(fs.existsSync(path.join(L.workerDir(sb.data, id), 'keep.txt')), true);
    assert.ok(!m._worker(id), 'the record was dropped');
  } finally { await m.shutdown().catch(() => {}); cleanup(sb.d); }
});

// A refusal on the FIRST launch: the worker has no earlier settled life, so only the refusal itself can settle it.
test('worker_wait after a refused first launch answers dead at once, not timed_out', async () => {
  const sb = sandbox(); const core = createFakeCore(); const id = 'w-first';
  const realWrite = core.worker.write;
  // The seam: when the `starting` row is written, the folder is replaced by a file, which prepareFolder then refuses at launch.
  core.worker.write = async (r, ...rest) => {
    const out = await realWrite.call(core.worker, r, ...rest);
    if (r && r.id === id && r.state === 'starting') { fs.rmSync(sb.mem, { recursive: true, force: true }); fs.writeFileSync(sb.mem, 'a file where the folder should be'); }
    return out;
  };
  const m = mgr(sb, core);
  try {
    await assert.rejects(m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: id, native_memory: sb.mem }), (e) => e.code === 'E_ARGS' && e.detail.reason === 'not_a_directory');
    assert.equal(core.currentWorker(id).state, 'dead');
    const t0 = Date.now();
    const r = await m.wait({ worker_ids: [id], timeout_ms: 3000 });
    assert.equal(r.event, 'dead', JSON.stringify(r));
    assert.equal(r.established_by, 'native_memory_folder_refused');
    assert.equal(r.already, true);
    assert.ok(Date.now() - t0 < 2000, 'answered from the settled record, not by waiting out the timeout');
  } finally { await m.shutdown().catch(() => {}); cleanup(sb.d); }
});

test('spawn: an invalid native_memory is refused before a record or a worker directory is made', async () => {
  const sb = sandbox(); const core = createFakeCore(); const m = mgr(sb, core); const id = 'w-early';
  const W = require('../../src/run/worker.cjs'); const real = W.newWorkerRecord; let made = 0;
  W.newWorkerRecord = (...a) => { made++; return real(...a); };
  try {
    fs.writeFileSync(sb.mem, 'a file');
    await assert.rejects(m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: id, native_memory: sb.mem }), (e) => e.code === 'E_ARGS');
    assert.equal(made, 0, 'the check ran in validation, before newWorkerRecord');
  } finally { W.newWorkerRecord = real; await m.shutdown().catch(() => {}); cleanup(sb.d); }
});

test('spawn: a failed file write waits for the worker\'s base-sha lookup, so shutdown never leaves that git child behind', async () => {
  const sb = sandbox(); const core = createFakeCore(); const id = 'w-lookup';
  const us = path.join(sb.d, 'user-settings.json'); fs.writeFileSync(us, '{ not json');
  const m = mgr(sb, core, us);
  const HL = require('../../src/run/head-lookup.cjs'); const real = HL.lookupSha;
  let release; const gate = new Promise((res) => { release = res; });
  let started = false;
  HL.lookupSha = (cwd) => { started = true; return gate.then(() => ({ sha: null, reason: 'stalled' })); };
  try {
    let settled = false;
    const p = m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: id }).then(() => { settled = 'resolved'; }, (e) => { settled = e.code; });
    for (let i = 0; i < 50 && !started; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(started, 'the lookup began with the record');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(settled, false, 'the failed spawn is still waiting on the lookup');
    release();
    await p;
    assert.equal(settled, 'E_ARGS');
    assert.ok(!m._worker(id), 'the record is dropped once the lookup is done');
    assert.equal(fs.existsSync(L.workerDir(sb.data, id)), false);
  } finally { HL.lookupSha = real; release(); await m.shutdown().catch(() => {}); cleanup(sb.d); }
});
