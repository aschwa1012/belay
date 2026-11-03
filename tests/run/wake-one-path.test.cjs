'use strict';
require('../helpers/tmp.cjs');
// A claimed wake (a worker death under a plan) has two delivery paths: the mod submits the wake line, or, when the mod's delivered-wakes
// file has not named it within the publisher's delivery bound, the claim is released and worker_wait returns it. Delivery across the two
// is at least once, with ids; these tests hold the case the bound exists for to one path: the mod's record write fails for longer than
// the bound, then works again. The mod gives the wake up before the bound, so it never submits what worker_wait now offers, and a client
// that connects after the release is not handed the released line.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { startWakePublisher, wakePipeName, DELIVERY_BOUND_MS } = require('../../src/run/wake-pipe.cjs');
const { createRunWait } = require('../../src/run/run-wait.cjs');
const D = require('../../src/run/run-digest.cjs');

const MOD = `file://${path.resolve(__dirname, '../../src/mod/hooks/wake/core.mjs').split('\\').join('/')}`;
const runId = 'run-one-path';
const WID = 'coder-1';
const PID = 999992;
const CREATED = '133000000000000001';
const NL = String.fromCharCode(10);
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

// Every line a fresh client is handed on connect (the retained replay), read until `stop` says enough or a short quiet spell.
function replay(pipe, stop = () => false) {
  return new Promise((resolve) => {
    const c = net.connect(pipe); let buf = ''; const lines = [];
    const done = () => { c.destroy(); resolve(lines); };
    let quiet = setTimeout(done, 300);
    c.on('error', done);
    c.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf(NL)) >= 0) { const o = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (o.id) lines.push(o); }
      clearTimeout(quiet); quiet = setTimeout(done, 300);
      if (stop(lines)) { clearTimeout(quiet); done(); }
    });
  });
}

test('the mod gives a claimed wake up before the bound when its write keeps failing, and only worker_wait delivers it', async () => {
  const { createDelivery, GIVE_UP_MS } = await import(MOD);
  assert.ok(GIVE_UP_MS < DELIVERY_BOUND_MS, 'the mod stops retrying a claimed wake before the publisher can release it');
  const s = await setup('fail');
  try {
    const lines = await replay(s.pipe, (l) => l.some((o) => / \(ref [0-9a-f]{8}\)$/.test(o.text)));
    const death = lines.find((o) => / \(ref [0-9a-f]{8}\)$/.test(o.text));
    assert.ok(death, 'the claimed death was published with its ref');
    let failing = true;
    const submits = [];
    const logs = [];
    const delivery = createDelivery({
      file: s.deliveredFile,
      now: s.now,
      io: {
        write: async (f, c) => { if (failing) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); fs.writeFileSync(f, c); },
        submit: async (text) => { submits.push(text); },
        log: (e) => { logs.push(e); },
      },
    });
    assert.strictEqual(await delivery.deliver(death.id, death.text), 'write-failed');
    for (const t of [1000, 3000, 7000, 15000]) { s.clock.skew = t; await delivery.retryPending(); } // the mod's retry pauses, all failing
    s.clock.skew = 31000; // the next pause (16 s) lands past GIVE_UP_MS, and past the bound
    failing = false; // the write would work now
    await delivery.retryPending();
    assert.deepStrictEqual(submits, [], 'the mod did not submit a wake it had given up');
    assert.ok(logs.some((e) => e.stage === 'gave-up' && e.id === death.id), 'the give-up is logged');
    assert.ok(await until(() => !D.isClaimed({ dataDir: s.dataDir, runId, uid: s.uid })), 'the publisher released the undelivered claim');
    const r = await s.wait();
    assert.strictEqual(r.event, 'exception', 'worker_wait returns the death');
    assert.ok(death.text.endsWith(`(ref ${r.exceptions[0].ref})`), 'both paths name the same ref');
    assert.strictEqual(await delivery.deliver(death.id, death.text), 'skip', 'a replayed line for the given-up wake is not submitted');
    const later = await replay(s.pipe);
    assert.ok(!later.some((o) => o.id === death.id), 'a client that connects after the release is not handed the released wake');
    assert.deepStrictEqual(submits, [], 'one path, worker_wait, delivered it');
  } finally { await s.pub.stop(); fs.rmSync(s.base, { recursive: true, force: true }); }
});

test('a claimed wake whose write lands before the give-up is submitted by the mod only', async () => {
  const { createDelivery } = await import(MOD);
  const s = await setup('late');
  try {
    const lines = await replay(s.pipe, (l) => l.some((o) => / \(ref [0-9a-f]{8}\)$/.test(o.text)));
    const death = lines.find((o) => / \(ref [0-9a-f]{8}\)$/.test(o.text));
    let failing = true;
    const submits = [];
    const delivery = createDelivery({
      file: s.deliveredFile,
      now: s.now,
      io: { write: async (f, c) => { if (failing) throw new Error('EBUSY'); fs.writeFileSync(f, c); }, submit: async (t) => { submits.push(t); }, log: () => {} },
    });
    await delivery.deliver(death.id, death.text);
    s.clock.skew = 7000; await delivery.retryPending();
    s.clock.skew = 15000; failing = false; await delivery.retryPending();
    assert.deepStrictEqual(submits, [death.text], 'the mod submitted it once its write landed');
    s.clock.skew = DELIVERY_BOUND_MS + 5000;
    const p0 = s.pub.stats().polls;
    assert.ok(await until(() => s.pub.stats().polls >= p0 + 3), 'three polls ran past the bound');
    assert.strictEqual(D.isClaimed({ dataDir: s.dataDir, runId, uid: s.uid }), true, 'the delivered file named it: the claim stands');
    assert.strictEqual((await s.wait()).event, null, 'worker_wait does not repeat it');
  } finally { await s.pub.stop(); fs.rmSync(s.base, { recursive: true, force: true }); }
});

test('an unclaimed wake is never given up: it has no other path', async () => {
  const { createDelivery } = await import(MOD);
  let t = 0; let failing = true; const submits = [];
  const delivery = createDelivery({ file: 'x', now: () => t, io: { write: async () => { if (failing) throw new Error('EBUSY'); }, submit: async (x) => { submits.push(x); }, log: () => {} } });
  await delivery.deliver('turn-1', 'belay: coder-1 ended turn 1');
  t = 120000; await delivery.retryPending();
  failing = false; t = 150000; await delivery.retryPending();
  assert.deepStrictEqual(submits, ['belay: coder-1 ended turn 1']);
});
