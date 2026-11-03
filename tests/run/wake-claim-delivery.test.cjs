'use strict';
require('../helpers/tmp.cjs');
// A policy exception or a worker death under a plan is claimed when the wake publisher publishes it. The claim must not outlive a delivery
// that never happened: if the mod's delivered-wakes file does not name the wake within a bound, the claim is released and worker_wait
// returns it. A wake the file does name stays claimed.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startWakePublisher, wakePipeName } = require('../../src/run/wake-pipe.cjs');
const { createRunWait } = require('../../src/run/run-wait.cjs');
const D = require('../../src/run/run-digest.cjs');
const { shortRef, withRef, WAKE_TEXT_MAX } = require('../../src/run/wake-ref.cjs');

const runId = 'run-claim';
const WID = 'coder-1';
const PID = 999991;
const CREATED = '133000000000000000';
const BOUND = 1000;
const NL = String.fromCharCode(10);

const fakeCore = (t0) => ({
  worker: { list: async () => ({ workers: [{ id: WID, run_id: runId, state: 'dead', turns: 1, pid: PID, pid_created: CREATED, exited_at: t0 + 60000, exit_code: 1 }] }) },
  run: { get: async () => ({ run: { id: runId, policy_default: { review: true } } }) },
  task: { list: async () => ({ tasks: [] }) },
  policy: { list: async () => ({ rows: [] }) },
});
const workersRec = [{ id: WID, settled: true, state: 'dead', pid: PID, pidCreated: CREATED, exitCode: 1, turns: 1, deathEstablishedBy: 'process exit' }];
const until = async (f) => { for (let i = 0; i < 400; i += 1) { if (f()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };

async function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wclaim-'));
  const dataDir = path.join(base, 'data').replaceAll(path.sep, '/'); fs.mkdirSync(dataDir);
  const deliveredFile = `${base.replaceAll(path.sep, '/')}/wakes-delivered.jsonl`;
  const clock = { skew: 0 };
  const now = () => Date.now() + clock.skew;
  const t0 = now();
  const core = fakeCore(t0);
  const pub = startWakePublisher({ core, runId, dataDir, pipeName: wakePipeName(dataDir, runId, 'n-claim'), pollMs: 20, now, deliveredFile, deliveryBoundMs: BOUND });
  await pub.listening;
  assert.ok(await until(() => pub.stats().published >= 1), 'the death was published');
  const uid = D.deathUid(WID, 'death', D.lifeOf(PID, CREATED));
  // ONE run wait for the whole test, as the adapter keeps one for its life (a fresh one per call would hide what a wait remembers)
  const rw = createRunWait({ core, runId, dataDir, claimant: { pid: process.pid, created: 'x' }, watcher: { poll: async () => [] }, pollMs: 10 });
  const wait = () => rw.wait({ ms: 60, workers: workersRec });
  return { base, dataDir, deliveredFile, clock, pub, uid, wait };
}

test('a claimed wake the mod never delivered is released after the bound, and worker_wait returns it', async () => {
  const s = await setup();
  try {
    assert.strictEqual(D.isClaimed({ dataDir: s.dataDir, runId, uid: s.uid }), true, 'claimed at publish');
    assert.strictEqual((await s.wait()).event, null, 'inside the bound the wake is held for the mod');
    const net = require('node:net');
    const line = await new Promise((resolve) => { // read before the release: a released wake is no longer replayed to a new client
      const c = net.connect(wakePipeName(s.dataDir, runId, 'n-claim')); let buf = '';
      c.on('data', (d) => { buf += d; const l = buf.split(NL).find((x) => x.includes('(ref ')); if (l) { c.destroy(); resolve(l); } });
    });
    s.clock.skew = BOUND + 500;
    assert.ok(await until(() => !D.isClaimed({ dataDir: s.dataDir, runId, uid: s.uid })), 'the claim is released once the bound passes undelivered');
    const r = await s.wait();
    assert.strictEqual(r.event, 'exception');
    assert.strictEqual(r.exceptions[0].worker_id, WID);
    assert.strictEqual(r.exceptions[0].ref, shortRef(s.uid), 'the entry names the short delivery key, so a repeat is recognisable');
    assert.strictEqual(s.pub.stats().released.length, 1, 'the release is recorded for the receipt');
    assert.strictEqual(s.pub.stats().released[0].uid, s.uid);
    assert.ok(JSON.parse(line).text.endsWith(`(ref ${r.exceptions[0].ref})`), 'the wake line carries the same key');
  } finally { await s.pub.stop(); fs.rmSync(s.base, { recursive: true, force: true }); }
});

test('a wake the delivered file names stays claimed past the bound', async () => {
  const s = await setup();
  try {
    // every id the publisher put on the pipe (a turn end and the death), as the mod would have recorded them
    const net = require('node:net');
    const want = s.pub.stats().published;
    const ids = await new Promise((resolve) => {
      const c = net.connect(wakePipeName(s.dataDir, runId, 'n-claim')); let buf = '';
      c.on('data', (d) => {
        buf += d;
        const got = buf.split(NL).filter((x) => x.includes('"id"')).map((x) => JSON.parse(x).id);
        if (got.length >= want) { c.destroy(); resolve(got); }
      });
    });
    fs.writeFileSync(s.deliveredFile, ids.map((id) => `${JSON.stringify({ id, at: 1 })}${NL}`).join(''));
    s.clock.skew = BOUND + 500;
    const p0 = s.pub.stats().polls;
    assert.ok(await until(() => s.pub.stats().polls >= p0 + 3), 'three polls ran past the bound');
    assert.strictEqual(D.isClaimed({ dataDir: s.dataDir, runId, uid: s.uid }), true);
    assert.strictEqual((await s.wait()).event, null, 'delivered by the wake: worker_wait does not repeat it');
  } finally { await s.pub.stop(); fs.rmSync(s.base, { recursive: true, force: true }); }
});

test('an exception another path claimed is offered again by the same wait once that claim is given back', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wclaim-x-'));
  const dataDir = path.join(base, 'data').replaceAll(path.sep, '/'); fs.mkdirSync(dataDir);
  try {
    const exc = { exception: 'E2', worker_id: 'rev-1', key: 'fixcap:t-9', task_id: 't-9', trigger: 'review_refuted', field: null, text: 'belay: fix cap reached for t-9. Halted.' };
    const sent = new Set(); // like policy-wakes.cjs: each exception is yielded once
    const watcher = { poll: async () => { if (sent.has(exc.key)) return []; sent.add(exc.key); return [exc]; } };
    const uid = `${exc.worker_id}:${exc.key}`;
    D.claimException({ dataDir, runId, uid }); // as the publisher claims at publish
    const rw = createRunWait({ core: fakeCore(Date.now()), runId, dataDir, claimant: { pid: process.pid, created: 'z' }, watcher, pollMs: 10 });
    assert.strictEqual((await rw.wait({ ms: 60, workers: [] })).event, null);
    D.release({ dataDir, runId, uids: [uid] });
    const r = await rw.wait({ ms: 60, workers: [] });
    assert.strictEqual(r.event, 'exception');
    assert.strictEqual(r.exceptions[0].ref, shortRef(uid));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a long policy wake text still ends with an intact ref, and the wake line and worker_wait name the same ref', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wclaim-l-'));
  const dataDir = path.join(base, 'data').replaceAll(path.sep, '/'); fs.mkdirSync(dataDir);
  try {
    const long = `belay: exception E2, task ${'t'.repeat(36)}, trigger task:${'u'.repeat(36)}:12, field fix. Fix cap reached (2 used of 2); review refuted. ${'x'.repeat(120)} Halted.`;
    const exc = { exception: 'E2', worker_id: `policy:E2:fix:${'t'.repeat(36)}`, key: `${'k'.repeat(36)}@1730000000000`, task_id: 't-9', trigger: 'review_refuted', field: 'fix', text: long };
    const uid = `${exc.worker_id}:${exc.key}`;
    D.claimException({ dataDir, runId, uid });
    const sent = new Set();
    const watcher = { poll: async () => { if (sent.has(exc.key)) return []; sent.add(exc.key); return [exc]; } };
    const rw = createRunWait({ core: fakeCore(Date.now()), runId, dataDir, claimant: { pid: process.pid, created: 'y' }, watcher, pollMs: 10 });
    await rw.wait({ ms: 60, workers: [] });
    D.release({ dataDir, runId, uids: [uid] });
    const r = await rw.wait({ ms: 60, workers: [] });
    const ref = r.exceptions[0].ref;
    assert.match(ref, /^[0-9a-f]{8}$/, 'the ref is 8 hex characters');
    const line = withRef(long, shortRef(uid)); // what the publisher submits for this uid
    assert.ok(Buffer.byteLength(long, 'utf8') > WAKE_TEXT_MAX - 20, 'the text leaves no room for a long suffix');
    assert.ok(Buffer.byteLength(line, 'utf8') <= WAKE_TEXT_MAX, 'the whole fits the mod text budget');
    assert.ok(line.endsWith(` (ref ${ref})`), 'the ref is intact at the end and equals the one worker_wait names');
    assert.ok(line.includes('Halted.'), 'the halt notice survives; the body gave way');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('stopping the publisher releases what the mod never delivered', async () => {
  const s = await setup();
  try {
    await s.pub.stop();
    assert.strictEqual(D.isClaimed({ dataDir: s.dataDir, runId, uid: s.uid }), false);
    assert.strictEqual((await s.wait()).event, 'exception');
  } finally { await s.pub.stop(); fs.rmSync(s.base, { recursive: true, force: true }); }
});

// The publisher's own emitted line for a long policy exception (E2 with long finding titles), against what worker_wait names for the same key.
test('a long exception through the wake publisher is a line within the text budget that ends with the ref worker_wait returns', async () => {
  const net = require('node:net');
  const PW = require('../../src/run/policy-wakes.cjs');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wclaim-p-'));
  const dataDir = path.join(base, 'data').replaceAll(path.sep, '/'); fs.mkdirSync(dataDir);
  const PLAN = { review: { worker: 'rv' }, fix: 'builder', re_review: 'refuter', integrate: 'on_hold' };
  const finding = (n) => ({ severity: 'blocking', title: `${n} ${'finding title that runs on and on '.repeat(3)}`, where: 'a.cjs:1' });
  const done = (over) => ({ run_id: runId, state: 'done', policy: null, depends_on: [], repairs: null, lease: null, review: null, integration: null, written_at: 50, ...over });
  const evaluated = (passed, checks) => ({ trigger: 'release', evaluated_at: 20, executable: true, passed, checks });
  const R = done({ id: 'R', seq: 101, state: 'released', depends_on: ['W'], handoff: { by: 'rv', at: 10 }, results: evaluated(false, [{ kind: 'verdict', executable: true, passed: false, detail: { verdict: 'refuted', summary: 's', findings: [1, 2, 3, 4].map(finding) } }]) });
  const W = done({ id: 'W', seq: 100, policy: PLAN, handoff: { by: 'w1', at: 10 }, results: evaluated(true, [{ kind: 'command', argv: ['npm', 'test'], passed: true }]), review: { state: 'refuted', review_id: 'R', rounds_left: 0, fix_rounds_used: 2, max_fix_rounds: 2 } });
  const rows = [{ id: 'w1', run_id: runId, state: 'running', turns: 0, seq: 1, pid_alive: true, mid_turn: 0 }];
  const core = { worker: { list: async () => ({ workers: rows.map((r) => ({ ...r })) }) }, run: { get: async () => ({ run: { id: runId, policy_default: { review: true } } }) }, task: { list: async () => ({ tasks: [W, R] }) }, policy: { list: async () => ({ rows: [] }) } };
  const pub = startWakePublisher({ core, runId, dataDir, pipeName: wakePipeName(dataDir, runId, 'n-long'), pollMs: 20 });
  await pub.listening;
  const lines = [];
  let buf = '';
  const sock = net.connect(wakePipeName(dataDir, runId, 'n-long'));
  sock.on('data', (d) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf(NL)) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  sock.on('error', () => {});
  try {
    rows[0] = { ...rows[0], turns: 1, seq: 2 }; // a turn end: the poll reads the tasks and arms the policy watcher
    assert.ok(await until(() => lines.some((l) => l.text && /exception E2,/.test(l.text))), JSON.stringify(lines));
    const line = lines.find((l) => l.text && /exception E2,/.test(l.text)).text;
    const e = PW.derive({ runId, tasks: [W, R], integrations: [], steps: [], failures: [] })[0];
    const w = PW.wakeOf(e);
    const uid = D.wakeUid(w);
    assert.ok(Buffer.byteLength(w.text, 'utf8') >= 200, 'the policy text alone nearly fills the budget');
    assert.ok(Buffer.byteLength(line, 'utf8') <= WAKE_TEXT_MAX, 'the emitted line fits the mod text budget');
    assert.ok(line.endsWith(` (ref ${shortRef(uid)})`), 'the emitted line ends with the intact ref');
    // the same exception through worker_wait, once the publisher's claim is given back
    D.release({ dataDir, runId, uids: [uid] });
    const sent = new Set();
    const watcher = { poll: async () => { if (sent.has(w.key)) return []; sent.add(w.key); return [w]; } };
    const rw = createRunWait({ core, runId, dataDir, claimant: { pid: process.pid, created: 'p' }, watcher, pollMs: 10 });
    const r = await rw.wait({ ms: 60, workers: [] });
    assert.strictEqual(r.exceptions[0].ref, line.slice(line.lastIndexOf('(ref ') + 5, -1), 'worker_wait names the ref the line carries');
  } finally { sock.destroy(); await pub.stop(); fs.rmSync(base, { recursive: true, force: true }); }
});

test('a body of multi-byte characters is cut on a character boundary, within the budget, with the ref intact', () => {
  const ref = shortRef('some:uid');
  const tail = ` (ref ${ref})`;
  for (const unit of ['界', '😀', 'é']) {
    for (let pad = 0; pad < 4; pad += 1) {
      for (let n = 40; n < 110; n += 1) {
        const text = `${'a'.repeat(pad)}${unit.repeat(n)} Halted.`;
        const line = withRef(text, ref);
        const ctx = `unit ${unit} pad ${pad} n ${n}`;
        assert.ok(Buffer.byteLength(line, 'utf8') <= WAKE_TEXT_MAX, `within the budget: ${ctx}`);
        assert.ok(!line.includes('\uFFFD'), `no split character: ${ctx}`);
        assert.strictEqual(Buffer.from(line, 'utf8').toString('utf8'), line, `round-trips: ${ctx}`);
        assert.ok(line.endsWith(tail), `ref intact: ${ctx}`);
        assert.ok(line.includes(`${' Halted.'}${tail}`), `halt notice kept: ${ctx}`);
      }
    }
  }
});
