'use strict';
// knowledge.test.cjs — ADR 0043 decision 1: the knowledge agent's ask. A fake run manager stands in for the
// worker (spawn, message, wait and the worker record the answer is read from), and a fake core for the memory
// methods, so the test proves what ask does with them: the lever gate, priming, re-priming on a corpus change, the
// lookup of every cited id, the receipts, and the failures.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const K = require('../../src/run/knowledge.cjs');

const RUN = 'run-k';
const ID = `knowledge-${RUN}`;
let dir;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-knowledge-')).split('\\').join('/'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

// A core with the four memory methods ask uses. `corpus` is mutable so a test can change it between questions.
function fakeCore({ rows = {}, corpus = { text: '# corpus one', sha256: 'sha-1', bytes: 12, row_ids: ['m1'], dropped: 0, over_budget: false }, failEvent = null } = {}) {
  const events = [];
  const core = {
    events, calls: [], corpus,
    memory: {
      corpus: async (a) => { core.calls.push(['corpus', a]); return core.corpus; },
      get_many: async (a) => {
        core.calls.push(['get_many', a]);
        return { rows: a.ids.map((id) => (rows[id] ? { ...rows[id], id, found: true } : { id, found: false })) };
      },
      recordEvent: async (a) => {
        if (failEvent && failEvent === a.kind) throw Object.assign(new Error('event refused'), { code: 'E_INTERNAL' });
        events.push(a);
        return { ...a, id: `me-${events.length}` };
      },
      events: async () => ({ events: events.filter((e) => e.kind === 'corpus_primed').map((e) => ({ ...e, ok: e.ok !== false })) }),
    },
  };
  return core;
}

// A manager whose one worker answers each message with the next scripted reply.
function fakeManager(replies, { wait } = {}) {
  const m = { spawned: [], messages: [], waits: [], record: null };
  let n = 0;
  const reply = () => { m.record.lastAssistantText = replies[Math.min(n, replies.length - 1)]; n += 1; };
  m.spawn = async (a) => { m.spawned.push(a); m.record = { id: a.worker_id, lastAssistantText: '' }; reply(); return { id: a.worker_id }; };
  m.message = async (a) => { m.messages.push(a); reply(); return { worker_id: a.worker_id, channel: 'stdin' }; };
  m.wait = async (a) => {
    m.waits.push(a);
    if (wait) return wait(a, n);
    return { worker_id: ID, event: 'turn_end', established_by: 'result event', turn: n, is_error: false, waited_ms: 3, timed_out: false };
  };
  m._worker = (id) => (m.record && m.record.id === id ? m.record : undefined);
  return m;
}

const ctxOf = (core, extra = {}) => ({ core, runId: RUN, dataDir: dir, worktree: dir, levers: { knowledge_agent: true, project: 'demo' }, ...extra });

test('lever off refuses E_LEVER_OFF before anything is read, spawned or written', async () => {
  const core = fakeCore();
  const m = fakeManager(['x']);
  await assert.rejects(K.ask(m, ctxOf(core, { levers: { knowledge_agent: false } }), { question: 'why?' }), (e) => e.code === 'E_LEVER_OFF');
  assert.deepStrictEqual(core.calls, []);
  assert.deepStrictEqual(core.events, []);
  assert.deepStrictEqual(m.spawned, []);
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'no corpus file, no worker directory');
});

test('the lever is read from the run row through memory-levers when the caller gave none', async () => {
  const core = fakeCore();
  core.run = { get: async () => ({ run: { memory_levers: JSON.stringify({ knowledge_agent: false }) } }) };
  await assert.rejects(K.ask(fakeManager(['x']), { core, runId: 'run-from-row', dataDir: dir }, { question: 'why?' }), (e) => e.code === 'E_LEVER_OFF');
});

test('the first question spawns the agent with the corpus on disk, the project namespace and a read-only tool set', async () => {
  const core = fakeCore({ rows: { m1: { status: 'verified' } } });
  const m = fakeManager(['A pipe, because a signal skips handlers on Windows. [mem:m1]']);
  const r = await K.ask(m, ctxOf(core), { question: 'why a pipe?' });
  assert.strictEqual(m.spawned.length, 1);
  const s = m.spawned[0];
  assert.strictEqual(s.worker_id, ID);
  assert.strictEqual(s.substrate, 'claude-code');
  assert.strictEqual(s.model, K.KNOWLEDGE_MODEL);
  assert.deepStrictEqual(s.allowed_tools, K.KNOWLEDGE_TOOLS);
  assert.ok(!s.allowed_tools.includes('Bash') && !s.allowed_tools.includes('Edit') && !s.allowed_tools.includes('Write'));
  // --allowedTools only pre-approves; the built-in surface itself is narrowed (--tools), and the launch is checked against it.
  assert.deepStrictEqual(s.tools, ['Read', 'Glob', 'Grep']);
  assert.strictEqual(s.worktree, dir);
  assert.ok(s.prompt.includes('You are the knowledge agent'), 'the prompt template leads the first message');
  assert.ok(s.prompt.includes(`${dir}/workers/${ID}/corpus.md`) && s.prompt.endsWith('why a pipe?'));
  assert.strictEqual(fs.readFileSync(`${dir}/workers/${ID}/corpus.md`, 'utf8'), '# corpus one');
  assert.deepStrictEqual(core.calls[0], ['corpus', { project: 'demo' }]);
  assert.deepStrictEqual(r.cited, [{ id: 'm1', found: true, status: 'verified' }]);
  assert.strictEqual(r.worker_id, ID);
  assert.strictEqual(r.turn, 1);
  assert.strictEqual(r.uncited_claims, false);
  assert.strictEqual(typeof r.waited_ms, 'number');
  assert.strictEqual(m.waits.length, 1);
  assert.deepStrictEqual(m.waits[0].worker_ids, [ID]);
  assert.ok(m.waits[0].timeout_ms <= 110000 && m.waits[0].timeout_ms > 100000, 'the wait gets what is left of the one budget');
});

test('every cited id is looked up, and an id with no row is reported found: false, never dropped', async () => {
  const core = fakeCore({ rows: { m1: { status: 'verified' }, m2: { status: 'unverified' } } });
  const m = fakeManager(['One [mem:m1], two [mem:m2], and a ghost [mem:m404]. Again [mem:m1].']);
  const r = await K.ask(m, ctxOf(core), { question: 'q' });
  assert.deepStrictEqual(r.cited, [
    { id: 'm1', found: true, status: 'verified' },
    { id: 'm2', found: true, status: 'unverified' },
    { id: 'm404', found: false, status: null },
  ]);
  assert.deepStrictEqual(core.calls.find((c) => c[0] === 'get_many')[1].ids, ['m1', 'm2', 'm404']);
});

test('more than fifty cited ids are looked up in batches', async () => {
  const ids = Array.from({ length: 120 }, (_, i) => `r${i}`);
  const core = fakeCore({ rows: Object.fromEntries(ids.map((id) => [id, { status: 'verified' }])) });
  const m = fakeManager([ids.map((id) => `[mem:${id}]`).join(' ')]);
  const r = await K.ask(m, ctxOf(core), { question: 'q' });
  assert.strictEqual(r.cited.length, 120);
  assert.ok(r.cited.every((c) => c.found));
  assert.deepStrictEqual(core.calls.filter((c) => c[0] === 'get_many').map((c) => c[1].ids.length), [50, 50, 20]);
});

test('uncited_claims is true for a substantive line with no citation and not for "not in memory"', async () => {
  assert.strictEqual(K.hasUncitedClaims('The scheduler retries three times before giving up.'), true);
  assert.strictEqual(K.hasUncitedClaims('The scheduler retries three times. [mem:m1]'), false);
  assert.strictEqual(K.hasUncitedClaims('The retry count is not in memory.'), false);
  assert.strictEqual(K.hasUncitedClaims('# Answer\nYes. [mem:m1]'), false);
  const core = fakeCore({ rows: { m1: { status: 'verified' } } });
  const r = await K.ask(fakeManager(['The scheduler retries three times before giving up, I believe.']), ctxOf(core), { question: 'q' });
  assert.strictEqual(r.uncited_claims, true);
  assert.deepStrictEqual(r.cited, []);
});

test('the same corpus is not primed again: the second question is a plain message', async () => {
  const core = fakeCore({ rows: { m1: { status: 'verified' } } });
  const m = fakeManager(['one [mem:m1]', 'two [mem:m1]']);
  await K.ask(m, ctxOf(core), { question: 'first' });
  const r2 = await K.ask(m, ctxOf(core), { question: 'second' });
  assert.strictEqual(m.spawned.length, 1);
  assert.deepStrictEqual(m.messages, [{ worker_id: ID, text: 'Question:\nsecond' }]);
  assert.strictEqual(r2.answer, 'two [mem:m1]');
  assert.strictEqual(core.events.filter((e) => e.kind === 'corpus_primed').length, 1);
});

test('a changed corpus sha re-primes: the file is rewritten, the message names it, and a corpus_primed event is recorded', async () => {
  const core = fakeCore({ rows: { m1: { status: 'verified' } } });
  const m = fakeManager(['a [mem:m1]', 'b [mem:m1]']);
  await K.ask(m, ctxOf(core), { question: 'first' });
  core.corpus = { text: '# corpus two', sha256: 'sha-2', bytes: 12, row_ids: ['m1', 'm2'], dropped: 3, over_budget: false };
  await K.ask(m, ctxOf(core), { question: 'second' });
  assert.strictEqual(fs.readFileSync(`${dir}/workers/${ID}/corpus.md`, 'utf8'), '# corpus two');
  assert.strictEqual(m.messages.length, 1);
  assert.ok(m.messages[0].text.startsWith(`The corpus changed. Read ${dir}/workers/${ID}/corpus.md again in full`));
  assert.ok(m.messages[0].text.endsWith('Question:\nsecond'));
  const primed = core.events.filter((e) => e.kind === 'corpus_primed');
  assert.deepStrictEqual(primed.map((e) => e.sha256), ['sha-1', 'sha-2']);
  assert.deepStrictEqual(primed[1].row_ids, ['m1', 'm2']);
  assert.strictEqual(primed[1].dropped, true);
  assert.strictEqual(primed[1].worker_id, ID);
});

test('a manager that has the worker but no memory of priming it takes the last corpus_primed event as the basis', async () => {
  const core = fakeCore({ rows: { m1: { status: 'verified' } } });
  const m = fakeManager(['a [mem:m1]', 'b [mem:m1]']);
  await K.ask(m, ctxOf(core), { question: 'first' }); // primes sha-1 on this manager
  const fresh = fakeManager(['c [mem:m1]']);
  fresh.record = m.record; // the same worker, adopted by a new manager with no state
  await K.ask(fresh, ctxOf(core), { question: 'again' });
  assert.ok(!fresh.messages[0].text.startsWith('The corpus changed'), 'sha-1 was recorded, so nothing changed');
  core.corpus = { ...core.corpus, sha256: 'sha-9' };
  const fresh2 = fakeManager(['d [mem:m1]']);
  fresh2.record = m.record;
  await K.ask(fresh2, ctxOf(core), { question: 'once more' });
  assert.ok(fresh2.messages[0].text.startsWith('The corpus changed'));
});

test('each ask records a knowledge_ask event naming the cited ids, never the question text', async () => {
  const core = fakeCore({ rows: { m1: { status: 'verified' } } });
  await K.ask(fakeManager(['yes [mem:m1]']), ctxOf(core), { question: 'a private question' });
  const ev = core.events.find((e) => e.kind === 'knowledge_ask');
  assert.strictEqual(ev.ok, true);
  assert.deepStrictEqual(ev.row_ids, ['m1']);
  assert.strictEqual(ev.worker_id, ID);
  assert.match(ev.sha256, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(ev).includes('private'));
});

test('a timeout is E_TIMEOUT, recorded as a failed knowledge_ask, and the next question still works', async () => {
  const core = fakeCore({ rows: { m1: { status: 'verified' } } });
  let first = true;
  const m = fakeManager(['late [mem:m1]', 'ok [mem:m1]'], {
    wait: (a, n) => {
      if (first) { first = false; return { worker_id: ID, event: null, timed_out: true, waited_ms: a.timeout_ms }; }
      return { worker_id: ID, event: 'turn_end', turn: n, is_error: false, waited_ms: 1, timed_out: false };
    },
  });
  await assert.rejects(K.ask(m, ctxOf(core), { question: 'slow', timeout_ms: 50 }), (e) => e.code === 'E_TIMEOUT' && e.detail.worker_id === ID);
  const failed = core.events.find((e) => e.kind === 'knowledge_ask');
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.code, 'E_TIMEOUT');
  const r = await K.ask(m, ctxOf(core), { question: 'again' });
  assert.strictEqual(r.answer, 'ok [mem:m1]');
});

test('a dead, paused or errored agent is a refusal naming what happened, never an answer', async () => {
  for (const [wait, code] of [
    [() => ({ worker_id: ID, event: 'dead', established_by: 'exit event', turn: 1 }), 'E_WORKER_NOT_LIVE'],
    [() => ({ worker_id: ID, event: 'paused', established_by: 'park', turn: 1 }), 'E_WORKER_NOT_LIVE'],
    [() => ({ worker_id: ID, event: 'turn_end', turn: 1, is_error: true }), 'E_SUBSTRATE'],
  ]) {
    const core = fakeCore();
    await assert.rejects(K.ask(fakeManager(['x'], { wait }), ctxOf(core), { question: 'q' }), (e) => e.code === code);
    assert.strictEqual(core.events.find((e) => e.kind === 'knowledge_ask').ok, false);
  }
});

test('an empty answer is a failure, not a success with nothing in it', async () => {
  const core = fakeCore();
  await assert.rejects(K.ask(fakeManager(['   ']), ctxOf(core), { question: 'q' }), (e) => e.code === 'E_SUBSTRATE');
});

test('a priming that cannot be recorded sends nothing and is tried again next time', async () => {
  const core = fakeCore({ failEvent: 'corpus_primed' });
  const m = fakeManager(['x [mem:m1]']);
  await assert.rejects(K.ask(m, ctxOf(core), { question: 'q' }), (e) => e.code === 'E_INTERNAL');
  assert.deepStrictEqual(m.spawned, []);
  core.memory.recordEvent = async (a) => { core.events.push(a); return a; };
  await K.ask(m, ctxOf(core), { question: 'q' });
  assert.strictEqual(m.spawned.length, 1);
});

test('bad questions are refused with E_ARGS before the corpus is read', async () => {
  for (const q of [undefined, '', '   ', 42, 'x'.repeat(5000)]) {
    const core = fakeCore();
    await assert.rejects(K.ask(fakeManager(['x']), ctxOf(core), { question: q }), (e) => e.code === 'E_ARGS');
    assert.deepStrictEqual(core.calls, []);
  }
  await assert.rejects(K.ask(fakeManager(['x']), ctxOf(fakeCore(), { dataDir: undefined }), { question: 'q' }), (e) => e.code === 'E_ARGS');
});

test('concurrent questions to one manager are answered one at a time, in order', async () => {
  const core = fakeCore({ rows: { m1: { status: 'verified' } } });
  const order = [];
  const m = fakeManager(['one [mem:m1]', 'two [mem:m1]', 'three [mem:m1]'], {
    wait: async (a, n) => {
      order.push(`start ${n}`);
      await new Promise((r) => setTimeout(r, 15));
      order.push(`end ${n}`);
      return { worker_id: ID, event: 'turn_end', turn: n, is_error: false, waited_ms: 1, timed_out: false };
    },
  });
  const rs = await Promise.all(['a', 'b', 'c'].map((q) => K.ask(m, ctxOf(core), { question: q })));
  assert.deepStrictEqual(rs.map((r) => r.answer), ['one [mem:m1]', 'two [mem:m1]', 'three [mem:m1]']);
  assert.deepStrictEqual(order, ['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
});

test('citedIds keeps the order first cited and ignores other brackets', () => {
  assert.deepStrictEqual(K.citedIds('[mem:b] [x:c] [mem:a] [mem:b] [mem: d] [memory:e]'), ['b', 'a']);
});

test('the module requires no embedder and no core', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'run', 'knowledge.cjs'), 'utf8');
  const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]).filter((r) => !r.startsWith('node:'));
  assert.deepStrictEqual(reqs.sort(), ['./bottle.cjs', './errors.cjs', './launch.cjs', './memory-levers.cjs']);
});
