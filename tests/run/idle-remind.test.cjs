'use strict';
// idle-remind.test.cjs — ADR 0058 amendment 1 (proposed): worker_wait's answer and, when there is room, a wake name the workers
// left idle with no task. Pure checks of the selection and the text, then the real core and run manager with the fake substrate.
// The threshold is a parameter here, and BELAY_IDLE_REMIND_MS (test mode only) for the run manager: nothing waits it out.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const IR = require('../../src/run/idle-remind.cjs');
const { wakeText } = require('../../src/run/wake.cjs');
const { WAKE_TEXT_MAX } = require('../../src/run/release-eval.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { sandbox, cleanup, callerFor } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split(path.sep).join('/');
const RUN = 'idle-remind-run';

const row = (id, over = {}) => ({ id, run_id: RUN, state: 'running', mid_turn: 0, pid_alive: true, last_event_age_ms: 5000, turns: 1, ...over });
const coreWith = (tasks) => ({ task: { list: async () => ({ tasks }) } });
const leaseOf = (holder) => ({ id: `t-${holder}`, state: 'assigned', lease: { holder, holder_role: 'worker' } });

test('only a live worker between turns, idle past the threshold, with no lease and not a belay job, is named', async () => {
  const rows = [
    row('idle'), row('leased'), row('busy', { mid_turn: 1 }), row('young', { last_event_age_ms: 10 }), row('gone', { pid_alive: false }),
    row('codex', { state: 'idle' }), row('other-run', { run_id: 'x' }), row('scrub-1'),
  ];
  const got = (await IR.idleRows(coreWith([leaseOf('leased')]), rows, RUN, 1000)).map((r) => r.id);
  assert.deepStrictEqual(got, ['idle']);
  assert.deepStrictEqual(await IR.idleRows({ task: { list: async () => { throw new Error('down'); } } }, rows, RUN, 1000), [], 'unreadable leases: no claim');
});

test('a wake names the idle workers once per idle period, inside the interactive budget, and never as a wake of its own', async () => {
  const reminded = new Set();
  const core = coreWith([]);
  assert.deepStrictEqual(await IR.remindIdle(core, RUN, [row('idle')], [], reminded, 1000), [], 'no event, no wake');
  const [ev] = await IR.remindIdle(core, RUN, [row('idle')], [{ worker_id: 'w9', event: 'turn_end', turn: 2, seq: 1 }], reminded, 1000);
  const text = wakeText(ev);
  assert.match(text, /Idle without a task: idle\.$/);
  assert.ok(Buffer.byteLength(text, 'utf8') <= WAKE_TEXT_MAX, `${Buffer.byteLength(text, 'utf8')} bytes`);
  const [again] = await IR.remindIdle(core, RUN, [row('idle')], [{ worker_id: 'w9', event: 'turn_end', turn: 3, seq: 2 }], reminded, 1000);
  assert.strictEqual(again.idle_without_task, undefined, 'the same idle period is named once');
  const [later] = await IR.remindIdle(core, RUN, [row('idle', { turns: 2 })], [{ worker_id: 'w9', event: 'turn_end', turn: 4, seq: 3 }], reminded, 1000);
  assert.deepStrictEqual(later.idle_without_task, ['idle'], 'a new idle period, after another turn, is named again');
  // Too many to list: the count; no room at all: the text is left as it was.
  const many = Array.from({ length: 12 }, (_, i) => `worker-with-a-long-id-${i}`);
  assert.match(IR.withIdle('belay: x.', many, WAKE_TEXT_MAX), /12 workers idle without a task\.$/);
  const full = 'x'.repeat(WAKE_TEXT_MAX - 5);
  assert.strictEqual(IR.withIdle(full, ['a'], WAKE_TEXT_MAX), full);
});

test('worker_wait names the idle worker that holds no lease, and not the one that does', { timeout: 90000 }, async () => {
  const dir = sandbox();
  const core = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: RUN }), embed: false });
  const wt = path.join(dir, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  const saved = { mode: process.env.BELAY_TEST_MODE, ms: process.env.BELAY_IDLE_REMIND_MS };
  let m = null;
  try {
    await core.run.attach({ adapter_pid: process.pid });
    const task = await core.task.create({ spec: 'held', files_owned: [] });
    m = createRunManager({ core: core.harness(), dataDir: dir, runId: RUN, paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
    const opts = { substrate: 'claude-code', worktree: wt.split(path.sep).join('/'), prompt: 'one' };
    await m.spawn({ ...opts, worker_id: 'free' });
    await m.spawn({ ...opts, worker_id: 'held', task_id: task.id });
    for (const id of ['free', 'held']) await m.wait({ worker_ids: [id], timeout_ms: 30000 }); // both first turns ended
    process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_IDLE_REMIND_MS = '0';
    const ans = await m.wait({ worker_ids: ['held'], timeout_ms: 5000 });
    assert.deepStrictEqual(ans.idle_without_task, ['free'], JSON.stringify(ans));
    process.env.BELAY_IDLE_REMIND_MS = '3600000';
    assert.strictEqual((await m.wait({ worker_ids: ['held'], timeout_ms: 5000 })).idle_without_task, undefined, 'under the threshold nothing is named');
  } finally {
    for (const [k, v] of [['BELAY_TEST_MODE', saved.mode], ['BELAY_IDLE_REMIND_MS', saved.ms]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (m) { try { await m.shutdown(); } catch { /* best effort */ } }
    try { await core.shutdownOwner(); } catch { /* best effort */ }
    await core.close();
    cleanup(dir);
  }
});

test('the interactive wake publisher carries the reminder on the next wake it publishes', { timeout: 30000 }, async () => {
  const net = require('node:net');
  const crypto = require('node:crypto');
  const os = require('node:os');
  const { startWakePublisher } = require('../../src/run/wake-pipe.cjs');
  const pipe = process.platform === 'win32' ? `//./pipe/belay-test-idle-${crypto.randomBytes(5).toString('hex')}` : path.join(os.tmpdir(), `belay-test-idle-${crypto.randomBytes(5).toString('hex')}.sock`);
  const rows = { now: [row('w1', { turns: 0, seq: 1, last_event_age_ms: 10 }), row('idle', { turns: 0, seq: 2 })] };
  let polls = 0; let polled = null;
  const core = {
    worker: { list: async () => { polls += 1; if (polled) polled(); return { workers: rows.now.map((r) => ({ ...r })) }; } },
    task: { list: async () => ({ tasks: [] }) },
  };
  const saved = { mode: process.env.BELAY_TEST_MODE, ms: process.env.BELAY_IDLE_REMIND_MS };
  process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_IDLE_REMIND_MS = '1000';
  const pub = startWakePublisher({ core, runId: RUN, pipeName: pipe, pollMs: 10 });
  let sock = null;
  try {
    await pub.listening;
    await new Promise((r) => { polled = r; }); // the baseline poll
    polled = null;
    rows.now = [row('w1', { turns: 1, seq: 3, last_event_age_ms: 10 }), row('idle', { turns: 0, seq: 2 })];
    const got = new Promise((resolve) => {
      let buf = '';
      sock = net.connect(pipe);
      sock.on('error', () => {});
      sock.on('data', (d) => { buf += d.toString('utf8'); for (const l of buf.split('\n')) { try { const j = JSON.parse(l); if (j.id) resolve(j); } catch { /* partial */ } } });
    });
    const w = await got;
    assert.match(w.text, /^belay: worker w1 finished turn 1\..* Idle without a task: idle\.$/, w.text);
    assert.ok(Buffer.byteLength(w.text, 'utf8') <= WAKE_TEXT_MAX);
  } finally {
    for (const [k, v] of [['BELAY_TEST_MODE', saved.mode], ['BELAY_IDLE_REMIND_MS', saved.ms]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (sock) sock.destroy();
    await pub.stop();
  }
});
