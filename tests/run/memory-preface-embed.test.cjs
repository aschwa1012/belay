'use strict';
// memory-preface-embed.test.cjs — the first-message index uses vector search. When a worker is spawned or relaunched the run
// manager has the store owner embed the task's own text (memory.embedQuery, with the worker id), passes the vectors to
// memory.index, and records one JSON receipt on index_injected: { hybrid, queries: [{ label, ms, ok }], failure? }. A failure
// follows ADR 0034: under `stop` the spawn is refused (the `starting` row written dead, nothing assigned or sent); under
// `continue`, past the spawn's own bound, or when the mode is unknown, the index is keyword-only and the receipt names the
// failure. The embedding time is not the worker's readiness time. The core is a double; the real hybrid ranking is tested in
// tests/core/memory-embed-query.test.cjs.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MP = require('../../src/run/memory-preface.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const PROMPT = 'implement the thing';
const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');

const okQuery = (label = 'task', ms = 37) => ({ label, ok: true, ms, query_embedding: [0, 1, 0], embedding_model: 'stub', dim: 3 });
const okEmbed = async () => ({ queries: [okQuery()], on_embedder_failure: 'stop', embed_ms: 37 });
const failEmbed = (mode, over = {}) => async () => ({ queries: [{ label: 'task', ok: false, ms: 12, code: 'E_MODEL_ABSENT', message: 'the model is gone', cause: 'dead', embedder: true, ...over }], on_embedder_failure: mode, embed_ms: 12 });

function makeCore({ embed, index } = {}) {
  const calls = [];
  const events = [];
  const core = {
    memory: {
      events: async () => ({ events: [] }),
      recordEvent: async (a) => { calls.push({ method: 'recordEvent', args: a }); events.push(a); return a; },
      index: index || (async (a) => {
        calls.push({ method: 'index', args: a });
        const vec = (a.query_embeddings || []).length > 0;
        return { text: 'INDEX a b', bytes: 9, row_ids: ['a', 'b'], dropped: 0, over_budget: false, sha256: 'f'.repeat(64), relevance: { semantic: vec ? 'ran' : 'not_requested', keyword: 'ran', semantic_contributed: vec } };
      }),
    },
  };
  if (embed) core.memory.embedQuery = async (a) => { calls.push({ method: 'embedQuery', args: a }); return embed(a); };
  return { core, calls, events };
}
const ctxOf = (core, levers) => ({ core, runId: 'run-x', memoryLevers: { first_message_index: true, index_bytes: 900, project: 'proj', ...levers } });
const W = () => ({ id: 'w1', taskId: 't1' });
const names = (calls) => calls.map((c) => c.method);
const detail = (ev) => JSON.parse(ev.message);

test('the index passes the task text\'s vector with its label and model; the receipt says hybrid with each query\'s time', async () => {
  const { core, calls, events } = makeCore({ embed: okEmbed });
  const text = await MP.memoryPreface(W(), ctxOf(core), PROMPT);
  assert.strictEqual(text, 'INDEX a b\n\n');
  const emb = calls.find((c) => c.method === 'embedQuery').args;
  assert.deepStrictEqual(emb, { task_id: 't1', worker_id: 'w1', timeout_ms: MP.SPAWN_EMBED_MS }, 'the task is named, never its text: the core reads it');
  const idx = calls.find((c) => c.method === 'index').args;
  assert.deepStrictEqual(idx.query_embeddings, [{ vector: [0, 1, 0], model: 'stub', label: 'task' }]);
  assert.strictEqual(idx.query, PROMPT, 'the keyword side keeps the prompt');
  assert.deepStrictEqual(names(calls), ['embedQuery', 'index', 'recordEvent'], 'the embedding is made before the index is asked');
  assert.strictEqual(events[0].kind, 'index_injected');
  assert.strictEqual(events[0].ok, 1);
  assert.deepStrictEqual(detail(events[0]), { hybrid: true, queries: [{ label: 'task', ms: 37, ok: true }] });
});

test('a relaunch (no prompt) embeds the same task text, so a resumed worker gets a hybrid index', async () => {
  const { core, calls, events } = makeCore({ embed: okEmbed });
  const out = await MP.relaunch(W(), ctxOf(core), 'resume line');
  assert.match(out, /INDEX a b/);
  assert.deepStrictEqual(calls.find((c) => c.method === 'embedQuery').args.task_id, 't1');
  assert.strictEqual(calls.find((c) => c.method === 'index').args.query, undefined);
  assert.strictEqual(detail(events[0]).hybrid, true);
});

test('the worker\'s own extra queries are sent along when it has them, and are none today', async () => {
  const w = { ...W(), indexQueries: ['release checklist', { label: 'dates', text: 'calendar bug' }] };
  const { core, calls } = makeCore({ embed: async () => ({ queries: [okQuery(), okQuery('extra:1', 5), okQuery('dates', 6)], on_embedder_failure: 'stop', embed_ms: 48 }) });
  await MP.memoryPreface(w, ctxOf(core), PROMPT);
  assert.deepStrictEqual(calls.find((c) => c.method === 'embedQuery').args.extra_texts, w.indexQueries);
  assert.strictEqual(calls.find((c) => c.method === 'index').args.query_embeddings.length, 3);
  assert.strictEqual(calls.find((c) => c.method === 'recordEvent').args.message.includes('"extra:1"'), true);
  const none = makeCore({ embed: okEmbed });
  await MP.memoryPreface(W(), ctxOf(none.core), PROMPT);
  assert.strictEqual('extra_texts' in none.calls.find((c) => c.method === 'embedQuery').args, false);
});

test('the notes index is embedded the same way: the lever changes which index the core builds, not the call', async () => {
  const { core, calls, events } = makeCore({ embed: okEmbed });
  await MP.memoryPreface(W(), ctxOf(core, { notes: true }), PROMPT);
  assert.strictEqual(calls.find((c) => c.method === 'index').args.query_embeddings.length, 1);
  assert.strictEqual(detail(events[0]).hybrid, true);
});

test('stop: preface refuses the spawn with E_PAUSED, assigns nothing, records ok 0 with the code, and builds no keyword index', async () => {
  const { core, calls, events } = makeCore({ embed: failEmbed('stop') });
  core.task = { assign: async () => { calls.push({ method: 'task.assign' }); } };
  const w = W();
  await assert.rejects(MP.preface(w, ctxOf(core), PROMPT), (e) => e.code === 'E_PAUSED' && e.detail.code === 'E_MODEL_ABSENT' && /spawn it again after the resume/.test(e.message));
  assert.deepStrictEqual(names(calls), ['embedQuery', 'recordEvent'], 'no assignment, no index');
  assert.strictEqual(events[0].ok, 0);
  assert.strictEqual(events[0].code, 'E_MODEL_ABSENT');
  assert.deepStrictEqual(detail(events[0]), { hybrid: false, queries: [{ label: 'task', ms: 12, ok: false }], failure: { code: 'E_MODEL_ABSENT', message: 'the model is gone' } });
  assert.strictEqual(w.lastError.where, 'memory.embedQuery');
});

test('stop at a relaunch injects nothing and records ok 0 (the run is pausing; the resume relaunches)', async () => {
  const { core, calls, events } = makeCore({ embed: failEmbed('stop') });
  const out = await MP.relaunch(W(), ctxOf(core), 'resume line');
  assert.strictEqual(out, 'resume line');
  assert.ok(!names(calls).includes('index'));
  assert.strictEqual(events[0].ok, 0);
});

test('continue: the index is keyword-only and the receipt names the failure by code', async () => {
  const { core, calls, events } = makeCore({ embed: failEmbed('continue') });
  const text = await MP.memoryPreface(W(), ctxOf(core), PROMPT);
  assert.strictEqual(text, 'INDEX a b\n\n', 'the run goes on with a keyword index');
  assert.strictEqual('query_embeddings' in calls.find((c) => c.method === 'index').args, false);
  assert.strictEqual(events[0].ok, 1);
  assert.deepStrictEqual(detail(events[0]), { hybrid: false, queries: [{ label: 'task', ms: 12, ok: false }], failure: { code: 'E_MODEL_ABSENT', message: 'the model is gone' } });
});

test('past the spawn\'s own bound the index is keyword-only with the bound named, whatever the mode', async () => {
  const bound = (mode) => failEmbed(mode, { code: 'E_EMBED_BOUND', message: 'the 12000 ms bound passed', cause: null, embedder: false, timed_out: true });
  for (const mode of ['stop', 'continue']) {
    const { core, events } = makeCore({ embed: bound(mode) });
    const text = await MP.memoryPreface(W(), ctxOf(core), PROMPT);
    assert.strictEqual(text, 'INDEX a b\n\n', mode);
    assert.strictEqual(events[0].ok, 1, mode);
    assert.strictEqual(detail(events[0]).failure.code, 'E_EMBED_BOUND', mode);
    assert.strictEqual(detail(events[0]).hybrid, false, mode);
  }
});

test('a call that failed outright is recorded and keyword-only; E_ROLE says the run manager has no harness view', async () => {
  const lost = makeCore({ embed: async () => { const e = new Error('owner lost'); e.code = 'E_OWNER_LOST'; throw e; } });
  assert.strictEqual(await MP.memoryPreface(W(), ctxOf(lost.core), PROMPT), 'INDEX a b\n\n');
  assert.strictEqual(detail(lost.events[0]).failure.code, 'E_OWNER_LOST');
  const role = makeCore({ embed: async () => { const e = new Error('belongs to the harness channel'); e.code = 'E_ROLE'; throw e; } });
  assert.strictEqual(await MP.memoryPreface(W(), ctxOf(role.core), PROMPT), 'INDEX a b\n\n', 'a wiring fault never stops the run');
  const f = detail(role.events[0]).failure;
  assert.strictEqual(f.code, 'E_ROLE');
  assert.match(f.message, /no harness view.*not an embedder failure/);
});

test('hybrid is true only when a semantic list contributed: a vector the core could not use, or no embedded rows, is keyword-only', async () => {
  const unusable = makeCore({
    embed: okEmbed,
    index: async () => ({ text: 'INDEX a', bytes: 7, row_ids: ['a'], dropped: 0, over_budget: false, sha256: 'f'.repeat(64), relevance: { semantic: { code: 'E_MODEL', message: 'bound to another model' }, keyword: 'ran', semantic_contributed: false } }),
  });
  await MP.memoryPreface(W(), ctxOf(unusable.core), PROMPT);
  assert.deepStrictEqual(detail(unusable.events[0]), { hybrid: false, queries: [{ label: 'task', ms: 37, ok: true }], failure: { code: 'E_MODEL', message: 'bound to another model' } });
  const empty = makeCore({
    embed: okEmbed,
    index: async () => ({ text: 'INDEX a', bytes: 7, row_ids: ['a'], dropped: 0, over_budget: false, sha256: 'f'.repeat(64), relevance: { semantic: 'ran', keyword: 'ran', semantic_contributed: false, semantic_lists: [{ label: 'task', matched: 0 }] } }),
  });
  await MP.memoryPreface(W(), ctxOf(empty.core), PROMPT);
  assert.strictEqual(detail(empty.events[0]).hybrid, false, 'a new project with no embedded rows is keyword-only');
  assert.strictEqual(detail(empty.events[0]).failure, undefined);
});

test('memory off, no project, or no task and no extra query: nothing is embedded', async () => {
  for (const [levers, w] of [
    [{ first_message_index: false }, W()],   // the lever is off: no memory call at all
    [{ project: null }, W()],                // no project
    [{}, { id: 'w2' }],                      // no task, no extra query
  ]) {
    const { core, calls } = makeCore({ embed: okEmbed });
    await MP.memoryPreface(w, ctxOf(core, levers), PROMPT);
    assert.ok(!names(calls).includes('embedQuery'), JSON.stringify(levers));
  }
  const off = makeCore({ embed: okEmbed });
  await MP.memoryPreface(W(), ctxOf(off.core, { first_message_index: false }), PROMPT);
  assert.deepStrictEqual(off.calls, [], 'with the index off no memory call is made');
});

test('a core without memory.embedQuery (a test double) builds the same keyword index it always did', async () => {
  const { core, calls, events } = makeCore();
  const text = await MP.memoryPreface(W(), ctxOf(core), PROMPT);
  assert.strictEqual(text, 'INDEX a b\n\n');
  assert.deepStrictEqual(names(calls), ['index', 'recordEvent']);
  assert.deepStrictEqual(detail(events[0]), { hybrid: false, queries: [] });
});

// ---- through the run manager --------------------------------------------------------------------------------------
function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-preface-embed-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: d.replace(/\\/g, '/'), worktree: path.join(d, 'wt').replace(/\\/g, '/') };
}
function managed(embed) {
  const core = createFakeCore({ runId: 'run-fake', resumeLineText: 'resume' });
  const events = [];
  core.run = { get: async () => ({ run: { memory_levers: JSON.stringify({ first_message_index: true, project: 'proj' }) } }) };
  core.memory.index = async () => ({ text: 'INDEX a', bytes: 7, row_ids: ['a'], dropped: 0, over_budget: false, sha256: 'f'.repeat(64), relevance: { semantic: 'ran', keyword: 'ran', semantic_contributed: true } });
  core.memory.events = async () => ({ events: [] });
  core.memory.recordEvent = async (a) => { events.push(a); return a; };
  core.memory.embedQuery = embed;
  return { core, events };
}
async function withManager(embed, fn) {
  const sb = sandbox();
  const { core, events } = managed(embed);
  const m = createRunManager({ core, dataDir: sb.data, runId: 'run-fake', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  try { return await fn(m, sb, core, events); } finally { try { await m.shutdown(); } catch { /* best effort */ } cleanup(sb.data); }
}

test('through the manager under stop: the spawn is refused, the starting row is written dead, and no worker process is launched', async () => {
  await withManager(failEmbed('stop'), async (m, sb, core, events) => {
    await assert.rejects(m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: PROMPT, worker_id: 'w1', task_id: 't1' }), (e) => e.code === 'E_PAUSED');
    const states = core.calls.filter((c) => c.method === 'worker.write').map((c) => c.args.state);
    assert.deepStrictEqual(states, ['starting', 'dead']);
    assert.ok(!core.calls.some((c) => c.method === 'task.assign' && !c.args.check_only), 'the task was not assigned (only the spawn own check_only reservation was made)');
    assert.strictEqual(events[0].ok, 0);
    assert.strictEqual(m._worker('w1').launchFailed, true);
    assert.ok(!m._worker('w1').pid, 'nothing was launched');
  });
});

test('through the manager: the embedding time is the harness\'s wait, not the worker\'s ready_ms', async () => {
  const slow = async () => { await new Promise((r) => setTimeout(r, 1500)); return { queries: [okQuery()], on_embedder_failure: 'stop', embed_ms: 1500 }; };
  await withManager(slow, async (m, sb, core, events) => {
    const t0 = Date.now();
    const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: PROMPT, worker_id: 'w1', task_id: 't1' });
    assert.ok(Date.now() - t0 >= 1500, 'the spawn did wait for the embedding');
    assert.ok(row.ready_ms < 1400, `ready_ms ${row.ready_ms} excludes the 1500 ms embedding`);
    assert.strictEqual(detail(events[0]).queries[0].ok, true);
  });
});
