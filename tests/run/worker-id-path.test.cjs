'use strict';
// worker-id-path.test.cjs — a worker id becomes a directory under the data dir, so one grammar guards it at the MCP boundary,
// RunManager.spawn, the core worker write and the layout join. A traversal id writes nothing: no directory, no row, and the
// repo's settings file is untouched.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { cleanup } = require('../core/helpers.cjs');
const tools = require('../../src/mcp/tools.cjs');
const L = require('../../src/run/launch.cjs');
const { isPathId } = require('../../src/core/path-id.cjs');

const BS = String.fromCharCode(92); const BSRE = new RegExp(BS + BS, 'g'); // the host mangles backslashes in scripts
const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(BSRE, '/');
const BAD = ['../x', '..', 'a/../b', 'a/b', 'a' + BS + 'b', '..' + BS + 'x', '/etc/x', 'C:/x', 'C:' + BS + 'x', '.hidden', '-lead', 'a' + String.fromCharCode(0) + 'b', 'a b', '', 'x'.repeat(65), 'a..b', 'w1.', 'CON', 'nul.txt', 'com1'];
const GOOD = ['w1', 'wchk', 'knowledge-run-1', 'scrub-run-1-lx4k2', 'archreview-3f2a9c1e-aaaa-bbbb-cccc-1234567890ab-lx4k2', 'notereview-r-1', 'a.b_c-d', 'x'.repeat(64), '3f2a9c1e-aaaa-bbbb-cccc-1234567890ab'];

test('the grammar accepts belay ids and refuses separators, drive paths, dot-leading, NUL and over-long ids', () => {
  for (const g of GOOD) assert.ok(isPathId(g), g);
  for (const b of BAD) assert.ok(!isPathId(b), JSON.stringify(b));
  assert.ok(!isPathId(null) && !isPathId(7) && !isPathId(undefined));
});

test('layer 1, the MCP boundary: every tool naming a worker refuses a bad id', () => {
  for (const b of BAD.filter((x) => x !== '')) {
    for (const tool of ['worker_spawn', 'worker_restart', 'worker_stop', 'worker_message', 'worker_wait', 'resume_prepare']) {
      const args = tool === 'worker_wait' ? { worker_ids: [b] } : tool === 'worker_message' ? { worker_id: b, text: 't' } : tool === 'worker_stop' ? { worker_id: b, mode: 'graceful' } : tool === 'worker_spawn' ? { substrate: 'claude-code', worktree: '/w', prompt: 'p', worker_id: b } : { worker_id: b };
      if (!tools.schemaOf(tool)) continue;
      assert.throws(() => tools.validateArgs(tool, args, { role: 'orchestrator' }), (e) => e.code === 'E_ARGS' && e.detail && e.detail.reason === 'bad_id', `${tool} ${JSON.stringify(b)}`);
    }
  }
  for (const g of GOOD.filter((x) => !/^(scrub|archreview|notereview|knowledge)-/.test(x))) {
    assert.doesNotThrow(() => tools.validateArgs('worker_spawn', { substrate: 'claude-code', worktree: '/w', prompt: 'p', worker_id: g }, { role: 'orchestrator' }), g);
  }
});

test('layers 2 to 4: spawn, the core write and the layout join write nothing for a traversal id', async () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-wid-'));
  const data = path.join(sb, 'data').replace(BSRE, '/');
  const worktree = path.join(sb, 'wt').replace(BSRE, '/');
  const repoClaude = path.join(sb, 'repo', '.claude');
  fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(worktree, { recursive: true }); fs.mkdirSync(repoClaude, { recursive: true });
  const target = path.join(repoClaude, 'settings.json');
  fs.writeFileSync(target, '{"mine":true}');
  const runId = 'run-wid-' + process.pid;
  const core = await openCore({ dataDir: data, caller: { role: 'orchestrator', run_id: runId, pid: process.pid }, embed: false });
  try {
    await core.run.attach({ adapter_pid: process.pid });
    const m = createRunManager({ core, dataDir: data, runId, paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
    const evil = path.relative(path.join(data, 'workers'), path.join(sb, 'repo', '.claude')).replace(BSRE, '/'); // ../../repo/.claude
    const ids = [evil, '../x', 'a\b', '/abs', '.dot', 'a\0b', 'x'.repeat(65)];
    const before = (await core.worker.list({})).workers.length;
    const snapshot = () => fs.readdirSync(sb, { recursive: true }).map(String).sort().join('|');
    const tree = snapshot();
    for (const id of ids) {
      await assert.rejects(m.spawn({ substrate: 'claude-code', worktree, prompt: 'go', worker_id: id }), (e) => e.code === 'E_ARGS' && /^spawn worker_id/.test(e.message), `spawn ${JSON.stringify(id)}`);
      await assert.rejects(core.worker.write({ id, state: 'starting', substrate: 'claude-code' }), (e) => e.code === 'E_ARGS' && /^worker.write: /.test(e.message), `write ${JSON.stringify(id)}`);
      assert.throws(() => L.workerDir(data, id), (e) => e.code === 'E_ARGS' && /^worker_id /.test(e.message), `workerDir ${JSON.stringify(id)}`);
    }
    assert.strictEqual((await core.worker.list({})).workers.length, before, 'no row was written');
    assert.strictEqual(snapshot(), tree, 'no directory or file was created');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"mine":true}', 'the repo settings file is untouched');
    for (const id of ['wok', 'scrub-run-1-lx4k2']) assert.ok(L.workerDir(data, id).endsWith('/workers/' + id));
  } finally { try { await core.shutdownOwner(); } finally { await core.close(); cleanup(sb); } }
});
