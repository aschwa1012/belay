'use strict';
// worker-id-taken.test.cjs — a caller-named worker id is fresh only when no row in the store has it under any case (another run's row would be
// restated, and NTFS gives W1 and w1 one directory) and no directory holds it. A fresh id still spawns.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { cleanup } = require('../core/helpers.cjs');

const BS = String.fromCharCode(92);
const fwd = (p) => p.split(BS).join('/');
const FAKE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));

test('a spawn refuses an id a row already has (any case, any run) or a directory holds, and a fresh id spawns', async () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-wid-taken-'));
  const data = fwd(path.join(sb, 'data'));
  const worktree = fwd(path.join(sb, 'wt'));
  fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(worktree, { recursive: true });
  const runId = 'run-wid-taken-' + process.pid;
  const core = await openCore({ dataDir: data, caller: { role: 'orchestrator', run_id: runId, pid: process.pid }, embed: false });
  let m = null;
  try {
    await core.run.attach({ adapter_pid: process.pid });
    m = createRunManager({ core, dataDir: data, runId, paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
    await core.worker.write({ id: 'w1', state: 'dead', substrate: 'claude-code', run_id: 'some-other-run' });
    const before = (await core.worker.list({})).workers.length;
    for (const id of ['w1', 'W1']) {
      await assert.rejects(m.spawn({ substrate: 'claude-code', worktree, prompt: 'go', worker_id: id }), (e) => e.code === 'E_ARGS' && e.detail.existing_id === 'w1' && e.detail.existing_run_id === 'some-other-run' && /taken/.test(e.message), id);
    }
    fs.mkdirSync(path.join(data, 'workers', 'orphan'), { recursive: true });
    await assert.rejects(m.spawn({ substrate: 'claude-code', worktree, prompt: 'go', worker_id: 'orphan' }), (e) => e.code === 'E_ARGS' && /directory exists/.test(e.message));
    assert.strictEqual((await core.worker.list({})).workers.length, before, 'no row was written');
    assert.strictEqual(fs.existsSync(path.join(data, 'workers', 'w1')), false, 'no directory was created for the taken id');
    const ok = await m.spawn({ substrate: 'claude-code', worktree, prompt: 'go', worker_id: 'fresh1' });
    assert.strictEqual(ok.id, 'fresh1');
  } finally { try { if (m) await m.shutdown(); } finally { try { await core.shutdownOwner(); } finally { await core.close(); cleanup(sb); } } }
});

test('two concurrent spawns of W1 and w1 in one run: exactly one succeeds and the other is E_ARGS', async () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-wid-case-'));
  const data = fwd(path.join(sb, 'data'));
  const worktree = fwd(path.join(sb, 'wt'));
  fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(worktree, { recursive: true });
  const runId = 'run-wid-case-' + process.pid;
  const core = await openCore({ dataDir: data, caller: { role: 'orchestrator', run_id: runId, pid: process.pid }, embed: false });
  let m = null;
  try {
    await core.run.attach({ adapter_pid: process.pid });
    m = createRunManager({ core, dataDir: data, runId, paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
    const go = (id) => m.spawn({ substrate: 'claude-code', worktree, prompt: 'go', worker_id: id });
    const r = await Promise.allSettled([go('W1'), go('w1')]);
    const ok = r.filter((x) => x.status === 'fulfilled');
    const bad = r.filter((x) => x.status === 'rejected');
    assert.strictEqual(ok.length, 1, JSON.stringify(r.map((x) => x.status)));
    assert.strictEqual(bad[0].reason.code, 'E_ARGS');
    assert.match(bad[0].reason.message, /already exists/);
    assert.strictEqual((await core.worker.list({})).workers.length, 1, 'one row');
  } finally { try { if (m) await m.shutdown(); } finally { try { await core.shutdownOwner(); } finally { await core.close(); cleanup(sb); } } }
});
