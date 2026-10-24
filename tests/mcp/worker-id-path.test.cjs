'use strict';
// worker-id-path.test.cjs — a worker id is a path segment (workers/<id>/). worker_spawn's worker_id, the run manager's argument
// check, the one function that derives a worker directory and the adapter's own argv all refuse an id that could leave workers/,
// before any file is written. Sandboxed: every file under an mkdtemp directory; the one child is the adapter, waited for.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const T = require('../../src/mcp/tools.cjs');
const L = require('../../src/run/launch.cjs');
const { validateSpawnArgs } = require('../../src/run/spawn-args.cjs');
const W = require('../../src/run/worker.cjs');

const fwd = (p) => p.split('\\').join('/');
const sandbox = (tag) => fwd(fs.mkdtempSync(path.join(os.tmpdir(), `wid-${tag}-`)));
const MCP = path.resolve(__dirname, '..', '..', 'src', 'mcp', 'belay-mcp.cjs');
const isShape = (e) => e.code === 'E_ARGS' && /must be a letter or digit/.test(e.message);

test('worker_spawn refuses a worker_id that is a path at the MCP boundary, and accepts a plain one', () => {
  for (const id of ['../../escaped', '../../other/.claude', 'a/b', 'a\\b', 'NUL', '']) {
    assert.throws(() => T.validateArgs('worker_spawn', { substrate: 'claude-code', worktree: 'C:/w', prompt: 'p', worker_id: id }, { role: 'orchestrator' }), (e) => isShape(e) && e.detail.field === 'worker_id', JSON.stringify(id));
  }
  assert.throws(() => T.validateArgs('worker_spawn', { substrate: 'claude-code', worktree: 'C:/w', prompt: 'p', worker_id: 7 }, { role: 'orchestrator' }), (e) => e.code === 'E_ARGS');
  T.validateArgs('worker_spawn', { substrate: 'claude-code', worktree: 'C:/w', prompt: 'p', worker_id: 'coder-1' }, { role: 'orchestrator' });
  T.validateArgs('worker_spawn', { substrate: 'claude-code', worktree: 'C:/w', prompt: 'p' }, { role: 'orchestrator' });
});

test('the run manager refuses the id before any file, and no worker directory is ever derived from it', () => {
  const root = sandbox('m1');
  const data = `${root}/data`;
  fs.mkdirSync(data);
  const id = '../../escaped';
  assert.throws(() => validateSpawnArgs({ substrate: 'claude-code', worktree: root, prompt: 'p', permission_prompt: false, permit_wait_ms: 600000, effort: null, worker_id: id }), isShape);
  assert.throws(() => L.workerDir(data, id), isShape);
  assert.throws(() => W.newWorkerRecord({ id, substrate: 'claude-code', worktree: root, dataDir: data, captureBase: false }), isShape);
  assert.strictEqual(fs.existsSync(`${root}/escaped`), false, 'a directory was created outside the data dir');
  validateSpawnArgs({ substrate: 'claude-code', worktree: root, prompt: 'p', permission_prompt: false, permit_wait_ms: 600000, effort: null, worker_id: null });
  assert.strictEqual(L.workerDir(data, 'w1'), `${data}/workers/w1`);
});

test('a traversing id cannot reach another project\'s .claude/settings.json', () => {
  const root = sandbox('m1b');
  const data = `${root}/data`;
  fs.mkdirSync(`${root}/other/.claude`, { recursive: true });
  fs.mkdirSync(data);
  fs.writeFileSync(`${root}/other/.claude/settings.json`, '{"operator":"kept"}\n');
  assert.throws(() => L.workerDir(data, '../../other/.claude'), isShape);
  assert.strictEqual(fs.readFileSync(`${root}/other/.claude/settings.json`, 'utf8'), '{"operator":"kept"}\n');
});

test('the adapter refuses a --run or --worker-id that is a path, exit 2, before it writes anything', () => {
  const data = `${sandbox('argv')}/data`;
  for (const [flag, args] of [['--run', ['--role', 'orchestrator', '--run', '../r']], ['--worker-id', ['--role', 'worker', '--run', 'r1', '--worker-id', '../../w']]]) {
    const r = spawnSync(process.execPath, [MCP, ...args, '--data', data, '--no-embed'], { encoding: 'utf8', input: '', timeout: 60000 });
    assert.strictEqual(r.status, 2, `${flag}: exit ${r.status} ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`${flag} must be a letter or digit`));
  }
  assert.strictEqual(fs.existsSync(data), false, 'the refused adapter created the data dir');
});
