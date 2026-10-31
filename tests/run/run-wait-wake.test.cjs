'use strict';
require('../helpers/tmp.cjs');
// run-wait-wake.test.cjs — ADR 0074 decision 4, the interactive path: the wake is the path, the digest rides it as one more wake line within
// the wake cap, and an exception is delivered by the wake pipe or by worker_wait, never both. Real named pipe, the poll is the publisher's own.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');

const { startWakePublisher } = require('../../src/run/wake-pipe.cjs');
const { createRunWait } = require('../../src/run/run-wait.cjs');
const D = require('../../src/run/run-digest.cjs');

const RUN = 'r1';
const B = (s) => Buffer.byteLength(s, 'utf8');
const W = { id: 'W', seq: 5, run_id: RUN, state: 'done', policy: { fix: 'builder' }, depends_on: [], repairs: null, results: { trigger: 'release', evaluated_at: 20, executable: true, passed: true, checks: [{ kind: 'command', argv: ['npm', 'test'], passed: true }] }, handoff: { by: 'w1', at: 10 }, lease: null, review: null, integration: null, written_at: 50 };
let seqN = 100;
const step = (over = {}) => ({ seq: ++seqN, run_id: RUN, step: 'fix', task_id: 'W', outcome: 'done', row_ref: `task:fix${seqN}`, error: null, worker_id: 'coder', ...over });

function coreOf(steps) {
  const rows = [{ id: 'w1', run_id: RUN, state: 'running', turns: 0, seq: 1, pid_alive: true, mid_turn: 0 }];
  return {
    rows,
    worker: { list: async () => ({ workers: rows.map((r) => ({ ...r })) }) },
    task: { list: async () => ({ tasks: [W] }) },
    integration: { list: async () => ({ integrations: [] }) },
    policy: { list: async () => ({ rows: steps.map((s) => ({ ...s })), last_seq: steps.length }) },
    memory: { events: async () => ({ events: [] }) },
  };
}

async function publisher(core, dataDir) {
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\belay-test-rw-${crypto.randomBytes(5).toString('hex')}` : path.join(os.tmpdir(), `belay-test-rw-${crypto.randomBytes(5).toString('hex')}.sock`);
  const pub = startWakePublisher({ core, runId: RUN, dataDir, pipeName: pipe, pollMs: 20 });
  await pub.listening;
  const lines = [];
  const sock = net.connect(pipe);
  let buf = '';
  sock.on('data', (d) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  sock.on('error', () => {});
  const until = async (fn) => { for (let n = 0; n < 400 && !fn(); n++) await new Promise((r) => setTimeout(r, 20)); return fn(); };
  return { pub, lines, until, done: async () => { sock.destroy(); await pub.stop(); } };
}

test('the digest rides the wake as one more wake line inside the wake cap, and worker_wait does not show those steps again', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-rw-wake-')).replace(/\\/g, '/');
  const steps = Array.from({ length: 12 }, (_, i) => step({ task_id: `task-${i}` }));
  const core = coreOf(steps);
  const p = await publisher(core, dataDir);
  try {
    core.rows[0] = { ...core.rows[0], turns: 1, seq: 2 }; // a turn end: the poll reads the tasks and arms the policy watcher
    assert.ok(await p.until(() => p.lines.some((l) => l.text && /^belay: policy steps since the last wake: /.test(l.text))), JSON.stringify(p.lines));
    const dig = p.lines.find((l) => l.text && /^belay: policy steps since the last wake: /.test(l.text));
    assert.ok(B(dig.text) <= 221, `${B(dig.text)} B`);
    assert.match(dig.text, /\(\+\d+ earlier policy steps not shown\)/, 'twelve steps do not fit one wake line: the count says how many were left out');
    assert.ok(p.lines.findIndex((l) => l === dig) > p.lines.findIndex((l) => l.text && /exception E1,/.test(l.text)), 'it follows the wake it rides');
    const wakesBefore = p.lines.filter((l) => l.text).length;
    await new Promise((r) => setTimeout(r, 120));
    assert.strictEqual(p.lines.filter((l) => l.text).length, wakesBefore, 'nothing is published twice');
    const field = await D.receiptField(core, dataDir, RUN);
    assert.strictEqual(field.digests.length, 1);
    assert.strictEqual(field.digests[0].via, 'wake');
    assert.strictEqual(field.digests[0].lines.length + field.digests[0].dropped.count, 12, 'every step is shown or counted');
    // The wait now has nothing of those steps to show, and a new one is shown once.
    const clock = { t: 0, now: () => clock.t, sleep: async (ms) => { clock.t += ms; } };
    const rw = createRunWait({ core, runId: RUN, dataDir, pollMs: 50, clock });
    const quiet = await rw.wait({ ms: 100, t0: 0, workers: [] });
    assert.strictEqual(quiet.digest, undefined);
    steps.push(step({ task_id: 'later' }));
    const later = await rw.wait({ ms: 100, t0: clock.t, workers: [] });
    assert.strictEqual(later.digest.steps, 1);
    assert.match(later.digest.text, /later done/);
  } finally { await p.done(); }
});

test('an exception the run wait already returned is not published on the pipe, and the reverse', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-rw-wake-')).replace(/\\/g, '/');
  const core = coreOf([]);
  const policyWakes = require('../../src/run/policy-wakes.cjs');
  const probe = (await policyWakes.createPolicyWatcher({ core, runId: RUN, enabled: true }).poll({ policyTasks: [W], policyArmed: true }))[0];
  assert.strictEqual(probe.exception, 'E1');
  // The wait delivered it first.
  assert.ok(D.claimException({ dataDir, runId: RUN, uid: `${probe.worker_id}:${probe.key}` }));
  const p = await publisher(core, dataDir);
  try {
    core.rows[0] = { ...core.rows[0], turns: 1, seq: 2 };
    const polls = p.pub.stats().polls;
    assert.ok(await p.until(() => p.pub.stats().polls >= polls + 4));
    assert.deepStrictEqual(p.lines.filter((l) => l.text && /exception E1/.test(l.text)), [], 'not published: the wait has it');
    assert.deepStrictEqual(p.pub.receipt().filter((r) => r.exception), [], 'and not in the interactive receipt');
  } finally { await p.done(); }
  // The pipe delivered it first: the wait does not return it.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-rw-wake-')).replace(/\\/g, '/');
  const core2 = coreOf([]);
  const q = await publisher(core2, dir2);
  try {
    core2.rows[0] = { ...core2.rows[0], turns: 1, seq: 2 };
    assert.ok(await q.until(() => q.lines.some((l) => l.text && /exception E1,/.test(l.text))));
    core2.task.list = async () => ({ tasks: [W] });
    const clock = { t: 0, now: () => clock.t, sleep: async (ms) => { clock.t += ms; } };
    const r = await createRunWait({ core: core2, runId: RUN, dataDir: dir2, pollMs: 50, clock }).wait({ ms: 100, t0: 0, workers: [] });
    assert.strictEqual(r.exceptions, undefined, 'the pipe has it');
    assert.strictEqual(r.timed_out, true);
  } finally { await q.done(); }
});

test('a publisher with no data dir behaves as before: no claim, no digest line', async () => {
  const core = coreOf([step()]);
  const p = await publisher(core, null);
  try {
    core.rows[0] = { ...core.rows[0], turns: 1, seq: 2 };
    assert.ok(await p.until(() => p.lines.some((l) => l.text && /exception E1,/.test(l.text))));
    const polls = p.pub.stats().polls;
    assert.ok(await p.until(() => p.pub.stats().polls >= polls + 3));
    assert.ok(!p.lines.some((l) => l.text && /policy steps since/.test(l.text)));
  } finally { await p.done(); }
});

// A worker death is delivered once too: by the pipe or by worker_wait, whichever claims it first (the key is worker, kind, turn).
const w2 = (extra = {}) => ({ id: 'w2', run_id: RUN, state: 'running', turns: 3, seq: 1, pid: 4242, pid_created: 99, pid_alive: true, mid_turn: 0, ...extra });
const LIFE = D.lifeOf(4242, 99);
const deadRecord = { id: 'w2', pid: 4242, pidCreated: 99, launches: 1, settled: true, settledState: 'dead', state: 'dead', deathEstablishedBy: 'pid check', exitCode: 1, exitSignal: null, turns: 3 };
const clockOf = () => { const c = { t: 0, now: () => c.t, sleep: async (ms) => { c.t += ms; } }; return c; };

test('a death the run wait already returned is not published on the pipe', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-rw-wake-')).split(path.sep).join('/');
  const core = coreOf([]);
  core.rows.push(w2());
  assert.ok(D.claimException({ dataDir, runId: RUN, uid: D.deathUid('w2', 'death', LIFE) }), 'worker_wait named it');
  const p = await publisher(core, dataDir);
  try {
    core.rows[0] = { ...core.rows[0], turns: 1, seq: 2 }; // arms the plan
    core.rows[1] = w2({ state: 'dead', seq: 2, exit_code: 1 });
    assert.ok(await p.until(() => p.lines.some((l) => l.text && /exception E1,/.test(l.text))));
    const polls = p.pub.stats().polls;
    assert.ok(await p.until(() => p.pub.stats().polls >= polls + 4));
    assert.deepStrictEqual(p.lines.filter((l) => l.text && /w2/.test(l.text) && !/finished turn/.test(l.text)), [], 'the death is not published');
  } finally { await p.done(); }
});

test('a death the pipe published is not returned by the run wait', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-rw-wake-')).split(path.sep).join('/');
  const core = coreOf([]);
  core.rows.push(w2());
  const p = await publisher(core, dataDir);
  try {
    core.rows[0] = { ...core.rows[0], turns: 1, seq: 2 };
    core.rows[1] = w2({ state: 'dead', seq: 2, exit_code: 1 });
    assert.ok(await p.until(() => p.lines.some((l) => l.text && /w2/.test(l.text))), JSON.stringify(p.lines));
    const c = clockOf();
    const r = await createRunWait({ core, runId: RUN, dataDir, pollMs: 50, clock: c }).wait({ ms: 100, t0: 0, workers: [deadRecord] });
    assert.ok(!r.exceptions || !r.exceptions.some((e) => e.exception === 'E4'), 'the pipe delivered it');
  } finally { await p.done(); }
  // And with nothing on the pipe the wait does name it, once.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-rw-wake-')).split(path.sep).join('/');
  const rw = createRunWait({ core: coreOf([]), runId: RUN, dataDir: dir2, pollMs: 50, clock: clockOf() });
  const first = await rw.wait({ ms: 100, t0: 0, workers: [deadRecord] });
  assert.deepStrictEqual(first.exceptions.filter((e) => e.exception === 'E4').map((e) => [e.exception, e.worker_id]), [['E4', 'w2']]);
  assert.strictEqual(D.claimException({ dataDir: dir2, runId: RUN, uid: D.deathUid('w2', 'death', LIFE) }), false, 'so the pipe would not');
});

test('a death is claimed on the pipe when the store shows a plan, with no turn end before it', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-rw-wake-')).split(path.sep).join('/');
  const core = coreOf([]);
  core.rows.push(w2());
  assert.ok(D.claimException({ dataDir, runId: RUN, uid: D.deathUid('w2', 'death', LIFE) }), 'worker_wait named it');
  const p = await publisher(core, dataDir);
  try {
    core.rows[1] = w2({ state: 'dead', seq: 2, exit_code: 1 }); // only the death: nothing armed the plan but the store's own task
    const polls = p.pub.stats().polls;
    assert.ok(await p.until(() => p.pub.stats().polls >= polls + 5));
    assert.deepStrictEqual(p.lines.filter((l) => l.text && /w2/.test(l.text) && !/finished turn/.test(l.text)), [], 'the death is not published');
  } finally { await p.done(); }
});
