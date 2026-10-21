'use strict';
// eval-levers-review.test.cjs: the review fixes for the two eval-only levers (native_memory, handback_question). Another run's
// native_memory is never adopted into a run that did not opt in, a stored lever that cannot be read refuses the spawn, the hand-back
// question closes a resume that carries an operator message, an absent lever leaves the recorded levers as they were, and a bad
// memory block is refused whether or not an eval key sits beside it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseLevers } = require('../../src/cli/run-levers.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const ML = require('../../src/run/memory-levers.cjs');
const MP = require('../../src/run/memory-preface.cjs');
const NC = require('../../src/run/notes-contract.cjs');
const L = require('../../src/run/launch.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split(path.sep).join('/');
const fwd = (p) => String(p).split(path.sep).join('/');
const QUESTION = NC.question({});
const CLOSING = NC.handback({ handback_question: true }); // the whole block a worker reads last
const PATHS = { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') };
const RESUME = 'task t1 state assigned; next step: (stated) none yet';

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-eval-rev-'));
  fs.mkdirSync(path.join(d, 'wt'));
  return { d, data: fwd(d), worktree: fwd(path.join(d, 'wt')), mem: fwd(path.join(d, 'mem')) };
}
// A fake core whose run row holds `stored` (an object, stringified, or a raw string); `base` shares the worker rows between managers.
const coreWith = (stored, base) => {
  const core = base ? Object.create(base) : createFakeCore({ runId: 'run-el', resumeLineText: RESUME });
  core.run = { get: async () => ({ run: { memory_levers: typeof stored === 'string' ? stored : JSON.stringify(stored) } }) };
  return core;
};
const make = (sb, core, runId) => createRunManager({ core, dataDir: sb.data, runId, paths: PATHS });
const settingsOf = (sb, id) => JSON.parse(fs.readFileSync(path.join(L.workerDir(sb.data, id), 'settings.json'), 'utf8'));
const recvOf = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).text);
const count = (text, needle) => text.split(needle).length - 1;

// ------------------------------------------------------------------ adoption across runs

test("another run's native_memory is not written into a run that did not opt in, and its relaunch is refused; a stop still goes through", async () => {
  const sb = sandbox(); const base = createFakeCore({ runId: 'run-el', resumeLineText: RESUME });
  process.env.FAKE_MEMORY_AUTO = 'echo';
  const m1 = make(sb, coreWith({ native_memory: sb.mem }, base), 'run-el');
  let m2 = null; let m3 = null;
  try {
    await m1.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-x' });
    assert.equal(settingsOf(sb, 'w-x').autoMemoryDirectory, sb.mem);
    await m1.stop({ worker_id: 'w-x', mode: 'kill', timeout_ms: 8000 });
    m2 = make(sb, coreWith({}, base), 'run-other'); // a different run, no lever
    await assert.rejects(m2.restart({ worker_id: 'w-x', first_turn_timeout_ms: 20000 }), (e) => /recorded by another run/.test(e.message));
    assert.equal(settingsOf(sb, 'w-x').autoMemoryEnabled, false, "the folder is not in the other run's settings");
    assert.equal('autoMemoryDirectory' in settingsOf(sb, 'w-x'), false);
    assert.equal(m2._worker('w-x').nativeMemory, sb.mem, 'the record is kept');
    await m2.stop({ worker_id: 'w-x', mode: 'kill', timeout_ms: 8000 }); // a stop of the adopted worker is not refused
    m3 = make(sb, coreWith({ native_memory: sb.mem }, base), 'run-third'); // a run whose own lever names the folder
    await m3.restart({ worker_id: 'w-x', first_turn_timeout_ms: 45000 });
    assert.equal(m3._worker('w-x').state, 'running');
    assert.equal(settingsOf(sb, 'w-x').autoMemoryDirectory, sb.mem);
  } finally { delete process.env.FAKE_MEMORY_AUTO; for (const m of [m3, m2, m1]) if (m) await m.shutdown?.().catch(() => {}); cleanup(sb.d); }
});

test("the same run keeps a worker's native_memory across adapters, even when its lever is not set (the spawn argument)", async () => {
  const sb = sandbox(); const base = createFakeCore({ runId: 'run-el', resumeLineText: RESUME });
  process.env.FAKE_MEMORY_AUTO = 'echo';
  const m1 = make(sb, coreWith({}, base), 'run-el'); let m2 = null;
  try {
    await m1.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-s', native_memory: sb.mem });
    await m1.stop({ worker_id: 'w-s', mode: 'kill', timeout_ms: 8000 });
    m2 = make(sb, coreWith({}, base), 'run-el');
    await m2.restart({ worker_id: 'w-s', first_turn_timeout_ms: 45000 });
    assert.equal(m2._worker('w-s').state, 'running');
    assert.equal(settingsOf(sb, 'w-s').autoMemoryDirectory, sb.mem);
  } finally { delete process.env.FAKE_MEMORY_AUTO; for (const m of [m2, m1]) if (m) await m.shutdown?.().catch(() => {}); cleanup(sb.d); }
});

// ------------------------------------------------------------------ levers stored but unreadable

test('a stored lever that cannot be read refuses the spawn with E_LEVERS_UNREAD and leaves no record', async () => {
  for (const [substrate, stored] of [['claude-code', '{not json'], ['claude-code', { handback_question: 'yes' }], ['claude-code', { native_memory: 7 }], ['claude-code', '7'], ['codex', '{not json'], ['codex', { handback_question: 'yes' }]]) {
    const sb = sandbox(); const m = make(sb, coreWith(stored), 'run-el');
    try {
      await assert.rejects(m.spawn({ substrate, worktree: sb.worktree, prompt: 'hi', worker_id: 'w-u' }), (e) => e.code === 'E_LEVERS_UNREAD', substrate + JSON.stringify(stored));
      assert.equal(m._worker('w-u'), undefined);
      assert.equal(fs.existsSync(L.workerDir(sb.data, 'w-u')), false);
    } finally { await m.shutdown?.().catch(() => {}); cleanup(sb.d); }
  }
});

test('levers handed in by the adapter keep the unread marker, and a Codex worker is refused too', async () => {
  const lv = ML.leversOfRow({ memory_levers: '{not json' });
  assert.deepEqual({ ...lv }, { ...ML.DEFAULTS }, 'every other reader still gets the defaults');
  assert.ok(ML.unreadOf(lv));
  const sb = sandbox(); const m = createRunManager({ core: createFakeCore({ runId: 'run-el' }), dataDir: sb.data, runId: 'run-el', paths: PATHS, memoryLevers: lv });
  try {
    assert.throws(() => MP.nativeMemory({ memoryLevers: lv }, 'codex', 'w-cx', null), (e) => e.code === 'E_LEVERS_UNREAD');
    await assert.rejects(m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-ad' }), (e) => e.code === 'E_LEVERS_UNREAD');
    assert.equal(MP.nativeMemory({ memoryLevers: lv }, 'claude-code', 'scrub-1', null), null, 'a belay job needs neither lever');
  } finally { await m.shutdown?.().catch(() => {}); cleanup(sb.d); }
});

test('an invalid stored block that names no eval lever is still the defaults, as before', () => {
  const lv = ML.leversOfRow({ memory_levers: JSON.stringify({ observations: true }) });
  assert.equal(ML.unreadOf(lv), null);
  assert.deepEqual(lv, ML.DEFAULTS);
});

// ------------------------------------------------------------------ the question closes a resume with a message

test('a resume that carries an operator message still ends with the question, once', async () => {
  const sb = sandbox(); const recv = path.join(sb.d, 'recv.jsonl');
  const m = make(sb, coreWith({ handback_question: true }), 'run-el');
  process.env.FAKE_RECV_FILE = recv;
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'do it', worker_id: 'w-rm', task_id: 't1' });
    await m.pause({ worker_id: 'w-rm', by: 'operator:1' });
    await m.resume({ worker_id: 'w-rm', by: 'operator:1', message: 'OPERATOR SAYS GO LEFT' });
    const msgs = recvOf(recv); const last = msgs[msgs.length - 1];
    assert.equal(count(last, QUESTION), 1);
    assert.ok(last.includes('OPERATOR SAYS GO LEFT'));
    assert.ok(last.indexOf('OPERATOR SAYS GO LEFT') < last.indexOf(QUESTION), 'the message comes before the question');
    assert.ok(last.endsWith(CLOSING), 'the question block is the last thing the worker reads');
  } finally { delete process.env.FAKE_RECV_FILE; await m.shutdown?.().catch(() => {}); cleanup(sb.d); }
});

// ------------------------------------------------------------------ absent levers leave the record as it was

test('absent eval levers are not recorded: a memory-enabled spec has the levers and sources it always had', () => {
  const r = parseLevers({ memory: { project: 'prod', notes: true } });
  assert.equal(r.error, undefined);
  for (const k of ML.EVAL_ONLY) {
    assert.equal(k in r.memory_levers, false, k);
    assert.equal(k in r.memory_sources, false, k);
  }
  const given = parseLevers({ memory: { project: 'prod', notes: true }, handback_question: false });
  assert.equal(given.memory_levers.handback_question, false, 'a lever the spec supplied is recorded');
  assert.equal(given.memory_sources.handback_question, 'spec');
  assert.equal('native_memory' in given.memory_levers, false);
  assert.equal(parseLevers({}).memory_levers, undefined);
  assert.equal(parseLevers({ handback_question: false }).memory_levers, undefined, 'explicitly default is still a default block');
});

test('a bad memory block is refused with or without an eval key beside it', () => {
  for (const memory of [false, [], 7, 'x']) {
    const alone = parseLevers({ memory });
    const folded = parseLevers({ memory, handback_question: true });
    assert.match(String(alone.error), /memory must be an object/, JSON.stringify(memory));
    assert.equal(folded.error, alone.error, JSON.stringify(memory));
  }
});
