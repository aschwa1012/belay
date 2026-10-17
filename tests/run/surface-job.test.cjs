'use strict';
// surface-job.test.cjs — the ADR 0024 surface gate for belay's own job workers (reserved id prefixes). Their adapter lists no belay tool by
// design, so the gate expects none and exactly the job's built-ins. The fake follows its argv (--tools, --mcp-config), so the gate runs
// through the real launch path: a real run found every job failing at launch while the old fake hid it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const S = require('../../src/run/surface.cjs');
const { PREFIXES } = require('../../src/run/job-prefixes.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const fwd = (p) => String(p).replace(/\\/g, '/');
const JOB_TOOLS = ['Read', 'Glob', 'Grep'];

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-surface-job-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: fwd(d), worktree: fwd(path.join(d, 'wt')) };
}
const mgr = (sb, core) => createRunManager({
  core, dataDir: sb.data, runId: 'run-surface-job',
  paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
});
const ready = (tools) => ({ tools, plugins: [{ source: 'agents-md@builtin' }], memory_paths: null });

for (const prefix of PREFIXES) {
  test(`${prefix} job passes the surface check through the real launch path, with no belay tool`, async () => {
    const sb = sandbox();
    const m = mgr(sb, createFakeCore());
    try {
      const r = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: `${prefix}t1`, allowed_tools: JOB_TOOLS, tools: JOB_TOOLS });
      assert.ok(r, 'the spawn returned');
      const rec = m._worker(`${prefix}t1`);
      assert.deepStrictEqual(rec.readyEvidence.builtins, [...JOB_TOOLS].sort());
      assert.deepStrictEqual(rec.readyEvidence.belay_tools, []);
    } finally {
      await m.shutdown();
      cleanup(sb.data);
    }
  });
}

test('the ready gate: a job id passes with no belay tool, an ordinary worker id with the same init fails', () => {
  const R = require('../../src/run/ready.cjs');
  const init = { claude_code_version: '2.1.290', mcp_servers: [{ name: 'belay', status: 'connected' }], ...ready(JOB_TOOLS) };
  assert.ok(R.verifyClaudeReady({ substrate: 'claude-code', id: 'notereview-x', tools: JOB_TOOLS }, init).ok);
  const plain = R.verifyClaudeReady({ substrate: 'claude-code', id: 'w-plain', tools: JOB_TOOLS }, init);
  assert.ok(!plain.ok && /no mcp__belay__\* tool is listed/.test(plain.reason), plain.reason);
  assert.ok(!R.verifyClaudeReady({ substrate: 'claude-code' }, init).ok, 'the orchestrator has no job id');
});

test('checkSurface: a job expects zero belay tools and exactly its built-ins; an ordinary worker still needs one', () => {
  const job = { job: true, tools: JOB_TOOLS };
  assert.ok(S.checkSurface(ready(JOB_TOOLS), job).ok);
  const withBelay = S.checkSurface(ready([...JOB_TOOLS, 'mcp__belay__memory_store']), job);
  assert.ok(!withBelay.ok && /lists no belay tool/.test(withBelay.reason), withBelay.reason);
  const extra = S.checkSurface(ready([...JOB_TOOLS, 'Bash']), job);
  assert.ok(!extra.ok && /extra built-in tool\(s\).*Bash/.test(extra.reason), extra.reason);
  const missing = S.checkSurface(ready(['Read', 'Grep']), job);
  assert.ok(!missing.ok && /missing built-in tool\(s\).*Glob/.test(missing.reason), missing.reason);
  const foreign = S.checkSurface(ready([...JOB_TOOLS, 'mcp__other__x']), job);
  assert.ok(!foreign.ok && /not under mcp__belay__/.test(foreign.reason), foreign.reason);
  const memory = S.checkSurface({ ...ready(JOB_TOOLS), memory_paths: { auto: 'C:/m' } }, job);
  assert.ok(!memory.ok);
  const ordinary = S.checkSurface(ready(JOB_TOOLS), { tools: JOB_TOOLS });
  assert.ok(!ordinary.ok && /no mcp__belay__\* tool is listed/.test(ordinary.reason), ordinary.reason);
});
