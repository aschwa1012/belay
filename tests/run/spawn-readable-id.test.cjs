'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env);
// A spawn that names no worker_id gets `<agent type or worker>-<n>`, not a uuid: n is the lowest number no row of the store (any run) and no
// directory holds, and a refused spawn gives its number back. A real RunManager over the fake claude and the fake core.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const paths = { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') };

test('spawn without worker_id: readable ids, unique across runs and concurrent spawns, and a failed spawn frees its number', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-rid-')).replace(/\\/g, '/');
  fs.mkdirSync(`${data}/wt`);
  const core = createFakeCore();
  const a = createRunManager({ core, dataDir: data, runId: 'run-a', paths });
  const b = createRunManager({ core, dataDir: data, runId: 'run-b', paths });
  const base = { substrate: 'claude-code', worktree: `${data}/wt`, prompt: 'one' };
  try {
    const [r1, r2] = await Promise.all([a.spawn({ ...base, agent_type: 'coder' }), a.spawn({ ...base, agent_type: 'coder' })]);
    assert.deepStrictEqual([r1.id, r2.id].sort(), ['coder-1', 'coder-2']);
    const r3 = await b.spawn({ ...base, agent_type: 'coder' });
    assert.strictEqual(r3.id, 'coder-3', 'another run of the same store never repeats a taken id');
    assert.strictEqual((await a.spawn({ ...base, agent_type: 'reviewer' })).id, 'reviewer-1');
    assert.match((await a.spawn({ ...base })).id, /^worker-1$/);
    const bad = await a.spawn({ ...base, agent_type: 'coder', effort: 'ultra' }).catch((e) => e);
    assert.strictEqual(bad.code, 'E_ARGS');
    assert.strictEqual((await a.spawn({ ...base, agent_type: 'coder' })).id, 'coder-4', 'a spawn refused on its arguments took no number');
    assert.ok(!fs.readdirSync(`${data}/workers`).some((d) => /^[0-9a-f]{8}-/.test(d)));
  } finally {
    for (const m of [a, b]) { try { await m.shutdown(); } catch { /* best effort */ } }
    cleanup(data);
  }
});

test('a spawn refused by the task check leaves no directory and gives its number back; a named and a generated spawn cannot both take one id', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-rid-')).replace(/\\/g, '/');
  fs.mkdirSync(`${data}/wt`);
  const core = createFakeCore({ failing: { 'task.assign:check': 'E_NOT_FOUND' } });
  const m = createRunManager({ core, dataDir: data, runId: 'run-c', paths });
  const base = { substrate: 'claude-code', worktree: `${data}/wt`, prompt: 'one', task_id: 't-1' };
  try {
    const e = await m.spawn({ ...base, agent_type: 'coder' }).catch((x) => x);
    assert.strictEqual(e.code, 'E_NOT_FOUND', 'the task check refused it');
    assert.deepStrictEqual(fs.existsSync(`${data}/workers`) ? fs.readdirSync(`${data}/workers`) : [], [], 'a refused spawn writes nothing, not even the directory');
    const n = await m.spawn({ substrate: 'claude-code', worktree: `${data}/wt`, prompt: 'one', agent_type: 'coder' });
    assert.strictEqual(n.id, 'coder-1', 'the refused spawn gave its number back');
    // The seam: another spawn takes coder-2 while a named spawn of coder-2 is between its store read and its reservation.
    const list = core.worker.list.bind(core.worker);
    let armed = true;
    core.worker.list = async (a) => { const r = await list(a); if (armed) { armed = false; fs.mkdirSync(`${data}/workers/coder-2`); } return r; };
    const named = await m.spawn({ substrate: 'claude-code', worktree: `${data}/wt`, prompt: 'one', worker_id: 'coder-2' }).catch((x) => x);
    assert.strictEqual(named.code, 'E_ARGS');
    assert.match(named.message, /is taken/);
    assert.ok(fs.existsSync(`${data}/workers/coder-2`), 'the other directory was not removed');
    assert.strictEqual((await m.spawn({ substrate: 'claude-code', worktree: `${data}/wt`, prompt: 'one', agent_type: 'coder' })).id, 'coder-3', 'a generated id skips a directory that is there');
  } finally { try { await m.shutdown(); } catch { /* best effort */ } cleanup(data); }
});
