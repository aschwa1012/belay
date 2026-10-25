// tools.test.cjs — A8: every one of the nineteen tools is called against the fake core and the shape
// of its proof column in ADR 0010 §2 is asserted on the returned row. Also the return rule of §6: a
// result carries structuredContent and isError false, or isError true with a code, never both, never
// a bare status word.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { launch, sandboxDir } = require('./rpc.cjs');

const has = (row, keys, tool) => {
  for (const k of keys) assert.ok(Object.prototype.hasOwnProperty.call(row, k), `${tool}: the row is missing ${k}; got ${Object.keys(row).join(', ')}`);
};

// A successful result never carries an error body, and an error result never carries a row.
function assertOk(r, tool) {
  assert.strictEqual(r.isError, false, `${tool}: expected a row, got ${JSON.stringify(r.structuredContent)}`);
  assert.ok(r.structuredContent && typeof r.structuredContent === 'object', `${tool}: structuredContent is an object`);
  assert.strictEqual(r.structuredContent.error, undefined, `${tool}: a row carries no error code`);
  assert.ok(Array.isArray(r.content) && r.content[0].type === 'text', `${tool}: content mirrors the row as text`);
  assert.deepStrictEqual(JSON.parse(r.content[0].text), r.structuredContent, `${tool}: text and structuredContent agree`);
  return r.structuredContent;
}

async function withRole(role, t, fn, workerId) {
  const data = sandboxDir(`tools-${role}`);
  const a = launch({ role, data, workerId: role === 'worker' ? (workerId || 'wk-1') : undefined });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();
  return fn(a, data);
}

test('A8 the memory tools return the rows their proof columns name', async (t) => {
  await withRole('orchestrator', t, async (a) => {
    has(assertOk(await a.call('memory_store', { text: 'a fact', tags: ['x'] }), 'memory_store'),
      ['id', 'action', 'namespace', 'worker_id', 'updated_at'], 'memory_store');
    assert.strictEqual(assertOk(await a.call('memory_store', { text: 'a fact' }), 'memory_store').action, 'inserted');

    has(assertOk(await a.call('memory_retrieve', { id: 'mem-1' }), 'memory_retrieve'), ['id'], 'memory_retrieve');
    assert.strictEqual(assertOk(await a.call('memory_retrieve', { id: 'missing' }), 'memory_retrieve').found, false);

    const s = assertOk(await a.call('memory_search', { query: 'a fact', k: 3 }), 'memory_search');
    has(s, ['results', 'scanned', 'model', 'dim'], 'memory_search');
    has(s.results[0], ['id', 'score', 'worker_id', 'tags', 'provenance'], 'memory_search result');

    has(assertOk(await a.call('memory_list', { limit: 5 }), 'memory_list'), ['rows'], 'memory_list');

    const d = assertOk(await a.call('memory_delete', { id: 'mem-1' }), 'memory_delete');
    has(d, ['id', 'deleted'], 'memory_delete');
    assert.strictEqual(typeof d.deleted, 'boolean');
    assert.strictEqual(assertOk(await a.call('memory_delete', { id: 'missing' }), 'memory_delete').deleted, false);

    const st = assertOk(await a.call('memory_stats', {}), 'memory_stats');
    has(st, ['owner'], 'memory_stats');
    has(st.owner, ['pid', 'pipe', 'alive', 'established_by'], 'memory_stats owner');
  });
});

test('A8 status returns the truth ladder, each rung naming what established it', async (t) => {
  await withRole('orchestrator', t, async (a, data) => {
    const s = assertOk(await a.call('status', {}), 'status');
    has(s, ['verdict', 'data_dir', 'established_by', 'ms', 'rungs', 'run', 'workers'], 'status');
    assert.ok(['alive', 'degraded', 'stopped'].includes(s.verdict), 'verdict is one of the three');
    assert.strictEqual(s.data_dir, data, 'status names the data dir from argv');
    assert.deepStrictEqual(s.rungs.map((r) => r.rung),
      ['configured', 'store-present', 'owner-alive', 'run-alive', 'worker-alive', 'worker-responsive']);
    for (const r of s.rungs) has(r, ['rung', 'established', 'by', 'ms', 'detail'], 'status rung');
    for (const w of s.workers) has(w, ['id', 'substrate', 'state', 'pid', 'pid_alive', 'last_event_age_ms', 'turns', 'input_tokens', 'output_tokens', 'cost_usd'], 'status worker');
    // A dead system is a valid answer, so status is also callable in worker role.
    assert.strictEqual((await a.call('status', { deep: false })).isError, false);
  });
});

test('A8 task_list returns lease holder, expiry and whether that holder is alive', async (t) => {
  await withRole('orchestrator', t, async (a) => {
    const r = assertOk(await a.call('task_list', { states: ['assigned'] }), 'task_list');
    has(r, ['tasks'], 'task_list');
    const row = r.tasks[0];
    has(row, ['id', 'spec_head', 'state', 'lease', 'holder_pid_alive', 'last_checkpoint_id', 'last_checkpoint_at'], 'task_list row');
    has(row.lease, ['id', 'holder', 'holder_role', 'expires_at', 'expired'], 'task_list lease');
    // ADR 0058 amendment 3: the compact row is the default; view debug is the core's row, whole.
    const full = assertOk(await a.call('task_list', { states: ['assigned'], view: 'debug' }), 'task_list debug').tasks[0];
    has(full, ['id', 'spec', 'state', 'lease', 'holder_pid_alive', 'last_checkpoint_id', 'last_checkpoint_at'], 'task_list debug row');
  });
});

test('A8 briefing returns line and doc, both inside their byte ceilings', async (t) => {
  await withRole('orchestrator', t, async (a) => {
    const b = assertOk(await a.call('briefing', { task_id: 'task-1' }), 'briefing');
    has(b, ['line', 'doc'], 'briefing');
    has(b.line, ['text', 'bytes', 'task_id', 'task_state', 'lease_id', 'checkpoint_id'], 'briefing line');
    has(b.doc, ['text', 'bytes', 'sections'], 'briefing doc');
    assert.ok(b.line.bytes <= 400, `resume line is ${b.line.bytes} bytes`);
    assert.ok(b.doc.bytes <= 4096, `resume doc is ${b.doc.bytes} bytes`);
    assert.ok(b.doc.sections.some((s) => /unverified/.test(s)), 'the doc labels what a worker merely said');
  });
});

test('A8 the four worker tools return the process facts their proof columns name', async (t) => {
  await withRole('orchestrator', t, async (a, data) => {
    const w = assertOk(await a.call('worker_spawn', { substrate: 'claude-code', worktree: data, prompt: 'go', view: 'debug' }), 'worker_spawn');
    has(w, ['id', 'substrate', 'pid', 'session_id', 'adapter_pid', 'argv_hash', 'started_at', 'state', 'ready_ms'], 'worker_spawn');
    // ADR 0058: the default answer is the compact one, and nothing in it is invented.
    const c = assertOk(await a.call('worker_spawn', { substrate: 'claude-code', worktree: data, prompt: 'go' }), 'worker_spawn');
    has(c, ['id', 'substrate', 'pid', 'session_id', 'state', 'worktree', 'started_at', 'ready_ms', 'effort', 'tools'], 'worker_spawn compact');
    for (const k of ['argv_hash', 'written_at', 'input_tokens', '__paths']) assert.ok(!(k in c), `the compact answer leaves out ${k}`);
    assert.strictEqual(w.state, 'running', 'a spawned worker is running only after its ready event');

    const m = assertOk(await a.call('worker_message', { worker_id: w.id, text: 'carry on' }), 'worker_message');
    has(m, ['worker_id', 'channel', 'bytes', 'pid', 'turn'], 'worker_message');
    assert.strictEqual(m.bytes, Buffer.byteLength('carry on', 'utf8'));

    const s = assertOk(await a.call('worker_stop', { worker_id: w.id, mode: 'graceful' }), 'worker_stop');
    has(s, ['worker_id', 'pid', 'exit_code', 'exit_signal', 'ms_to_exit', 'graceful', 'killed', 'session_id'], 'worker_stop');
    assert.strictEqual(s.graceful, true);
    assert.strictEqual(assertOk(await a.call('worker_stop', { worker_id: w.id, mode: 'kill' }), 'worker_stop').killed, true);

    const r = assertOk(await a.call('worker_restart', { worker_id: w.id }), 'worker_restart');
    has(r, ['worker_id', 'branch', 'reason', 'old_pid', 'new_pid', 'session_id', 'checkpoint_id', 'first_turn_usage', 'first_turn_timed_out'], 'worker_restart');
    assert.ok(['resume', 'replace'].includes(r.branch), 'the branch is resume or replace');
    assert.ok(r.reason.length > 0, 'the branch states why');
  });
});

test('A8 task_create and task_assign return the task row and both leases', async (t) => {
  await withRole('orchestrator', t, async (a) => {
    const c = assertOk(await a.call('task_create', { spec: 'do the thing', files_owned: ['src/a.js'], acceptance: { commands: [{ argv: ['node', '--test'] }], files_within_owned: true } }), 'task_create');
    has(c, ['id', 'spec', 'acceptance', 'files_owned', 'state'], 'task_create');
    assert.strictEqual(c.state, 'open');

    const asg = assertOk(await a.call('task_assign', { task_id: c.id, worker_id: 'wk-1' }), 'task_assign');
    has(asg, ['task', 'old_lease', 'new_lease', 'paused_worker'], 'task_assign');
    has(asg.new_lease, ['id', 'task_id', 'holder', 'holder_role', 'expires_at'], 'task_assign new_lease');
    assert.strictEqual(asg.task.state, 'assigned');
  });
});

test('A8 task_evaluate returns the task row with its results, and refuses a missing task_id or a non-string base at the boundary (worktree defaults in the core, ADR 0053)', async (t) => {
  await withRole('orchestrator', t, async (a, data) => {
    const e = assertOk(await a.call('task_evaluate', { task_id: 'task-1', worktree: data, base: 'main' }), 'task_evaluate');
    has(e, ['id', 'state', 'results'], 'task_evaluate');
    has(e.results, ['evaluated_at', 'executable', 'passed', 'checks'], 'task_evaluate results');
    for (const [args, re] of [[{ worktree: data }, /needs task_id/], [{ task_id: 't', worktree: data, base: 7 }, /base must be string/]]) {
      const r = await a.call('task_evaluate', args);
      assert.strictEqual(r.isError, true, `task_evaluate ${JSON.stringify(args)}: expected a refusal`);
      assert.strictEqual(r.structuredContent.error, 'E_ARGS');
      assert.match(r.structuredContent.message, re);
    }
  });
});

test('A8 the three worker-role tools return their rows', async (t) => {
  await withRole('worker', t, async (a) => {
    const l = assertOk(await a.call('lease_renew', { lease_id: 'lease-1' }), 'lease_renew');
    has(l, ['id', 'task_id', 'holder', 'expires_at'], 'lease_renew');

    const rel = assertOk(await a.call('lease_release', { lease_id: 'lease-1', reason: 'done' }), 'lease_release');
    has(rel, ['id', 'state', 'last_checkpoint_id'], 'lease_release');
    assert.strictEqual(rel.state, 'released');

    const ck = assertOk(await a.call('checkpoint_write', { task_id: 'task-1', turn: 3, files_touched: ['src/a.js'], summary: 'did a thing', next_step: 'do the next', open_questions: ['is it right?'] }), 'checkpoint_write');
    has(ck, ['id', 'task_id', 'worker_id', 'turn', 'files_touched', 'stated', 'source'], 'checkpoint_write');
    assert.strictEqual(ck.source, 'worker', 'a worker checkpoint is recorded as the worker\'s claim');
    assert.strictEqual(ck.worker_id, 'wk-1', 'the worker id comes from argv');
    has(ck.stated, ['summary', 'next_step', 'open_questions'], 'checkpoint_write stated');
  });
});

test('§6: an error result is isError true with a code and carries no row', async (t) => {
  await withRole('orchestrator', t, async (a) => {
    // Every code in the contract's vocabulary, not a sample of it: a sample is what let the adapter's
    // hand-kept copy of the list drift when the core gained E_DEPENDENCY_OPEN and E_DEPENDENCY_CYCLE,
    // so the refusal reached the orchestrator as E_INTERNAL (found by A4, not here).
    const { CODES } = require('../../src/core/errors.cjs');
    for (const code of [...CODES]) {
      const r = await a.call('memory_search', { query: 'x', __error: code });
      assert.strictEqual(r.isError, true, `${code}: expected an error result`);
      assert.strictEqual(r.structuredContent.error, code, 'the core error code is preserved unchanged');
      assert.ok(typeof r.structuredContent.message === 'string' && r.structuredContent.message.length > 0, 'the message is a sentence');
      assert.deepStrictEqual(r.structuredContent.detail, { echoed: true }, 'the detail passes through');
      assert.strictEqual(r.structuredContent.id, undefined, 'an error carries no row');
      assert.deepStrictEqual(JSON.parse(r.content[0].text), r.structuredContent);
    }
    // A refusal from the RunManager keeps its code too.
    const sp = await a.call('worker_spawn', { substrate: 'codex', worktree: '.', prompt: 'x', __error: 'E_NO_READY' });
    assert.strictEqual(sp.isError, true);
    assert.strictEqual(sp.structuredContent.error, 'E_NO_READY');

    // A code outside the api.md §6 vocabulary becomes E_INTERNAL rather than reaching the orchestrator
    // as something it cannot act on. The original code is then the only thing that says what actually
    // went wrong, so it is kept in detail.underlying_code whether or not the error also carried a
    // detail of its own, and the detail it carried is kept beside it rather than displaced.
    for (const code of ['ENOENT', 'SQLITE_BUSY', 'ERR_MODULE_NOT_FOUND']) {
      const odd = await a.call('memory_retrieve', { id: 'x', __error: code });
      assert.strictEqual(odd.isError, true, `${code}: expected an error result`);
      assert.strictEqual(odd.structuredContent.error, 'E_INTERNAL', `${code}: mapped into the vocabulary`);
      assert.strictEqual(odd.structuredContent.detail.underlying_code, code, `${code}: the real code survives`);
      assert.strictEqual(odd.structuredContent.detail.echoed, true, `${code}: the error's own detail survives beside it`);
    }
  });
});

test('an unknown code keeps underlying_code whatever detail came with it', async (t) => {
  await withRole('orchestrator', t, async (a) => {
    // Every shape a CoreError's detail can take, driven through the wire with the fake's __detail
    // convention. The finding this closes: an unknown code with a detail lost the code entirely,
    // leaving the orchestrator a bare E_INTERNAL and no way to tell one failure from another.
    const cases = [
      { why: 'no detail at all', args: { __error: 'ENOENT', __no_detail: true }, expect: { underlying_code: 'ENOENT' } },
      { why: 'an object detail', args: { __error: 'ENOENT', __detail: { path: 'x', errno: -4058 } }, expect: { path: 'x', errno: -4058, underlying_code: 'ENOENT' } },
      { why: 'a string detail', args: { __error: 'SQLITE_BUSY', __detail: 'a sentence' }, expect: { detail: 'a sentence', underlying_code: 'SQLITE_BUSY' } },
      { why: 'an array detail', args: { __error: 'ENOENT', __detail: ['a', 'b'] }, expect: { detail: ['a', 'b'], underlying_code: 'ENOENT' } },
      { why: 'a detail claiming the field itself', args: { __error: 'ENOENT', __detail: { underlying_code: 'E_FAKE' } }, expect: { underlying_code: 'ENOENT' } },
    ];
    for (const c of cases) {
      const r = await a.call('memory_retrieve', { id: 'x', ...c.args });
      assert.strictEqual(r.isError, true, c.why);
      assert.strictEqual(r.structuredContent.error, 'E_INTERNAL', c.why);
      assert.deepStrictEqual(r.structuredContent.detail, c.expect, c.why);
    }
    // A code that is in the vocabulary is not an unknown code, so nothing is stamped over its detail.
    const known = await a.call('memory_retrieve', { id: 'x', __error: 'E_NOT_FOUND', __detail: { task_id: 't' } });
    assert.strictEqual(known.structuredContent.error, 'E_NOT_FOUND');
    assert.deepStrictEqual(known.structuredContent.detail, { task_id: 't' }, 'a known code keeps its detail untouched');
    const bare = await a.call('memory_retrieve', { id: 'x', __error: 'E_NOT_FOUND', __no_detail: true });
    assert.strictEqual(bare.structuredContent.detail, undefined, 'and a known code with no detail invents none');
  });
});

test('arguments are checked at the boundary, before anything is called', async (t) => {
  await withRole('orchestrator', t, async (a, data) => {
    const cases = [
      ['memory_store', {}, /needs text/],
      ['memory_retrieve', {}, /needs id/],
      ['worker_stop', { worker_id: 'w' }, /needs mode/],
      ['worker_stop', { worker_id: 'w', mode: 'terminate' }, /mode must be one of graceful, kill/],
      ['worker_spawn', { worktree: data, prompt: 'x' }, /needs substrate/],
      ['worker_spawn', { substrate: 'perl', worktree: data, prompt: 'x' }, /substrate must be one of claude-code, codex/],
      ['task_assign', { task_id: 't' }, /needs worker_id/],
      ['memory_search', { query: 'x', k: 2.5 }, /k must be integer/],
      ['memory_list', { limit: 'ten' }, /limit must be integer/],
      ['task_create', { spec: 'x', files_owned: 'src/a.js' }, /files_owned must be array/],
    ];
    for (const [name, args, re] of cases) {
      const r = await a.call(name, args);
      assert.strictEqual(r.isError, true, `${name} ${JSON.stringify(args)}: expected a refusal`);
      assert.strictEqual(r.structuredContent.error, 'E_ARGS', `${name}: E_ARGS`);
      assert.match(r.structuredContent.message, re);
      assert.strictEqual(r.structuredContent.detail.tool, name, 'the detail names the tool');
    }
    // A role refusal outranks an argument refusal: the worker never learns the shape of a tool it
    // may not call.
    const w = launch({ role: 'worker', data: `${data}-w`, workerId: 'wk-1' });
    t.after(async () => { await w.close(); w.kill(); });
    await w.initialize();
    assert.strictEqual((await w.call('worker_stop', {})).structuredContent.error, 'E_ROLE');
  });
});

test('no tool returns a bare status word', async (t) => {
  await withRole('orchestrator', t, async (a, data) => {
    const calls = [
      ['memory_store', { text: 'x' }], ['memory_retrieve', { id: 'm' }], ['memory_search', { query: 'x' }],
      ['memory_list', {}], ['memory_delete', { id: 'm' }], ['memory_stats', {}], ['status', {}],
      ['task_list', {}], ['briefing', { task_id: 't' }],
      ['worker_spawn', { substrate: 'codex', worktree: data, prompt: 'x' }],
      ['worker_message', { worker_id: 'w', text: 'x' }], ['worker_stop', { worker_id: 'w', mode: 'kill' }],
      ['worker_restart', { worker_id: 'w' }], ['task_create', { spec: 'x' }],
      ['task_assign', { task_id: 't', worker_id: 'w' }],
      ['task_evaluate', { task_id: 't', worktree: data }],
    ];
    for (const [name, args] of calls) {
      const r = assertOk(await a.call(name, args), name);
      assert.notStrictEqual(r, 'ok');
      assert.strictEqual(r.ok, undefined, `${name}: no bare ok field`);
      assert.strictEqual(r.success, undefined, `${name}: no bare success field`);
      assert.strictEqual(r.status, undefined, `${name}: no bare status field`);
      assert.ok(Object.keys(r).length >= 1, `${name}: the row has substance`);
    }
  });
});

test('S11 worker_spawn takes effort: five levels in the listing, a bad level refused at the boundary, a good one reaches the manager', async (t) => {
  const tools = require('../../src/mcp/tools.cjs');
  const { EFFORT_LEVELS } = require('../../src/run/launch.cjs');
  const spawn = tools.toolsFor('orchestrator').find((x) => x.name === 'worker_spawn');
  assert.deepStrictEqual(spawn.inputSchema.properties.effort, { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] });
  assert.deepStrictEqual(spawn.inputSchema.properties.effort.enum, EFFORT_LEVELS, 'the literal list equals launch.cjs EFFORT_LEVELS');
  assert.throws(() => tools.validateArgs('worker_spawn', { substrate: 'claude-code', worktree: '/w', prompt: 'x', effort: 'huge' }),
    (e) => e.code === 'E_ARGS' && /effort must be one of/.test(e.message));
  assert.doesNotThrow(() => tools.validateArgs('worker_spawn', { substrate: 'claude-code', worktree: '/w', prompt: 'x', effort: 'high' }));
  await withRole('orchestrator', t, async (a, data) => {
    const bad = await a.call('worker_spawn', { substrate: 'claude-code', worktree: data, prompt: 'x', effort: 'huge' });
    assert.strictEqual(bad.isError, true);
    assert.strictEqual(bad.structuredContent.error, 'E_ARGS');
    assert.match(bad.structuredContent.message, /effort/);
    const w = assertOk(await a.call('worker_spawn', { substrate: 'claude-code', worktree: data, prompt: 'x', effort: 'xhigh', view: 'debug' }), 'worker_spawn');
    assert.strictEqual(w.__effort, 'xhigh', 'the manager received effort: xhigh');
    assert.strictEqual(assertOk(await a.call('worker_spawn', { substrate: 'claude-code', worktree: data, prompt: 'x', view: 'debug' }), 'worker_spawn').__effort, null);
  });
});

test('worker_spawn refuses a caller-chosen id with the knowledge agent prefix, at the boundary', async (t) => {
  const tools = require('../../src/mcp/tools.cjs');
  const base = { substrate: 'claude-code', worktree: '/w', prompt: 'x' };
  for (const id of ['knowledge-run-1', 'knowledge-']) {
    assert.throws(() => tools.validateArgs('worker_spawn', { ...base, worker_id: id }),
      (e) => e.code === 'E_ARGS' && e.detail.field === 'worker_id' && e.detail.reason === 'reserved' && /are reserved for belay's own workers/.test(e.message), id);
  }
  for (const id of ['w1', 'my-knowledge-1', 'Knowledge-x']) assert.doesNotThrow(() => tools.validateArgs('worker_spawn', { ...base, worker_id: id }), id);
  await withRole('orchestrator', t, async (a, data) => {
    const r = await a.call('worker_spawn', { substrate: 'claude-code', worktree: data, prompt: 'x', worker_id: 'knowledge-run-x' });
    assert.strictEqual(r.isError, true);
    assert.strictEqual(r.structuredContent.error, 'E_ARGS');
    assert.strictEqual(r.structuredContent.detail.field, 'worker_id');
  });
});
