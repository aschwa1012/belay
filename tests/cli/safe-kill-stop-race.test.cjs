'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// safe-kill-stop-race.test.cjs — ADR 0039 review: a `belay stop` worker phase in flight when the console closes. The
// stop and the run's worker close (now started early, inside the loop) run in one process; the kill lock makes the
// second wait for the first, and the SIGHUP's snapshot, started before the stop's signal, is never used to prove a
// process after it. Without the lock, the close proves the worker and its descendant from that stale snapshot, and
// one of the two killers signals pids that have just died (whose pids nothing holds).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const P = require('../../src/core/process.cjs');
const ID = require('../../src/core/proc-identity.cjs');
const RP = require('../../src/run/process.cjs');
const { makeConsole } = require('../../src/run/orchestrator-interactive.cjs');
const { closeRunWorkers } = require('../../src/cli/run-close.cjs');
const RI = require('../../src/cli/run-interactive.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.resolve(__dirname, '..', '..');

test('stop vs fast close: the second killer waits, re-snapshots and finds the worker absent; no pid is killed twice', async (t) => {
  if (process.platform !== 'win32') return t.skip('the CIM snapshot is Windows only');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-race-'));
  const log = path.join(dir, 'kills.jsonl'); const kidFile = path.join(dir, 'kid.pid');
  const prevLog = process.env.BELAY_KILL_LOG; process.env.BELAY_KILL_LOG = log;
  // The worker and its descendant: the descendant's pid is the one nothing holds.
  const src = `const{spawn}=require('child_process');const k=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(kidFile)},String(k.pid));setInterval(()=>{},1000);`;
  const w = spawn(process.execPath, ['-e', src], { windowsHide: true, stdio: 'ignore' });
  const realRun = RP.snapshotShared;
  const ce = makeConsole();
  let stopKill = null;
  try {
    for (let i = 0; i < 100 && !fs.existsSync(kidFile); i++) await sleep(50);
    const kid = Number(fs.readFileSync(kidFile, 'utf8'));
    const pre = await ID.processSnapshot(); // both alive in it, with their creation times
    assert.ok(pre && pre.get(w.pid) && pre.get(kid), 'the worker or its descendant is not in the snapshot');
    const row = { id: 'w-race', run_id: 'r', substrate: 'claude-code', state: 'running', pid: w.pid, pid_created: pre.get(w.pid).created, pid_image: 'node.exe' };
    // The console's SIGHUP snapshot is `pre`: taken before the stop's kill, as on a host where it began at the SIGHUP.
    let consoleSnaps = 0;
    // Stamped on the real gate's counter at the SIGHUP, so the stop's later signal makes it stale at use (ADR 0048 rule 4).
    RP.snapshotShared = (...a) => { consoleSnaps++; return consoleSnaps === 1 ? Promise.resolve({ snap: pre, startSeq: P.gate.stamp(), error: null }) : realRun(...a); };
    ce.install();
    process.emit('SIGHUP');
    let lists = 0;
    const core = {
      run: { get: async () => ({ run: { adapter_pid: process.pid } }) },
      worker: {
        list: async () => {
          lists++;
          // The stop's worker phase lands now, between the close's listing and its kill, as stop.cjs does it: under the
          // kill lock, proving the worker from its own snapshot (taken before the worker died).
          if (lists === 2) stopKill = (P.withKillLock || ((f) => f()))(() => P.killProcess(P.rowTarget(row), { snapshot: async () => { await sleep(300); return pre; } }));
          return { workers: [row] };
        },
      },
    };
    const out = await closeRunWorkers({ core, runId: 'r', graceMs: 100, ownPid: process.pid, fast: RI.fastOf(ce) });
    await stopKill;
    if (P.withKillLock) await P.withKillLock(() => {}); // a close the budget cut still finishes its locked kill: wait for it
    const all = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.pid === w.pid);
    const lines = all.filter((l) => l.fn === 'killProcess');
    const ok = lines.filter((l) => l.ok);
    assert.strictEqual(ok.length, 1, `the worker was proved and signalled by more than one killer: ${JSON.stringify(lines)}`);
    assert.ok(/safe-kill-stop-race/.test(ok[0].caller), `the stop's kill is the one that lands: ${JSON.stringify(lines)}`);
    // The close waited for the stop, then either re-snapshotted and found the worker absent, or (a loaded host) had no
    // budget left for a new snapshot and signalled nothing. It never proved the worker from the SIGHUP's snapshot.
    const closeLine = all.find((l) => /^src\/cli\/run-close\.cjs:/.test(l.caller));
    // A snapshot too slow for the budget (a stalled one) ends as unverifiable with the deadline named: still nothing signalled.
    const noFit = closeLine && closeLine.kind === 'unverifiable' && /(deadline)/.test(String(closeLine.detail));
    assert.ok(closeLine && closeLine.ok === false && (['absent', 'no_budget'].includes(closeLine.kind) || noFit), `the close did not wait and find the worker absent: ${JSON.stringify(all)}`);
    assert.ok(Date.parse(closeLine.time) >= Date.parse(ok[0].time), 'the close acted before the stop finished');
    if (closeLine.kind === 'absent') assert.ok(consoleSnaps >= 2, 'the close used the snapshot from before the stop\'s signal instead of taking a new one');
    assert.ok(['absent', 'no_budget', 'unverifiable'].includes(out.killed[0].kind), JSON.stringify(out.killed));
    assert.ok(!RP.pidAlive(w.pid) && !RP.pidAlive(kid), 'the stop did not end the worker and its descendant');
  } finally {
    RP.snapshotShared = realRun; ce.dispose();
    if (stopKill) await stopKill.catch(() => {});
    require('../crash.cjs').crash(w); // its handle, if it is still live
    if (prevLog === undefined) delete process.env.BELAY_KILL_LOG; else process.env.BELAY_KILL_LOG = prevLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the kill lock runs kills one at a time, in the order asked, and stop.cjs takes it for each worker kill', async () => {
  const order = [];
  const a = P.withKillLock(async () => { order.push('a+'); await sleep(100); order.push('a-'); });
  const b = P.withKillLock(async () => { order.push('b+'); order.push('b-'); });
  const c = P.withKillLock(() => { throw new Error('a failed kill releases the lock'); });
  const d = P.withKillLock(() => order.push('d'));
  await Promise.all([a, b, c.catch(() => {}), d]);
  assert.deepStrictEqual(order, ['a+', 'a-', 'b+', 'b-', 'd']);
  const stopSrc = fs.readFileSync(path.join(ROOT, 'src', 'run', 'stop.cjs'), 'utf8');
  assert.match(stopSrc, /P\.withKillLock\(\(\) => P\.killProcess\(P\.rowTarget\(w\)\)\)/);
});
