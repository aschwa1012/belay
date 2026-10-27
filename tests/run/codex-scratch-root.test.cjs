'use strict';
// A Codex reviewer's scratch folder lies outside its worktree, and `-s workspace-write` makes only the worktree writable. The
// launch adds the folder, and only that folder, as an extra writable root (`--add-dir`, codex-cli 0.163.0). Every other launch
// keeps its argv.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('../../src/run/launch.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split(path.sep).join('/');
const FAKE_CODEX = path.join(__dirname, 'fakes', 'fake-codex.cjs').split(path.sep).join('/');

test('codexLaunchArgv adds the scratch folder once, forward-slashed, before the prompt, and nothing without one', () => {
  const base = { worktree: 'C:/w', adapterArgs: ['a.cjs'], prompt: '- p', model: 'm' };
  const without = L.codexLaunchArgv(base);
  assert.ok(!without.includes('--add-dir'));
  const withDir = L.codexLaunchArgv({ ...base, scratchDir: ['C:', 'data', 'scratch', 'r', 'rev1'].join(path.win32.sep) });
  assert.strictEqual(withDir.filter((a) => a === '--add-dir').length, 1);
  assert.strictEqual(withDir[withDir.indexOf('--add-dir') + 1], 'C:/data/scratch/r/rev1');
  assert.deepStrictEqual(withDir.filter((a) => a !== '--add-dir' && a !== 'C:/data/scratch/r/rev1'), without, 'the rest of the argv is unchanged');
  assert.deepStrictEqual(withDir.slice(-2), ['--', '- p']);
  assert.strictEqual(withDir[withDir.indexOf('-s') + 1], 'workspace-write');
});

test('a spawned Codex reviewer gets its scratch folder as the one extra root; a coder and a Claude Code reviewer get none', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-cx-scratch-')).split(path.sep).join('/');
  const worktree = `${data}/wt`;
  fs.mkdirSync(worktree, { recursive: true });
  const m = createRunManager({ core: createFakeCore(), dataDir: data, runId: 'run-cxs', paths: { claudeExe: FAKE, codexExe: FAKE_CODEX, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  const argsOf = (id) => JSON.parse(fs.readFileSync(`${data}/workers/${id}/argv.json`, 'utf8')).spec.args;
  try {
    const rev = await m.spawn({ substrate: 'codex', worktree, prompt: 'one', worker_id: 'rev1', agent_type: 'reviewer' });
    const args = argsOf('rev1');
    assert.strictEqual(args.filter((a) => a === '--add-dir').length, 1);
    assert.strictEqual(args[args.indexOf('--add-dir') + 1], rev.scratch.split(path.sep).join('/'));
    assert.strictEqual(args[args.indexOf('--add-dir') + 1], `${data}/scratch/run-cxs/rev1`);
    await m.spawn({ substrate: 'codex', worktree, prompt: 'one', worker_id: 'cod1', agent_type: 'coder' });
    assert.ok(!argsOf('cod1').includes('--add-dir'));
    await m.spawn({ substrate: 'claude-code', worktree, prompt: 'one', worker_id: 'rev2', agent_type: 'reviewer' });
    assert.ok(!argsOf('rev2').includes('--add-dir'));
  } finally { await m.shutdown().catch(() => {}); cleanup(data); }
});
