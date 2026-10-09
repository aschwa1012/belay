'use strict';
// write-rerun-deadline.test.cjs — a re-run memory.store shares its first attempt's limit, so both attempts
// stay inside the 120 s MCP tool timeout. permission.wait keeps its full limit.

const { test } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');
const { err } = core('errors.cjs');

const ARGS = { namespace: 'n', text: 't' };
const lost = () => err('E_OWNER_LOST', 'stub', { sent: true, may_have_committed: true });

async function open() {
  const dir = sandbox();
  const c = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  c._pingBeforeVector = async () => {};
  return { dir, c };
}

// Installs a stub client per _ensureWriter call; `first` and `second` are the two call bodies.
function stubs(c, limits, first, second) {
  let n = 0;
  c._ensureWriter = async () => {
    n++;
    if (n === 2 && second.onEnsure) { second.onEnsure(); return; }
    const body = n === 1 ? first : second;
    c.client = { connected: true, close: async () => {}, call: async (method, params, opts) => { limits.push(opts.timeoutMs); return body(method, params, opts); } };
  };
}

async function withOffset(fn) {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try { return await fn(ms => { offset = ms; }); } finally { Date.now = realNow; }
}

test('a memory.store re-run after a lost owner gets only the time its first attempt left', async () => {
  const { dir, c } = await open();
  try {
    const limits = [];
    stubs(c, limits, async () => { await new Promise(r => setTimeout(r, 300)); throw lost(); }, async () => ({ id: 'x', action: 'inserted' }));
    const out = await c._write('memory.store', ARGS);
    assert.strictEqual(limits.length, 2);
    assert.strictEqual(limits[0], 100000);
    assert.ok(limits[1] <= 99700 && limits[1] >= 90000, String(limits[1]));
    assert.ok(out.rerun_after_owner_lost);
  } finally { cleanup(dir); }
});

test('a memory.store whose first attempt used its whole limit is not re-run', async () => {
  const { dir, c } = await open();
  try {
    await withOffset(async setOffset => {
      const limits = [];
      stubs(c, limits, async () => { setOffset(99500); throw lost(); }, async () => ({ id: 'x' }));
      await assert.rejects(c._write('memory.store', ARGS), e => {
        assert.strictEqual(e.code, 'E_OWNER_LOST');
        assert.strictEqual(e.detail.outcome, 'unknown');
        assert.strictEqual(e.detail.may_have_committed, true);
        assert.strictEqual(e.detail.rerun, 'skipped');
        return true;
      });
      assert.strictEqual(limits.length, 1);
    });
  } finally { cleanup(dir); }
});

test('an in-process memory.store re-run is bounded by the time its first attempt left', async () => {
  const { dir, c } = await open();
  try {
    await withOffset(async setOffset => {
      const limits = [];
      stubs(c, limits, async () => { setOffset(97000); throw lost(); }, {
        onEnsure: () => { c.client = null; c.owner = { stopped: false, engine: { handle: () => new Promise(() => {}) } }; },
      });
      const started = process.hrtime.bigint();
      let timer;
      const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('guard: _write still pending after 15 s')), 15000); });
      try {
        await assert.rejects(Promise.race([c._write('memory.store', ARGS), guard]), e => e.code === 'E_TIMEOUT');
      } finally { clearTimeout(timer); }
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(ms < 10000, 'elapsed ' + ms);
    });
  } finally { cleanup(dir); }
});

test('a lost, sent permission.wait is still re-run with its full limit', async () => {
  const { dir, c } = await open();
  try {
    const limits = [];
    stubs(c, limits, async () => { throw lost(); }, async () => ({ decision: 'allow' }));
    await c._write('permission.wait', { timeout_ms: 1000 });
    assert.deepStrictEqual(limits, [6000, 6000]);
  } finally { cleanup(dir); }
});
