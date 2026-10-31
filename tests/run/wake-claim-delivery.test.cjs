'use strict';
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
  const wait = () => createRunWait({ core, runId, dataDir, claimant: { pid: process.pid, created: 'x' }, watcher: { poll: async () => [] }, pollMs: 10 }).wait({ ms: 60, workers: workersRec });
  return { base, dataDir, deliveredFile, clock, pub, uid, wait };
}

test('a claimed wake the mod never delivered is released after the bound, and worker_wait returns it', async () => {
  const s = await setup();
  try {
    assert.strictEqual(D.isClaimed({ dataDir: s.dataDir, runId, uid: s.uid }), true, 'claimed at publish');
    assert.strictEqual((await s.wait()).event, null, 'inside the bound the wake is held for the mod');
    s.clock.skew = BOUND + 500;
    assert.ok(await until(() => !D.isClaimed({ dataDir: s.dataDir, runId, uid: s.uid })), 'the claim is released once the bound passes undelivered');
    const r = await s.wait();
    assert.strictEqual(r.event, 'exception');
    assert.strictEqual(r.exceptions[0].worker_id, WID);
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
    await new Promise((r) => setTimeout(r, 150)); // several polls past the bound
    assert.strictEqual(D.isClaimed({ dataDir: s.dataDir, runId, uid: s.uid }), true);
    assert.strictEqual((await s.wait()).event, null, 'delivered by the wake: worker_wait does not repeat it');
  } finally { await s.pub.stop(); fs.rmSync(s.base, { recursive: true, force: true }); }
});

test('stopping the publisher releases what the mod never delivered', async () => {
  const s = await setup();
  try {
    await s.pub.stop();
    assert.strictEqual(D.isClaimed({ dataDir: s.dataDir, runId, uid: s.uid }), false);
    assert.strictEqual((await s.wait()).event, 'exception');
  } finally { await s.pub.stop(); fs.rmSync(s.base, { recursive: true, force: true }); }
});
