'use strict';
require('../helpers/tmp.cjs');
// A claimed wake (a worker death under a plan) has two delivery paths: the mod submits the wake line, or, when the mod's delivered-wakes
// file has not named it within the publisher's delivery bound, the claim is released and worker_wait returns it. Delivery across the two
// is at least once, with ids (ADR 0074 amendment 1): a wake whose mod record write fails past the bound is submitted by the mod and
// returned by worker_wait as well, and one whose mod is absent past it is returned by worker_wait and later submitted by the mod, both
// naming the same ref. It is never lost.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { startWakePublisher, wakePipeName } = require('../../src/run/wake-pipe.cjs');
const { createRunWait } = require('../../src/run/run-wait.cjs');
const D = require('../../src/run/run-digest.cjs');

const MOD = `file://${path.resolve(__dirname, '../../src/mod/hooks/wake/core.mjs').split('\\').join('/')}`;
const runId = 'run-one-path';
const WID = 'coder-1';
const PID = 999992;
const CREATED = '133000000000000001';
const BOUND = 30000; // wake-pipe.cjs DELIVERY_BOUND_MS
const NL = String.fromCharCode(10);
const REF = / \(ref ([0-9a-f]{8})\)$/;
const until = async (f) => { for (let i = 0; i < 400; i += 1) { if (await f()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };

async function setup(tag) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `wone-${tag}-`));
  const dataDir = path.join(base, 'data').replaceAll(path.sep, '/'); fs.mkdirSync(dataDir);
  const deliveredFile = `${base.replaceAll(path.sep, '/')}/wakes-delivered.jsonl`;
  const clock = { skew: 0 };
  const now = () => Date.now() + clock.skew;
  const t0 = now();
  const core = {
    worker: { list: async () => ({ workers: [{ id: WID, run_id: runId, state: 'dead', turns: 1, pid: PID, pid_created: CREATED, exited_at: t0 + 60000, exit_code: 1 }] }) },
    run: { get: async () => ({ run: { id: runId, policy_default: { review: true } } }) },
    task: { list: async () => ({ tasks: [] }) },
    policy: { list: async () => ({ rows: [] }) },
  };
  const pipe = wakePipeName(dataDir, runId, `n-${tag}`);
  const pub = startWakePublisher({ core, runId, dataDir, pipeName: pipe, pollMs: 20, now, deliveredFile });
  await pub.listening;
  const uid = D.deathUid(WID, 'death', D.lifeOf(PID, CREATED));
  const rw = createRunWait({ core, runId, dataDir, claimant: { pid: process.pid, created: tag }, watcher: { poll: async () => [] }, pollMs: 10 });
  const workers = [{ id: WID, settled: true, state: 'dead', pid: PID, pidCreated: CREATED, exitCode: 1, turns: 1, deathEstablishedBy: 'process exit' }];
  const wait = () => rw.wait({ ms: 60, workers });
  return { base, dataDir, deliveredFile, clock, now, pub, pipe, uid, wait };
}

// The retained replay a fresh client is handed on connect, read until it names a claimed wake. A replay that never names one fails
// at the deadline (the publisher sends a heartbeat on connect, so a missing line is not mistaken for a slow pipe).
function claimedLine(pipe, deadlineMs = 10000) {
  return new Promise((resolve, reject) => {
    const c = net.connect(pipe); let buf = '';
    const timer = setTimeout(() => { c.destroy(); reject(new Error(`no claimed wake line was replayed within ${deadlineMs} ms`)); }, deadlineMs);
    c.on('error', (e) => { clearTimeout(timer); reject(e); });
    c.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf(NL)) >= 0) { const o = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (o.id && REF.test(o.text)) { clearTimeout(timer); c.destroy(); resolve(o); return; } }
    });
  });
}

const deliveryOf = (createDelivery, s, io) => createDelivery({ file: s.deliveredFile, now: s.now, io: { log: () => {}, ...io } });

test('a claimed wake whose mod record write fails past the bound is submitted by the mod and returned by worker_wait, both with the same ref', async () => {
  const { createDelivery } = await import(MOD);
  const s = await setup('fail');
  try {
    const death = await claimedLine(s.pipe);
    let failing = true;
    const submits = [];
    const delivery = deliveryOf(createDelivery, s, {
      write: async (f, c) => { if (failing) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); fs.writeFileSync(f, c); },
      submit: async (text) => { submits.push(text); },
    });
    assert.strictEqual(await delivery.deliver(death.id, death.text), 'submitted', 'the submit comes first; the record follows');
    assert.deepStrictEqual(submits, [death.text]);
    for (const t of [1000, 3000, 7000, 15000]) { s.clock.skew = t; await delivery.retryPending(); } // the mod's record retries, all failing
    assert.deepStrictEqual(submits, [death.text], 'a failed record is written again, never submitted again');
    s.clock.skew = BOUND + 1000;
    assert.ok(await until(() => !D.isClaimed({ dataDir: s.dataDir, runId, uid: s.uid })), 'the publisher released the claim the file never named');
    const r = await s.wait();
    assert.strictEqual(r.event, 'exception', 'worker_wait returns the death too: at least once, never lost');
    assert.strictEqual(REF.exec(submits[0])[1], r.exceptions[0].ref, 'both paths name the same ref, so the repeat is recognisable');
    failing = false;
    await delivery.retryPending(); // the record lands at last
    assert.ok(fs.readFileSync(s.deliveredFile, 'utf8').includes(death.id));
    assert.deepStrictEqual(submits, [death.text], 'the mod submits it once');
  } finally { await s.pub.stop(); fs.rmSync(s.base, { recursive: true, force: true }); }
});

test('a claimed wake whose mod is absent past the bound is returned by worker_wait and replayed to the mod when it connects, with the same ref', async () => {
  const { createDelivery } = await import(MOD);
  const s = await setup('absent');
  try {
    assert.ok(await until(() => s.pub.stats().published >= 1), 'the death was published');
    s.clock.skew = BOUND + 1000; // no mod: nothing names the wake
    assert.ok(await until(() => !D.isClaimed({ dataDir: s.dataDir, runId, uid: s.uid })), 'the publisher released the undelivered claim');
    const r = await s.wait();
    assert.strictEqual(r.event, 'exception', 'worker_wait returns the death');
    const death = await claimedLine(s.pipe); // the mod connects late and is replayed the line
    const submits = [];
    const delivery = deliveryOf(createDelivery, s, { write: async (f, c) => { fs.writeFileSync(f, c); }, submit: async (t) => { submits.push(t); } });
    assert.strictEqual(await delivery.deliver(death.id, death.text), 'submitted');
    assert.strictEqual(REF.exec(submits[0])[1], r.exceptions[0].ref, 'both paths name the same ref');
  } finally { await s.pub.stop(); fs.rmSync(s.base, { recursive: true, force: true }); }
});

test('a claimed wake whose write lands inside the bound is submitted by the mod only', async () => {
  const { createDelivery } = await import(MOD);
  const s = await setup('late');
  try {
    const death = await claimedLine(s.pipe);
    let failing = true;
    const submits = [];
    const delivery = deliveryOf(createDelivery, s, { write: async (f, c) => { if (failing) throw new Error('EBUSY'); fs.writeFileSync(f, c); }, submit: async (t) => { submits.push(t); } });
    await delivery.deliver(death.id, death.text);
    s.clock.skew = 7000; await delivery.retryPending();
    s.clock.skew = 15000; failing = false; await delivery.retryPending();
    assert.deepStrictEqual(submits, [death.text], 'the mod submitted it once; its record landed later');
    s.clock.skew = BOUND + 5000;
    const p0 = s.pub.stats().polls;
    assert.ok(await until(() => s.pub.stats().polls >= p0 + 3), 'three polls ran past the bound');
    assert.strictEqual(D.isClaimed({ dataDir: s.dataDir, runId, uid: s.uid }), true, 'the delivered file named it: the claim stands');
    assert.strictEqual((await s.wait()).event, null, 'worker_wait does not repeat it');
  } finally { await s.pub.stop(); fs.rmSync(s.base, { recursive: true, force: true }); }
});
