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

test('the orchestrator is never given the folder: no orchestrator launch code names the lever', () => {
  const dir = path.join(__dirname, '..', '..', 'src', 'run');
  for (const f of fs.readdirSync(dir).filter((n) => /^orchestrator/.test(n))) {
    assert.ok(!/native_?[mM]emory/.test(fs.readFileSync(path.join(dir, f), 'utf8')), f);
  }
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
  assert.ok(!first.includes('lease_release') && !first.includes('`notes`') && !first.includes('Notes for the next worker'));
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
