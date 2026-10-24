'use strict';
// spawn-tools-adopt.test.cjs — ADR 0024 amendment 4 (proposed). A narrowed worker's built-in tool list is a column of its worker row. A restart by
// another adapter (adopt) takes the list from the row and never from the worker's argv.json, which the worker can edit: a deleted, corrupt or
// widened file cannot widen the worker, and a row with no record for a worker whose argv.json shows a narrowed list fails closed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const USER_SETTINGS = path.join(__dirname, 'fixtures', 'user-settings.json').replace(/\\/g, '/');
const SLOW = 45000;

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-spawn-tools-adopt-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { root: d, data: d.replace(/\\/g, '/'), worktree: path.join(d, 'wt').replace(/\\/g, '/') };
}
const mgr = (sb, core) => createRunManager({ core, dataDir: sb.data, runId: 'run-tools-adopt', paths: { claudeExe: FAKE, userSettings: USER_SETTINGS } });
const argvFile = (sb, id) => path.join(sb.data, 'workers', id, 'argv.json');
const toolsFlag = (sb, id) => { const a = JSON.parse(fs.readFileSync(argvFile(sb, id), 'utf8')).spec.args; return a[a.indexOf('--tools') + 1]; };
const lastRow = (core, id) => { const r = core.rowsFor(id); return r[r.length - 1]; };

// Spawn a narrowed worker with one manager and stop it, as a session ending would; hand back what a second adapter finds.
async function ended(id, mutate) {
  const sb = sandbox(); const core = createFakeCore(); const first = mgr(sb, core);
  const born = await first.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: id, allowed_tools: ['Read', 'Grep', 'mcp__belay'] });
  await first.stop({ worker_id: id, mode: 'kill', timeout_ms: 8000 });
  assert.deepStrictEqual(born.surface.builtins, ['Grep', 'Read']);
  assert.deepStrictEqual(lastRow(core, id).tools, ['Read', 'Grep'], 'the row records the narrowed list');
  if (mutate) mutate({ sb, core, id });
  return { sb, core, second: mgr(sb, core), first };
}
const done = async (...ms) => { for (const m of ms) await m.shutdown().catch(() => {}); };

const TAMPER = {
  'argv.json deleted': ({ sb, id }) => fs.rmSync(argvFile(sb, id)),
  'argv.json corrupt': ({ sb, id }) => fs.writeFileSync(argvFile(sb, id), '{ not json'),
  'argv.json edited wider (Read,Bash)': ({ sb, id }) => {
    const j = JSON.parse(fs.readFileSync(argvFile(sb, id), 'utf8')); const a = j.spec.args; a[a.indexOf('--tools') + 1] = 'Read,Bash';
    fs.writeFileSync(argvFile(sb, id), JSON.stringify(j));
  },
  'argv.json edited to WebFetch': ({ sb, id }) => {
    const j = JSON.parse(fs.readFileSync(argvFile(sb, id), 'utf8')); const a = j.spec.args; a[a.indexOf('--tools') + 1] = 'WebFetch';
    fs.writeFileSync(argvFile(sb, id), JSON.stringify(j));
  },
};
for (const [name, mutate] of Object.entries(TAMPER)) {
  test(`adopt: ${name}; the restarted worker has exactly the row's list, never six`, async () => {
    const e = await ended('w-t', mutate);
    try {
      const r = await e.second.restart({ worker_id: 'w-t', first_turn_timeout_ms: SLOW });
      assert.deepStrictEqual(r.surface.builtins, ['Grep', 'Read']);
      assert.strictEqual(toolsFlag(e.sb, 'w-t'), 'Read,Grep', 'argv.json is rewritten from the row');
      assert.deepStrictEqual(lastRow(e.core, 'w-t').tools, ['Read', 'Grep']);
    } finally { await done(e.second, e.first); fs.rmSync(e.sb.root, { recursive: true, force: true }); }
  });
}

test('adopt: the row wins when it and a widened argv.json disagree, in the other direction too (row six, argv.json narrowed)', async () => {
  const e = await ended('w-t', ({ core, id }) => { lastRow(core, id).tools = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash']; });
  try {
    const r = await e.second.restart({ worker_id: 'w-t', first_turn_timeout_ms: SLOW });
    assert.deepStrictEqual(r.surface.builtins, ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write']);
  } finally { await done(e.second, e.first); fs.rmSync(e.sb.root, { recursive: true, force: true }); }
});

test('adopt: a row with no tools record for a worker whose argv.json is narrowed fails closed (E_ARGS), a stop still goes through, and nothing is widened', async () => {
  const e = await ended('w-t', ({ core, id }) => { delete lastRow(core, id).tools; });
  try {
    const before = core_rows(e.core);
    await assert.rejects(e.second.restart({ worker_id: 'w-t', first_turn_timeout_ms: SLOW }), (x) => x.code === 'E_ARGS' && /no tools record/.test(x.message));
    assert.strictEqual(toolsFlag(e.sb, 'w-t'), 'Read,Grep', 'argv.json was not rewritten wider');
    for (const row of e.core.rowsFor('w-t').slice(before)) assert.ok(!('tools' in row) || row.tools == null || row.tools.length < 6, 'a refused adopt never writes six');
    await e.second.stop({ worker_id: 'w-t', mode: 'kill', timeout_ms: 8000 }); // a stop is not refused
  } finally { await done(e.second, e.first); fs.rmSync(e.sb.root, { recursive: true, force: true }); }
});
function core_rows(core) { return core.rowsFor('w-t').length; }

test('adopt: a legacy row with no record and an argv.json that shows no narrowing relaunches with the full six', async () => {
  const sb = sandbox(); const core = createFakeCore(); const first = mgr(sb, core);
  try {
    await first.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w-leg' });
    await first.stop({ worker_id: 'w-leg', mode: 'kill', timeout_ms: 8000 });
    delete lastRow(core, 'w-leg').tools;
    const second = mgr(sb, core);
    const r = await second.restart({ worker_id: 'w-leg', first_turn_timeout_ms: SLOW });
    assert.deepStrictEqual(r.surface.builtins, ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write']);
    await done(second);
  } finally { await done(first); fs.rmSync(sb.root, { recursive: true, force: true }); }
});

test('real core: the tools column round-trips as an array on the row, and survives the stop row', async () => {
  const { openCore } = require('../../src/core/index.cjs');
  const sb = sandbox(); const runId = 'run-tools-real-' + process.pid;
  const core = await openCore({ dataDir: sb.data, caller: { role: 'orchestrator', run_id: runId, pid: process.pid }, embed: false });
  let m = null;
  try {
    await core.run.attach({ adapter_pid: process.pid });
    m = createRunManager({ core, dataDir: sb.data, runId, paths: { claudeExe: FAKE, userSettings: USER_SETTINGS } });
    const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'go', worker_id: 'w-real', allowed_tools: ['Read', 'Grep', 'mcp__belay'] });
    assert.deepStrictEqual(row.tools, ['Read', 'Grep']);
    await m.stop({ worker_id: 'w-real', mode: 'kill', timeout_ms: 8000 });
    assert.deepStrictEqual((await core.worker.get({ worker_id: 'w-real' })).tools, ['Read', 'Grep']);
  } finally {
    if (m) await m.shutdown();
    try { await core.shutdownOwner(); } finally { await core.close(); fs.rmSync(sb.root, { recursive: true, force: true }); }
  }
});
