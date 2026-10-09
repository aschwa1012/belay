'use strict';
// wait under MCP_TOOL_TIMEOUT — ADR 0029 decision 5. A wait longer than the client's tool timeout fails at
// the client, so the adapter caps it at that timeout less 10,000 ms (at least 1,000 ms) and the answer
// names the cap. Every case sets the variable itself and restores process.env in a finally.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-waitcap-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: d.replace(/\\/g, '/'), worktree: path.join(d, 'wt').replace(/\\/g, '/') };
}

function mgr(sb) {
  return createRunManager({
    core: createFakeCore(), dataDir: sb.data, runId: 'run-waitcap',
    paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
  });
}

// A worker that has finished its first turn, then marked mid-turn by the record's own flag (as wait.test.cjs does).
async function midTurn(id) {
  const sb = sandbox();
  const m = mgr(sb);
  await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hello', worker_id: id });
  await m._waitTurn(id, 8000);
  m._worker(id).turnEnded = false;
  return m;
}

async function withEnv(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'MCP_TOOL_TIMEOUT');
  const old = process.env.MCP_TOOL_TIMEOUT;
  if (value === undefined) delete process.env.MCP_TOOL_TIMEOUT; else process.env.MCP_TOOL_TIMEOUT = value;
  try { return await fn(); } finally {
    if (had) process.env.MCP_TOOL_TIMEOUT = old; else delete process.env.MCP_TOOL_TIMEOUT;
  }
}

test('a request above the cap comes back timed_out near the cap, naming requested and used', async () => {
  const m = await midTurn('c1');
  try {
    await withEnv('12000', async () => {
      const r = await m.wait({ worker_ids: ['c1'], timeout_ms: 600000 });
      assert.equal(r.timed_out, true);
      assert.ok(r.waited_ms >= 1900 && r.waited_ms < 4000, `waited ${r.waited_ms} ms, expected near 2000`);
      assert.equal(r.timeout_capped.requested_ms, 600000);
      assert.equal(r.timeout_capped.used_ms, 2000);
      assert.match(r.timeout_capped.by, /MCP_TOOL_TIMEOUT 12000 ms less a 10,000 ms margin \(ADR 0029\)/);
      assert.deepEqual(r.busy.map((b) => b.worker_id), ['c1']);
    });
  } finally { await m.shutdown(); }
});

test('a request under the cap is unchanged and carries no timeout_capped', async () => {
  const m = await midTurn('c2');
  try {
    await withEnv('12000', async () => {
      const r = await m.wait({ worker_ids: ['c2'], timeout_ms: 300 });
      assert.equal(r.timed_out, true);
      assert.ok(r.waited_ms >= 280 && r.waited_ms < 1500, `waited ${r.waited_ms} ms`);
      assert.equal('timeout_capped' in r, false);
    });
  } finally { await m.shutdown(); }
});

test('the default request (110,000 ms) is capped too: cap 15,000 gives 5,000', async () => {
  const m = await midTurn('c3');
  try {
    await withEnv('15000', async () => {
      const r = await m.wait({ worker_ids: ['c3'] });
      assert.equal(r.timed_out, true);
      assert.ok(r.waited_ms >= 4900 && r.waited_ms < 7000, `waited ${r.waited_ms} ms, expected near 5000`);
      assert.equal(r.timeout_capped.requested_ms, 110000);
      assert.equal(r.timeout_capped.used_ms, 5000);
    });
  } finally { await m.shutdown(); }
});

test('the floor is 1,000 ms: a cap at or under 10,000 still waits 1,000', async () => {
  const m = await midTurn('c4');
  try {
    await withEnv('5000', async () => {
      const r = await m.wait({ worker_ids: ['c4'], timeout_ms: 600000 });
      assert.equal(r.timed_out, true);
      assert.equal(r.timeout_capped.used_ms, 1000);
      assert.ok(r.waited_ms >= 900 && r.waited_ms < 3000, `waited ${r.waited_ms} ms`);
    });
  } finally { await m.shutdown(); }
});

test('an event under a capped wait carries timeout_capped, and so do the already-finished and settled answers', async () => {
  const sb = sandbox();
  const m = mgr(sb);
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hello', worker_id: 'c5' });
    await m._waitTurn('c5', 8000);
    await withEnv('12000', async () => {
      const already = await m.wait({ worker_ids: ['c5'], timeout_ms: 600000 });
      assert.equal(already.already, true);
      assert.equal(already.event, 'turn_end');
      assert.deepEqual(already.timeout_capped, { requested_ms: 600000, used_ms: 2000, by: already.timeout_capped.by });

      m._worker('c5').turnEnded = false;
      const p = m.wait({ worker_ids: ['c5'], timeout_ms: 600000 });
      await m.message({ worker_id: 'c5', text: 'again' });
      const r = await p;
      assert.equal(r.event, 'turn_end');
      assert.equal(r.turn, 2);
      assert.equal(r.already, undefined);
      assert.equal(r.timed_out, false);
      assert.equal(r.timeout_capped.used_ms, 2000);

      await m.stop({ worker_id: 'c5', mode: 'graceful' });
      const settled = await m.wait({ worker_ids: ['c5'], timeout_ms: 600000 });
      assert.equal(settled.already, true);
      assert.equal(settled.timeout_capped.requested_ms, 600000);
    });
  } finally { await m.shutdown(); }
});

test('absent, empty, garbage, zero and negative values leave a wait uncapped', async () => {
  const m = await midTurn('c6');
  try {
    for (const v of [undefined, '', '   ', 'abc', '12000ms', '1.5e4', '0', '-12000']) {
      await withEnv(v, async () => {
        const r = await m.wait({ worker_ids: ['c6'], timeout_ms: 200 });
        assert.equal(r.timed_out, true, `value ${JSON.stringify(v)}`);
        assert.equal('timeout_capped' in r, false, `value ${JSON.stringify(v)} must not cap`);
        assert.ok(r.waited_ms >= 180 && r.waited_ms < 1500, `value ${JSON.stringify(v)}: waited ${r.waited_ms} ms`);
      });
    }
    // Uncapped is also the shape of an event answer: no key.
    await withEnv('abc', async () => {
      m._worker('c6').turnEnded = true;
      const r = await m.wait({ worker_ids: ['c6'], timeout_ms: 600000 });
      assert.equal('timeout_capped' in r, false);
    });
  } finally { await m.shutdown(); }
});
