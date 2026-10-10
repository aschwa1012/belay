'use strict';
// knowledge-turns.test.cjs — ADR 0043 decision 1: the knowledge agent across turns, processes and sessions. The
// fake run manager here behaves like the real one where ask depends on it: a message starts a turn
// (`turnEnded: false`), the answer exists only once that turn ends, and `wait` answers at once for a turn that has
// already ended and otherwise at the turn's end or the timeout. A question that timed out must never collect the
// earlier question's answer; an ended agent is relaunched; a new session is told to read the corpus again; and
// the agent's built-in tools are narrowed to Read, Glob and Grep and checked at launch (ADR 0024).

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const K = require('../../src/run/knowledge.cjs');
const L = require('../../src/run/launch.cjs');
const S = require('../../src/run/surface.cjs');
const LC = require('../../src/run/lifecycle.cjs');

const RUN = 'run-kt';
const ID = `knowledge-${RUN}`;
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-knowledge-turns-')).split('\\').join('/'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function fakeCore({ workerRow = false } = {}) {
  const events = [];
  return {
    events,
    memory: {
      corpus: async () => ({ text: '# corpus', sha256: 'sha-1', bytes: 8, row_ids: [], dropped: 0, over_budget: false }),
      get_many: async (a) => ({ rows: a.ids.map((id) => ({ id, found: true, status: 'verified' })) }),
      recordEvent: async (a) => { events.push(a); return a; },
      events: async () => ({ events: events.filter((e) => e.kind === 'corpus_primed').map((e) => ({ ...e, ok: true })) }),
    },
    worker: {
      get: async ({ worker_id }) => {
        if (workerRow) return { id: worker_id, state: 'dead' };
        throw Object.assign(new Error('no such worker'), { code: 'E_NOT_FOUND' });
      },
    },
  };
}

// A turn is a promise the test ends by hand (`end(text)`); `wait` races it against the timeout, as the real one does.
function turnManager() {
  const m = { spawned: [], messages: [], restarts: [], turns: [], rec: null };
  const startTurn = () => {
    m.rec.turnEnded = false;
    let end;
    const done = new Promise((res) => { end = res; });
    const t = { done, end: (text) => { m.rec.lastAssistantText = text; m.rec.turns += 1; m.rec.turnEnded = true; end(); } };
    m.turns.push(t);
    return t;
  };
  m.spawn = async (a) => { m.spawned.push(a); m.rec = { id: a.worker_id, turns: 0, turnEnded: false, settled: false, sessionId: 's1', lastAssistantText: '' }; startTurn(); return { id: a.worker_id }; };
  m.message = async (a) => { m.messages.push(a); startTurn(); return { worker_id: a.worker_id }; };
  m.restart = async (a) => {
    m.restarts.push(a);
    m.rec = m.rec || { id: a.worker_id, turns: 0, sessionId: null, lastAssistantText: '' };
    Object.assign(m.rec, { settled: false, sessionId: m.branch === 'resume' ? m.rec.sessionId : 's2', turnEnded: true, lastAssistantText: 'resumed, continuing' });
    return { worker_id: a.worker_id, branch: m.branch || 'replace', first_turn_timed_out: false };
  };
  m.wait = async ({ timeout_ms }) => {
    if (m.rec.turnEnded) return { worker_id: ID, event: 'turn_end', turn: m.rec.turns, is_error: false, timed_out: false, already: true };
    const t = m.turns[m.turns.length - 1];
    let timer;
    const out = await Promise.race([t.done.then(() => 'ended'), new Promise((r) => { timer = setTimeout(() => r('timeout'), timeout_ms); })]);
    clearTimeout(timer);
    if (out === 'timeout') return { worker_id: null, event: null, timed_out: true, waited_ms: timeout_ms };
    return { worker_id: ID, event: 'turn_end', turn: m.rec.turns, is_error: false, timed_out: false };
  };
  m._worker = (id) => (m.rec && m.rec.id === id ? m.rec : undefined);
  return m;
}

const ctxOf = (core) => ({ core, runId: RUN, dataDir: dir, worktree: dir, memoryLevers: { knowledge_agent: true } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a timed-out question never hands its answer to the next: the earlier turn is waited out and dropped', async () => {
  const core = fakeCore();
  const m = turnManager();
  const first = K.ask(m, ctxOf(core), { question: 'first?', timeout_ms: 50 });
  await assert.rejects(first, (e) => e.code === 'E_TIMEOUT');
  // The first question's turn is still running when the second arrives; it ends during the second ask's own wait.
  const second = K.ask(m, ctxOf(core), { question: 'second?', timeout_ms: 2000 });
  await sleep(30);
  assert.strictEqual(m.messages.length, 0, 'nothing is sent while the earlier turn runs');
  m.turns[0].end('answer to FIRST');
  await sleep(30);
  assert.strictEqual(m.messages.length, 1, 'the question is sent once the earlier turn has ended');
  m.turns[1].end('answer to SECOND');
  const r = await second;
  assert.strictEqual(r.answer, 'answer to SECOND');
  assert.strictEqual(r.earlier_answer_dropped, true);
});

test('a question while the earlier turn never ends is refused E_BUSY and sends nothing', async () => {
  const core = fakeCore();
  const m = turnManager();
  await assert.rejects(K.ask(m, ctxOf(core), { question: 'first?', timeout_ms: 30 }), (e) => e.code === 'E_TIMEOUT');
  await assert.rejects(K.ask(m, ctxOf(core), { question: 'second?', timeout_ms: 60 }), (e) => e.code === 'E_BUSY');
  assert.strictEqual(m.messages.length, 0);
  assert.ok(core.events.some((e) => e.kind === 'knowledge_ask' && e.ok === false && e.code === 'E_BUSY'), 'the refusal is a receipt');
});

test('an ended agent is relaunched, and a replaced session is told to read the corpus again', async () => {
  const core = fakeCore();
  const m = turnManager();
  const a1 = K.ask(m, ctxOf(core), { question: 'one?' });
  await sleep(10); m.turns[0].end('one [mem:m1]');
  await a1;
  m.rec.settled = true; // the process died
  const a2 = K.ask(m, ctxOf(core), { question: 'two?' });
  await sleep(10); m.turns[1].end('two [mem:m1]');
  const r = await a2;
  assert.strictEqual(m.restarts.length, 1, 'restart, never a second spawn of the same id');
  assert.strictEqual(m.spawned.length, 1);
  assert.strictEqual(r.relaunched, 'replace');
  assert.ok(m.messages[0].text.startsWith('The corpus changed. Read'), 'a new session reads corpus.md again');
  assert.strictEqual(core.events.filter((e) => e.kind === 'corpus_primed').length, 2);
});

test('a session replaced by someone else is re-primed; the same session is not', async () => {
  const core = fakeCore();
  const m = turnManager();
  const a1 = K.ask(m, ctxOf(core), { question: 'one?' });
  await sleep(10); m.turns[0].end('one');
  await a1;
  const a2 = K.ask(m, ctxOf(core), { question: 'two?' });
  await sleep(10); m.turns[1].end('two');
  await a2;
  assert.ok(!m.messages[0].text.includes('corpus changed'), 'same session, same corpus: a plain question');
  m.rec.sessionId = 's-other'; // a replace restart the orchestrator asked for
  const a3 = K.ask(m, ctxOf(core), { question: 'three?' });
  await sleep(10); m.turns[2].end('three');
  await a3;
  assert.ok(m.messages[1].text.startsWith('The corpus changed. Read'));
});

test('an agent row left by an earlier adapter of this run is relaunched through restart, never spawned again', async () => {
  const core = fakeCore({ workerRow: true });
  const m = turnManager();
  m.branch = 'resume';
  const a = K.ask(m, ctxOf(core), { question: 'q?' });
  await sleep(10); m.turns[0].end('answer');
  const r = await a;
  assert.strictEqual(m.spawned.length, 0);
  assert.strictEqual(m.restarts.length, 1);
  assert.strictEqual(r.answer, 'answer');
});

test('ask refuses E_ARGS without the run worktree, before anything is spawned', async () => {
  const m = turnManager();
  await assert.rejects(K.ask(m, { ...ctxOf(fakeCore()), worktree: null }, { question: 'q?' }), (e) => e.code === 'E_ARGS' && /worktree/.test(e.message));
  assert.strictEqual(m.spawned.length, 0);
});

test('the knowledge launch narrows --tools to Read, Glob and Grep, and the surface check holds it there', () => {
  const argv = L.claudeLaunchArgv({ workerId: ID, mcpJsonPath: 'x/mcp.json', settingsPath: 'x/s.json', allowedTools: K.KNOWLEDGE_TOOLS, tools: K.KNOWLEDGE_BUILTINS });
  assert.strictEqual(argv[argv.indexOf('--tools') + 1], 'Read,Glob,Grep');
  const full = L.claudeLaunchArgv({ workerId: 'w1', mcpJsonPath: 'x/mcp.json', settingsPath: 'x/s.json' });
  assert.strictEqual(full[full.indexOf('--tools') + 1], S.CLAUDE_TOOLS.join(','), 'an ordinary worker is unchanged');
  const ready = (tools) => ({ tools: [...tools, 'mcp__belay__memory_search'], plugins: [] });
  assert.strictEqual(S.checkSurface(ready(['Read', 'Glob', 'Grep']), { tools: K.KNOWLEDGE_BUILTINS }).ok, true);
  const wide = S.checkSurface(ready(S.CLAUDE_TOOLS), { tools: K.KNOWLEDGE_BUILTINS });
  assert.strictEqual(wide.ok, false, 'the full list on a narrowed launch is a failed launch');
  assert.match(wide.reason, /extra built-in tool\(s\).*Edit/);
  assert.strictEqual(S.checkSurface(ready(['Read', 'Glob', 'Grep']), {}).ok, false, 'and a narrowed init on a full launch is too');
  // Narrowing only: a tool outside ADR 0024's list, an empty list or a repeat is refused.
  for (const bad of [['Read', 'WebFetch'], [], ['Read', 'Read'], 'Read']) assert.throws(() => S.narrowTools(bad), (e) => e.code === 'E_ARGS');
  assert.strictEqual(S.narrowTools([...S.CLAUDE_TOOLS]), null, 'the full list is the default');
});

test('a narrowed list survives a cross-adapter relaunch through argv.json', () => {
  const argv = L.claudeLaunchArgv({ workerId: ID, mcpJsonPath: 'x/mcp.json', settingsPath: 'x/s.json', tools: K.KNOWLEDGE_BUILTINS });
  fs.writeFileSync(path.join(dir, 'argv.json'), JSON.stringify({ spec: { args: argv } }));
  assert.deepStrictEqual(LC.readLaunchOptions(dir).tools, ['Read', 'Glob', 'Grep']);
  fs.writeFileSync(path.join(dir, 'argv.json'), JSON.stringify({ spec: { args: L.claudeLaunchArgv({ workerId: 'w', mcpJsonPath: 'm', settingsPath: 's' }) } }));
  assert.strictEqual(LC.readLaunchOptions(dir).tools, null);
});
