'use strict';
// eval-levers.test.cjs — the two eval-only, off-by-default run-spec levers of the 0.3.2 memory eval: `native_memory` (every Claude
// Code worker of the run shares one auto-memory folder; the orchestrator never gets it) and `handback_question` (with notes off, the
// hand-back question reaches each eligible worker exactly once). Spec validation and refusal, the worker spawn, and the message.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseLevers } = require('../../src/cli/run-levers.cjs');
const { parseSpec, KNOWN_KEYS } = require('../../src/cli/run-spec.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const NC = require('../../src/run/notes-contract.cjs');
const L = require('../../src/run/launch.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split(path.sep).join('/');
const fwd = (p) => String(p).split(path.sep).join('/');
const QUESTION = NC.question({});
const ABS = process.platform === 'win32' ? 'C:/eval-levers-test/mem' : '/tmp/eval-levers-test/mem';

// ------------------------------------------------------------------ spec

test('spec: both keys are known, off by default, and a run without them has no memory levers at all', () => {
  assert.ok(KNOWN_KEYS.has('native_memory') && KNOWN_KEYS.has('handback_question'));
  assert.equal(parseLevers({}).memory_levers, undefined);
  const on = parseLevers({ native_memory: ABS, handback_question: true });
  assert.equal(on.error, undefined);
  assert.equal(on.memory_levers.native_memory, ABS);
  assert.equal(on.memory_levers.handback_question, true);
});

test('spec: a bad native_memory or handback_question refuses the run at load', () => {
  const bad = [
    [{ native_memory: 'rel/dir' }, /absolute/], [{ native_memory: '' }, /absolute/], [{ native_memory: 7 }, /absolute/],
    [{ native_memory: fwd(path.join(os.homedir(), '.claude', 'projects', 'x', 'memory')) }, /config directory/],
    [{ handback_question: 'yes' }, /true or false/], [{ handback_question: 1 }, /true or false/],
    [{ native_memory: ABS, memory: { native_memory: ABS } }, /both/],
  ];
  for (const [spec, re] of bad) {
    const r = parseLevers(spec);
    assert.match(String(r.error), re, JSON.stringify(spec));
  }
});

test('spec: parseSpec refuses before anything is created, and accepts the good pair', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-eval-levers-'));
  try {
    fs.mkdirSync(path.join(d, 'wt')); fs.writeFileSync(path.join(d, 'p.txt'), 'go');
    const spec = (extra) => {
      const f = path.join(d, 'spec.json');
      fs.writeFileSync(f, JSON.stringify({ worktree: fwd(path.join(d, 'wt')), prompt_file: fwd(path.join(d, 'p.txt')), ...extra }));
      return f;
    };
    assert.match(parseSpec(spec({ native_memory: 'relative' }), d).error, /absolute/);
    const ok = parseSpec(spec({ native_memory: ABS, handback_question: true }), d);
    assert.equal(ok.error, undefined);
    assert.equal(ok.levers.memory_levers.native_memory, ABS);
    assert.equal(fs.existsSync(ABS), false, 'validation creates no folder');
  } finally { cleanup(d); }
});

test('the orchestrator is never given the folder: its settings are written without the lever', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'run', 'launch.cjs'), 'utf8');
  const body = src.slice(src.indexOf('function writeOrchestratorFiles('), src.indexOf('function orchestratorLaunchArgv('));
  assert.ok(body.length > 200 && /workerSettings[(]/.test(body), 'the orchestrator writer is found');
  assert.ok(!/native_?[mM]emory/.test(body), 'it names no native-memory lever');
});

// ------------------------------------------------------------------ worker spawn

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-eval-levers-'));
  fs.mkdirSync(path.join(d, 'wt'));
  return { d, data: fwd(d), worktree: fwd(path.join(d, 'wt')), mem: fwd(path.join(d, 'mem')) };
}
const coreWith = (levers) => {
  const core = createFakeCore({ runId: 'run-el', resumeLineText: 'task t1 state assigned; next step: (stated) none yet' });
  core.run = { get: async () => ({ run: { memory_levers: JSON.stringify(levers) } }) };
  return core;
};
const mgr = (sb, levers) => createRunManager({
  core: coreWith(levers), dataDir: sb.data, runId: 'run-el',
  paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
});
const settingsOf = (sb, id) => JSON.parse(fs.readFileSync(path.join(L.workerDir(sb.data, id), 'settings.json'), 'utf8'));

test('every Claude Code worker of the run shares the one folder; Codex is untouched', async () => {
  const sb = sandbox(); const m = mgr(sb, { native_memory: sb.mem });
  process.env.FAKE_MEMORY_AUTO = 'echo';
  try {
    for (const id of ['w-a', 'w-b']) {
      const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: id });
      assert.equal(row.state, 'running');
      assert.equal(settingsOf(sb, id).autoMemoryDirectory, sb.mem, id);
      assert.equal(settingsOf(sb, id).autoMemoryEnabled, true);
      assert.equal(m._worker(id).nativeMemory, sb.mem);
    }
    assert.ok(fs.statSync(sb.mem).isDirectory());
    const MP = require('../../src/run/memory-preface.cjs'); const ctx = { memoryLevers: { native_memory: sb.mem } };
    assert.equal(await MP.nativeMemory(ctx, 'codex', 'w-cx', null), null, 'Codex has no auto-memory, so the run lever is not applied');
    assert.equal(await MP.nativeMemory(ctx, 'claude-code', 'scrub-1', null), null, 'nor to a belay job');
    assert.equal(await MP.nativeMemory(ctx, 'claude-code', 'w-z', '/given'), '/given', 'an explicit argument wins');
  } finally { delete process.env.FAKE_MEMORY_AUTO; await m.shutdown?.().catch(() => {}); cleanup(sb.d); }
});

test('without the lever a worker has no folder and auto-memory stays off', async () => {
  const sb = sandbox(); const m = mgr(sb, {});
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-off' });
    assert.equal(settingsOf(sb, 'w-off').autoMemoryEnabled, false);
    assert.equal('autoMemoryDirectory' in settingsOf(sb, 'w-off'), false);
    assert.equal(m._worker('w-off').nativeMemory, null);
  } finally { await m.shutdown?.().catch(() => {}); cleanup(sb.d); }
});

// ------------------------------------------------------------------ the question

const count = (text, needle) => text.split(needle).length - 1;
async function firstMessage(levers, workerId = 'w1') {
  const sb = sandbox(); const m = mgr(sb, levers);
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'implement the thing', worker_id: workerId, task_id: 't1' });
    return m._worker(workerId).firstMessage;
  } finally { await m.shutdown?.().catch(() => {}); cleanup(sb.d); }
}

test('notes off, handback_question on: the question closes the message exactly once, without the note contract', async () => {
  const first = await firstMessage({ handback_question: true });
  assert.equal(count(first, QUESTION), 1);
  assert.ok(first.endsWith('or give it in your hand-back.'));
  assert.ok(first.includes('where this project keeps durable notes for later sessions') && !first.includes('CLAUDE.md'), 'the destination is no named file');
  assert.ok(first.includes('implement the thing'));
  // belay's own hand-back rule names lease_release once (handback.cjs); the note contract (`notes`, the notes question) is absent.
  assert.equal(count(first, 'lease_release'), 1);
  assert.ok(!first.includes('`notes`') && !first.includes('Notes for the next worker'));
  assert.ok(!first.includes('{{'));
});

test('it reaches every eligible worker role once, and not a belay job', async () => {
  assert.equal(count(await firstMessage({ handback_question: true }, 'reviewer-1'), QUESTION), 1);
  assert.equal(count(await firstMessage({ handback_question: true }, 'notereview-x'), QUESTION), 0);
});

test('lever off, or notes on: the message is what it always was and the question is not added twice', async () => {
  assert.equal(count(await firstMessage({}), QUESTION), 0);
  const withNotes = await firstMessage({ project: 'demo', notes: true });
  assert.equal(count(withNotes, QUESTION), 1, 'the contract carries it once');
  const both = await firstMessage({ project: 'demo', notes: true, handback_question: true });
  assert.equal(both, withNotes, 'handback_question changes nothing with notes on');
  assert.equal(NC.handback({ notes: true, handback_question: true }), '');
});

// ------------------------------------------------------------------ M1/M2: spec and config

test('memory: null inherits nothing from the config, eval keys or not', () => {
  const config = { path: '/p/belay.config.json', memory: { project: 'demo', first_message_index: true } };
  const plain = parseLevers({ memory: null, handback_question: true }, { config });
  assert.equal(plain.error, undefined);
  assert.deepEqual(plain.memory_levers && { q: plain.memory_levers.handback_question, p: plain.memory_levers.project, f: plain.memory_levers.first_message_index }, { q: true, p: null, f: false });
  assert.equal(parseLevers({ memory: {}, handback_question: true }, { config }).memory_levers.project, 'demo', 'an empty block still inherits');
});

test('the config memory block cannot carry an eval-only lever', () => {
  for (const memory of [{ handback_question: true }, { native_memory: ABS }]) {
    const r = parseLevers({}, { config: { path: '/p/belay.config.json', memory } });
    assert.match(String(r.error), /eval-only/, JSON.stringify(memory));
  }
});

// ------------------------------------------------------------------ the question across launches

const recvOf = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).text);

test('the guard that keeps the question from a belay job holds on its own', () => {
  const MP = require('../../src/run/memory-preface.cjs');
  const ctx = { memoryLevers: { handback_question: true } };
  return Promise.all([MP.contractTail(ctx, { id: 'notereview-x', notesOn: false }), MP.contractTail(ctx, { id: 'scrub-1', notesOn: false }), MP.contractTail(ctx, { id: 'w1', notesOn: false })])
    .then(([review, scrub, worker]) => {
      assert.equal(review, ''); assert.equal(scrub, '');
      assert.equal(count(worker, QUESTION), 1);
    });
});

test('a restart, a park-resume and an adopting manager each send the question exactly once', async () => {
  const sb = sandbox(); const recv = path.join(sb.d, 'recv.jsonl');
  const core = coreWith({ handback_question: true });
  const make = () => createRunManager({ core, dataDir: sb.data, runId: 'run-el', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  const m1 = make(); let m2 = null;
  process.env.FAKE_RECV_FILE = recv;
  try {
    await m1.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'do it', worker_id: 'w-rl', task_id: 't1' });
    assert.equal(count(recvOf(recv)[0], QUESTION), 1, 'the opening message');
    await m1.stop({ worker_id: 'w-rl', mode: 'kill', timeout_ms: 8000 });
    await m1.restart({ worker_id: 'w-rl', first_turn_timeout_ms: 45000 });
    let msgs = recvOf(recv);
    assert.equal(count(msgs[msgs.length - 1], QUESTION), 1, 'restart');
    await m1.pause({ worker_id: 'w-rl', by: 'operator:1' });
    await m1.resume({ worker_id: 'w-rl', by: 'operator:1' });
    msgs = recvOf(recv);
    assert.equal(count(msgs[msgs.length - 1], QUESTION), 1, 'resume');
    await m1.stop({ worker_id: 'w-rl', mode: 'kill', timeout_ms: 8000 });
    m2 = make();
    const n = recvOf(recv).length;
    await m2.restart({ worker_id: 'w-rl', first_turn_timeout_ms: 45000 });
    msgs = recvOf(recv);
    assert.equal(msgs.length, n + 1);
    assert.equal(count(msgs[msgs.length - 1], QUESTION), 1, 'an adopting manager');
  } finally { delete process.env.FAKE_RECV_FILE; if (m2) await m2.shutdown().catch(() => {}); await m1.shutdown().catch(() => {}); cleanup(sb.d); }
});

test('a failed levers read refuses the spawn when native_memory is unknowable, and names it', async () => {
  const sb = sandbox();
  const core = coreWith({ native_memory: sb.mem });
  core.run = { get: async () => { throw Object.assign(new Error('owner gone'), { code: 'E_INTERNAL' }); } };
  const m = createRunManager({ core, dataDir: sb.data, runId: 'run-el', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  try {
    await assert.rejects(m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-un' }), (e) => e.code === 'E_LEVERS_UNREAD' && /native_memory/.test(e.message));
    assert.equal(m._worker('w-un'), undefined, 'no record was left');
    assert.equal(fs.existsSync(sb.mem), false);
  } finally { await m.shutdown?.().catch(() => {}); cleanup(sb.d); }
});
