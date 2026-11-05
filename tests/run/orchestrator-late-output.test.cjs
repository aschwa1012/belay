'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env); // scratch never lands in an indexed folder, even for a bare `node file`
// The run settles on the orchestrator's 'exit', which can come before its last stdout and stderr chunks are read. Those chunks
// belong in stream.jsonl and stderr.txt. They must not be lost, and they must never be written to the fd numbers the run
// closed when it settled, because the process may already have handed those numbers to other files. The seam: the real spawn
// is wrapped to keep the child handle, files are opened once the run has settled (taking the freed numbers), and then a
// stdout and a stderr chunk are delivered on the child's own streams, exactly as a late read delivers them.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const P = require('../../src/run/process.cjs');
const { runOrchestrator } = require('../../src/run/orchestrator.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const fwd = (p) => String(p).split(path.sep).join('/');
const NOREADY = fwd(path.join(__dirname, 'fakes', 'fake-claude-noready.cjs'));

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const f = findFile(p, name); if (f) return f; } else if (e.name === name) return p;
  }
  return null;
}

test('output read after the run settled is appended to its own files, never to the fd numbers it closed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-orch-late-'));
  fs.mkdirSync(path.join(root, 'wt'));
  fs.mkdirSync(path.join(root, '.belay'));
  const core = createFakeCore();
  core.worker = { ...core.worker, list: async () => ({ workers: [] }) };
  const realSpawn = P.spawnWorker;
  let child = null;
  P.spawnWorker = (opts) => { child = realSpawn(opts); return child; };
  const saved = process.env.BELAY_CLAUDE_EXE;
  process.env.BELAY_CLAUDE_EXE = NOREADY;
  const others = [];
  try {
    const result = await runOrchestrator({
      core, runId: 'run-late', dataDir: fwd(path.join(root, '.belay')),
      spec: {
        worktree: fwd(path.join(root, 'wt')), promptText: 'hello', orchestratorDir: fwd(path.join(root, 'orch')), model: 'claude-sonnet-5',
        allowedTools: null, startupTimeoutMs: 8000, timeoutMs: 20000, mcpToolTimeoutMs: 60000, pollMs: 50, closeGraceMs: 3000,
      },
      onAttached: async () => ({ ok: true }),
    });
    assert.match(result.ended_by, /before a ready event/, 'the run settled on the exit');
    // The numbers the run closed are the lowest free ones now: these files take them.
    for (let i = 0; i < 4; i++) {
      const f = path.join(root, `other-${i}.txt`);
      others.push({ f, fd: fs.openSync(f, 'a') });
    }
    child.stdout.emit('data', Buffer.from('{"type":"late-line"}\n'));
    child.stderr.emit('data', Buffer.from('late stderr chunk\n'));
    for (const o of others) fs.closeSync(o.fd);
    for (const o of others) assert.strictEqual(fs.readFileSync(o.f, 'utf8'), '', `${path.basename(o.f)} took a closed fd number and received the run's output`);
    const orch = path.join(root, 'orch');
    assert.match(fs.readFileSync(findFile(orch, 'stream.jsonl'), 'utf8'), /\{"type":"late-line"\}\n$/, 'the late stdout line is in stream.jsonl');
    assert.match(fs.readFileSync(findFile(orch, 'stderr.txt'), 'utf8'), /late stderr chunk\n$/, 'the late stderr chunk is in stderr.txt');
  } finally {
    P.spawnWorker = realSpawn;
    if (saved === undefined) delete process.env.BELAY_CLAUDE_EXE; else process.env.BELAY_CLAUDE_EXE = saved;
    cleanup(root);
  }
});
