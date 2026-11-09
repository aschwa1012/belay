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
    assert.strictEqual((await a.spawn({ ...base, agent_type: 'coder' })).id, 'coder-4', 'a refused spawn took no number');
    assert.ok(!fs.readdirSync(`${data}/workers`).some((d) => /^[0-9a-f]{8}-/.test(d)));
  } finally {
    for (const m of [a, b]) { try { await m.shutdown(); } catch { /* best effort */ } }
    cleanup(data);
  }
});
