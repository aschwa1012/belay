// long-lived-owner.test.cjs — ADR 0053 amendment 2: only a long-lived owner starts the process-snapshot probe a merge's
// owner_boot reads, so the two openers that make one say so: `belay run` and an orchestrator adapter ask for
// ownerOpts.longLived, and a worker adapter does not. Each opener runs as its own process against a fake core that records
// the options it was called with.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { launch, sandboxDir, ROOT } = require('./rpc.cjs');

const FAKE = path.resolve(__dirname, 'fake-core-open-log.cjs').split(path.sep).join('/');
const opens = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('an orchestrator adapter opens its core with a long-lived owner; a worker adapter does not', async (t) => {
  for (const [role, want] of [['orchestrator', true], ['worker', null]]) {
    const dir = sandboxDir(`ll-${role}`);
    const log = `${dir}/opens.jsonl`;
    const a = launch({ role, data: `${dir}/data`, workerId: role === 'worker' ? 'wk-1' : undefined, env: { BELAY_FAKE_CORE: FAKE, BELAY_TEST_OPEN_LOG: log } });
    t.after(async () => { await a.close(); a.kill(); });
    await a.initialize();
    const r = await a.call('task_list', {});
    assert.strictEqual(r.isError, false, JSON.stringify(r.structuredContent));
    const seen = opens(log);
    assert.ok(seen.length >= 1, `${role}: the adapter opened no core`);
    for (const o of seen) {
      assert.strictEqual(o.role, role);
      assert.strictEqual(o.ownerOpts ? o.ownerOpts.longLived : null, want, `${role}: ${JSON.stringify(o)}`);
    }
  }
});

test('belay run opens its core with a long-lived owner', async () => {
  const dir = sandboxDir('ll-run');
  const log = `${dir}/opens.jsonl`;
  fs.mkdirSync(`${dir}/wt`, { recursive: true });
  fs.writeFileSync(`${dir}/prompt.txt`, 'hi\n');
  const spec = `${dir}/spec.json`;
  fs.writeFileSync(spec, JSON.stringify({ on_embedder_failure: 'continue', worktree: `${dir}/wt`, prompt_file: `${dir}/prompt.txt`, startup_timeout_ms: 1000, orchestrator_dir: `${dir}/orch` }));
  // The fake refuses right after recording, so the run stops at its openCore and launches nothing.
  const env = { ...process.env, BELAY_FAKE_CORE: FAKE, BELAY_TEST_OPEN_LOG: log, BELAY_TEST_OPEN_THROW: '1', BELAY_CLAUDE_EXE: `${ROOT}/tests/run/fakes/fake-claude-noready.cjs` };
  const r = await new Promise((resolve) => {
    const c = spawn(process.execPath, [`${ROOT}/src/cli/belay.cjs`, 'run', spec, '--data', `${dir}/.belay`], { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; c.stderr.on('data', (d) => { stderr += d; });
    c.on('exit', (code) => resolve({ code, stderr }));
  });
  assert.notStrictEqual(r.code, 0, 'the fake refused the open, so the run cannot succeed');
  const seen = opens(log);
  assert.ok(seen.length >= 1, `belay run opened no core: ${r.stderr}`);
  assert.deepStrictEqual(seen[0], { role: 'operator', ownerOpts: { longLived: true } });
});
