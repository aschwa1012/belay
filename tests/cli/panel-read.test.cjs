'use strict';
require('../helpers/tmp.cjs');
// panel-read.test.cjs — the panel's one batched read (src/cli/cmd-panel-read.cjs). The reads are injected runners and the clock
// is a counter, so nothing here touches a store, a process or real time: what is under test is which reads run, in what order, with
// what argv, and what the one document says. A real-store check of the same verb belongs to the acceptance rows.

const { test } = require('node:test');
const assert = require('node:assert');
const mod = require('../../src/cli/cmd-panel-read.cjs');
const { COMMANDS } = require('../../src/cli/belay.cjs');

const HELD = { kind: 'notes_held', count: 2, awaiting_operator: 1 };
const AGENTS = (mode = 'headless') => ({ run_id: 'r-1', mode, agents: [] });

// Fake reads: each records its argv and the order it was called in, and answers from `answers` (a function or a value).
function fakes(answers = {}) {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const reads = {};
  for (const name of ['agents', 'notices', 'awaiting', 'transcript', 'settings']) {
    reads[name] = async (argv) => {
      calls.push({ name, argv: [...argv] });
      active += 1; maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      const a = answers[name];
      const r = typeof a === 'function' ? await a(argv) : a;
      if (r === undefined) return { code: 0, json: { read: name } };
      return r;
    };
  }
  return { reads, calls, max: () => maxActive };
}
const ok = (json) => ({ code: 0, json });
let tick = 1000;
const clock = () => { tick += 7; return tick; }; // a fake clock: every look moves it, so a test can tell one round from the next
const opts = (argv) => mod.parseArgs(argv);
const go = (argv, f, extra = {}) => mod.round({ opts: opts(argv), reads: f.reads, now: clock, bound: (p) => p, timeoutMs: 1, ...extra });

test('a headless run with settings due: every part is read once, in order, with the argv the commands take', async () => {
  const f = fakes({ agents: ok(AGENTS()), notices: ok({ events: [HELD] }), awaiting: ok({ entries: [] }) });
  const out = await go(['--dir', 'C:/o', '--tail', '10', '--settings'], f);
  assert.deepStrictEqual(f.calls.map((c) => c.name), ['agents', 'notices', 'awaiting', 'transcript', 'settings']);
  assert.deepStrictEqual(f.calls[0].argv, ['--dir', 'C:/o']);
  assert.deepStrictEqual(f.calls[1].argv, ['r-1'], 'the run agents answered with is the run the later reads name');
  assert.deepStrictEqual(f.calls[2].argv, ['held', '--awaiting']);
  assert.deepStrictEqual(f.calls[3].argv, ['r-1', '--tail', '10']);
  assert.deepStrictEqual(f.calls[4].argv, []);
  assert.strictEqual(out.v, 1);
  assert.strictEqual(out.run_id, 'r-1');
  assert.strictEqual(typeof out.at, 'number');
  assert.deepStrictEqual(Object.keys(out.parts), ['agents', 'notices', 'awaiting', 'transcript', 'settings']);
  assert.deepStrictEqual(out.parts.agents, { json: AGENTS() });
  assert.deepStrictEqual(out.parts.transcript, { json: { read: 'transcript' } });
  assert.strictEqual(f.max(), 1, 'the reads run one after another, never at once');
});

test('the run id the panel names goes to every read, and agents is not asked for another', async () => {
  const f = fakes({ agents: ok(AGENTS()), notices: ok({ events: [] }) });
  await go(['r-9', '--tail', '50'], f);
  assert.deepStrictEqual(f.calls[0].argv, ['r-9']);
  assert.deepStrictEqual(f.calls[1].argv, ['r-9']);
  assert.deepStrictEqual(f.calls[2].argv, ['r-9', '--tail', '50']);
});

test('the awaiting list is read only while the notices say a held note waits', async () => {
  const none = fakes({ agents: ok(AGENTS()), notices: ok({ events: [{ kind: 'notes_held', count: 3, awaiting_operator: 0 }] }) });
  const out = await go([], none);
  assert.ok(!none.calls.some((c) => c.name === 'awaiting'));
  assert.strictEqual(out.parts.awaiting, null);
  const capped = fakes({ agents: ok(AGENTS()), notices: ok({ events: [{ kind: 'notes_held', count: 0, awaiting_operator: 4 }] }) });
  await go([], capped);
  assert.ok(!capped.calls.some((c) => c.name === 'awaiting'), 'awaiting is capped by the count, as the panel caps it');
  assert.strictEqual(mod.awaitingOf({ events: [HELD] }), 1);
  assert.strictEqual(mod.awaitingOf(null), 0);
});

test('the transcript is read for a headless run only, and never by the interactive orchestrator\'s own window', async () => {
  const live = fakes({ agents: ok(AGENTS('interactive')), notices: ok({ events: [] }) });
  assert.strictEqual((await go([], live)).parts.transcript, null);
  const fixed = fakes({ agents: ok(AGENTS('headless')), notices: ok({ events: [] }) });
  assert.strictEqual((await go(['--fixed'], fixed)).parts.transcript, null, '--fixed wins over what agents says');
  const headless = fakes({ agents: ok(AGENTS('headless')), notices: ok({ events: [] }) });
  assert.notStrictEqual((await go([], headless)).parts.transcript, null);
});

test('a failed agents read falls back to the mode the panel last saw, for the transcript only', async () => {
  const f = fakes({ agents: { code: 1, json: { error: { code: 'E_X', message: 'store gone' } } }, notices: ok({ events: [] }) });
  const out = await go(['--prev-mode', 'headless'], f);
  assert.match(out.parts.agents.error, /^belay agents exit 1: store gone/);
  assert.notStrictEqual(out.parts.transcript, null);
  assert.deepStrictEqual(f.calls.find((c) => c.name === 'transcript').argv, [], 'no run id was learned, none is made up');
  const unknown = fakes({ agents: { code: 1, json: { error: 'x' } }, notices: ok({ events: [] }) });
  assert.strictEqual((await go([], unknown)).parts.transcript, null);
});

test('settings are read only when asked', async () => {
  const f = fakes({ agents: ok(AGENTS()), notices: ok({ events: [] }) });
  assert.strictEqual((await go([], f)).parts.settings, null);
  assert.strictEqual((await go(['--settings'], fakes({ agents: ok(AGENTS()), notices: ok({ events: [] }) }))).parts.settings.json.read, 'settings');
});

test('a failing sub-read is reported as that part\'s error and the others still arrive', async () => {
  const f = fakes({
    agents: ok(AGENTS()),
    notices: { code: 1, json: { error: { code: 'E_BUSY', message: 'store busy' } } },
    transcript: ok({ entries: [] }),
    settings: () => { throw new Error('boom'); },
  });
  const out = await go(['--settings'], f);
  assert.deepStrictEqual(out.parts.agents, { json: AGENTS() });
  assert.deepStrictEqual(out.parts.notices, { error: 'belay notices r-1 exit 1: store busy' });
  assert.deepStrictEqual(out.parts.transcript, { json: { entries: [] } });
  assert.match(out.parts.settings.error, /^belay settings did not run: boom/);
  assert.strictEqual(out.parts.settings.timedOut, undefined);
  assert.strictEqual(out.parts.awaiting, null, 'with no notices answer there is no awaiting list');
});

test('a part that times out ends the round: the rest are never started, and it says timed out', async () => {
  const gate = new Promise(() => {}); // a read that never answers
  const f = fakes({ agents: ok(AGENTS()), notices: () => gate });
  // The bound fires on the next macrotask, so a read that has already answered always wins and only the hung one loses.
  const bound = (p) => Promise.race([p, new Promise((_, rej) => setImmediate(() => rej(Object.assign(new Error('timed out'), { code: 'E_TIMEOUT' }))))]);
  const out = await go(['--settings'], f, { bound });
  assert.deepStrictEqual(out.parts.notices, { error: 'belay notices r-1 timed out', timedOut: true });
  assert.deepStrictEqual(f.calls.map((c) => c.name), ['agents', 'notices']);
  assert.strictEqual(out.parts.transcript, null);
  assert.strictEqual(out.parts.settings, null);
  assert.deepStrictEqual(out.parts.agents, { json: AGENTS() }, 'what was read before the timeout is kept');
});

test('the fake clock stamps each round', async () => {
  const f = fakes({ agents: ok(AGENTS()), notices: ok({ events: [] }) });
  const a = await go([], f);
  const b = await go([], f);
  assert.ok(b.at > a.at);
});

test('run(): a round is code 0 with the document as its json, and bad arguments are a usage error before any read', async () => {
  const f = fakes({ agents: ok(AGENTS()), notices: ok({ events: [] }) });
  const r = await mod.run({ argv: ['--tail', '10'], cwd: 'C:/x', dataDir: 'C:/x/.belay', json: true, reads: f.reads, now: clock, bound: (p) => p });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.json.parts.agents.json.run_id, 'r-1');
  assert.match(r.text, /panel-read r-1 at \d+/);
  for (const argv of [['--tail'], ['--tail', 'x'], ['--tail', '0'], ['--dir'], ['--nope'], ['a', 'b']]) {
    const bad = await mod.run({ argv, cwd: 'C:/x', dataDir: 'C:/x/.belay', json: true, reads: f.reads });
    assert.strictEqual(bad.code, 2, argv.join(' '));
  }
  assert.strictEqual(f.calls.length, 2, 'the usage errors read nothing');
});

test('the real bound: a read that never answers is abandoned at its time', async () => {
  let started = 0;
  const r = await mod.run({
    argv: [], cwd: 'C:/x', dataDir: 'C:/x/.belay', json: true, timeoutMs: 5,
    reads: { agents: () => new Promise(() => {}), notices: async () => { started += 1; return ok({ events: [] }); } },
  });
  assert.strictEqual(r.code, 0, 'a round that ran is exit 0, whatever its parts said');
  assert.strictEqual(r.json.parts.agents.timedOut, true);
  assert.strictEqual(r.json.parts.notices, null);
  assert.strictEqual(started, 0, 'after a timeout nothing else starts');
});

test('settings run from the project root that holds the data dir', () => {
  assert.strictEqual(mod.projectRootOf('C:/proj/.belay'), 'C:/proj');
  assert.strictEqual(mod.projectRootOf('C:/proj/store/'), 'C:/proj/store');
  assert.strictEqual(mod.projectRootOf('C:\\proj\\.belay'), 'C:/proj');
});

test('it is a read command, registered under its own name, and loading it imports no embedder', () => {
  assert.strictEqual(COMMANDS['panel-read'].mode, 'R');
  assert.strictEqual(COMMANDS['panel-read'].module, './cmd-panel-read.cjs');
  const loaded = Object.keys(require.cache).filter((p) => /[\\/](embedder|embedder-core|embedder-mode|embed-provider|embed-worker|heavy-embed)\.cjs$/.test(p));
  assert.deepStrictEqual(loaded, [], 'no embedder module is in the cache after loading the verb');
  const src = require('node:fs').readFileSync(require.resolve('../../src/cli/cmd-panel-read.cjs'), 'utf8');
  assert.ok(!/^const .*require\(.*(core|embed)/m.test(src), 'no top-level require of the core or an embedder');
});
