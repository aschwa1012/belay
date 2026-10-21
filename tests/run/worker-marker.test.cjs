'use strict';
// worker-marker.test.cjs — the identity-bind stopgap, spawn side: the run manager puts the worker's own id into the worker's
// environment as BELAY_WORKER_ID (the CLI's guard reads it), on a fresh spawn and on a restart. Real manager, the fake core and
// the fake Claude, which echoes its environment to stderr.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/[\\]/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 >= timeoutMs) return null;
    await sleep(100);
  }
}

test('spawn and restart: the worker environment carries BELAY_WORKER_ID, its own id, and not an id inherited from the manager\'s process', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-wmark-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  const data = d.replace(/[\\]/g, '/');
  const worktree = path.join(d, 'wt').replace(/[\\]/g, '/');
  const m = createRunManager({ core: createFakeCore(), dataDir: data, runId: 'run-test', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  const saved = { echo: process.env.FAKE_ECHO_MCP_TOOL_TIMEOUT, id: process.env.BELAY_WORKER_ID };
  process.env.FAKE_ECHO_MCP_TOOL_TIMEOUT = '1';
  process.env.BELAY_WORKER_ID = 'w-from-up-tree';
  const echoed = async (id, minCount) => until(() => {
    const f = path.join(data, 'workers', id, 'stderr.txt');
    const t = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    const all = t.match(/FAKE_ENV .*BELAY_WORKER_ID=\S+/g) || [];
    return all.length >= minCount ? all : null;
  }, 8000);
  try {
    await m.spawn({ substrate: 'claude-code', worktree, prompt: 'hello', worker_id: 'w-mark' });
    const first = await echoed('w-mark', 1);
    assert.ok(first, 'the fake never echoed its environment');
    assert.match(first[0], /BELAY_WORKER_ID=w-mark$/);
    const r = await m.restart({ worker_id: 'w-mark' });
    assert.notStrictEqual(r.restarted, false, JSON.stringify(r));
    const both = await echoed('w-mark', 2);
    assert.ok(both, 'the relaunch never echoed');
    assert.match(both[1], /BELAY_WORKER_ID=w-mark$/);
  } finally {
    if (saved.echo === undefined) delete process.env.FAKE_ECHO_MCP_TOOL_TIMEOUT; else process.env.FAKE_ECHO_MCP_TOOL_TIMEOUT = saved.echo;
    if (saved.id === undefined) delete process.env.BELAY_WORKER_ID; else process.env.BELAY_WORKER_ID = saved.id;
    await m.shutdown(); cleanup(data);
  }
});
