'use strict';
// The run's dead-pid memory (src/run/dead-pids.cjs): what it holds dead, what it forgets, and what it never remembers.
const test = require('node:test');
const assert = require('node:assert');
const { createDeadPids } = require('../../src/run/dead-pids.cjs');

const row = (o) => ({ id: 'w', run_id: 'r', state: 'running', pid: 4242, pid_created: null, seq: 5, pid_alive: true, ...o });

test('a restating row of the same state, with a new seq, keeps a dead pid dead', () => {
  const m = createDeadPids();
  m.apply([row({ pid_alive: false })]);
  for (const seq of [6, 7]) m.apply([row({ seq, pid_alive: false })]);
  assert.strictEqual(m.apply([row({ seq: 8, pid_alive: true })])[0].pid_alive, false, 'a turn end, a mid-turn refresh or a compaction write is not a new life');
  assert.strictEqual(m.apply([row({ seq: 9, state: 'stopping', pid_alive: true })])[0].pid_alive, false);
});

test('a relaunch of the same id with the same pid and no creation time reads alive', () => {
  const m = createDeadPids();
  m.apply([row({ pid_alive: false })]);
  assert.strictEqual(m.apply([row({ pid_alive: true })])[0].pid_alive, false, 'same life, number reused: held dead');
  const relaunch = m.apply([row({ pid_alive: true, state: 'starting', seq: 9 })])[0]; // a new row seq: a new life
  assert.strictEqual(relaunch.pid_alive, true);
  assert.strictEqual(m.apply([row({ pid_alive: true, state: 'running', seq: 10 })])[0].pid_alive, true, 'and stays alive');
});

test('a different pid or creation time is a different process', () => {
  const m = createDeadPids();
  m.apply([row({ pid_alive: false, pid_created: 111 })]);
  assert.strictEqual(m.apply([row({ pid_created: 222 })])[0].pid_alive, true);
  m.apply([row({ pid_alive: false })]);
  assert.strictEqual(m.apply([row({ pid: 5000 })])[0].pid_alive, true);
});

test('only life-claiming states are remembered; a terminal or parked row is never seeded', () => {
  for (const state of ['dead', 'stopped', 'paused', 'idle']) {
    const m = createDeadPids();
    m.apply([row({ state, pid_alive: false })]);
    assert.strictEqual(m.apply([row({ state, pid_alive: true })])[0].pid_alive, true, state);
  }
  const m = createDeadPids();
  m.apply([row({ pid_alive: false })]);
  m.apply([row({ state: 'dead', pid_alive: false })]); // the detector's row ends the life and clears the memory
  assert.strictEqual(m.apply([row({ pid_alive: true })])[0].pid_alive, true);
  for (const state of ['starting', 'running', 'stopping']) {
    const s = createDeadPids();
    s.apply([row({ state, pid_alive: false })]);
    assert.strictEqual(s.apply([row({ state, pid_alive: true })])[0].pid_alive, false, state);
  }
});

test('a row without a pid, or a pid_alive that is not a boolean, is passed through', () => {
  const m = createDeadPids();
  const a = row({ pid: null, pid_alive: false }); const b = row({ pid_alive: undefined });
  assert.deepStrictEqual(m.apply([a, b]), [a, b]);
});

// The pid reused before it was ever read dead (an orphan: its adapter is gone, so no one writes its row).
const orphan = (o) => row({ pid_created: 111, adapter_pid: 99, last_event_age_ms: 20000, ...o });
const gone = () => false;
const mk = (extra) => { const calls = []; const m = createDeadPids({ graceMs: 8000, adapterAlive: gone, prepare: async (pairs) => { calls.push(pairs); return { runsAs: () => false }; }, ...extra }); return { m, calls }; };

test('an orphan whose pid runs as another process reads dead from the next poll, after one snapshot, never on the poll that asked', async () => {
  const { m, calls } = mk();
  assert.strictEqual(m.apply([orphan()])[0].pid_alive, true, 'the poll that starts the check is not delayed or changed');
  await m.settled();
  const r = m.apply([orphan()])[0];
  assert.strictEqual(r.pid_alive, false);
  assert.strictEqual(r.pid_dead_by, 'identity');
  m.apply([orphan()]); m.apply([orphan()]);
  assert.strictEqual(calls.length, 1, 'one snapshot for the row seq');
  assert.deepStrictEqual(calls[0], [{ pid: 4242, created: 111 }]);
});

test('no snapshot unless a row with a creation time reads alive past the grace with a stale event age and a dead adapter', async () => {
  for (const [name, extra, opts] of [
    ['adapter alive', {}, { adapterAlive: () => true }],
    ['no creation time', { pid_created: null }, {}],
    ['a recent event', { last_event_age_ms: 1000 }, {}],
    ['not a life-claiming state', { state: 'dead' }, {}],
    ['already read dead', { pid_alive: false }, {}],
  ]) {
    const { m, calls } = mk(opts);
    m.apply([orphan(extra)]); await m.settled();
    assert.strictEqual(calls.length, 0, name);
  }
  const { m: m2, calls } = mk();
  m2.apply([orphan({ last_event_age_ms: null, started_at: Date.now() - 60000 })]); await m2.settled();
  assert.strictEqual(calls.length, 1, 'no event yet: the age is the time since the row started');
});

test('a snapshot that stalls, fails or cannot tell leaves the row reading alive, and does not hold the poll', async () => {
  const stalled = createDeadPids({ graceMs: 8000, adapterAlive: gone, prepare: () => new Promise(() => {}), checkTimeoutMs: 30 });
  const t = Date.now();
  assert.strictEqual(stalled.apply([orphan()])[0].pid_alive, true);
  assert.ok(Date.now() - t < 25, 'apply returned at once');
  await stalled.settled();
  assert.strictEqual(stalled.apply([orphan()])[0].pid_alive, true);
  const failing = createDeadPids({ graceMs: 8000, adapterAlive: gone, prepare: async () => { throw new Error('snapshot'); } });
  failing.apply([orphan()]); await failing.settled();
  assert.strictEqual(failing.apply([orphan()])[0].pid_alive, true);
  const unverifiable = createDeadPids({ graceMs: 8000, adapterAlive: gone, prepare: async () => ({ runsAs: () => true }) });
  unverifiable.apply([orphan()]); await unverifiable.settled();
  assert.strictEqual(unverifiable.apply([orphan()])[0].pid_alive, true);
});

test('a verdict belongs to the life it was taken in: a restating row keeps it, a relaunch drops it, a late verdict for a past life is discarded', async () => {
  const { m } = mk();
  m.apply([orphan()]); await m.settled();
  assert.strictEqual(m.apply([orphan({ seq: 6 })])[0].pid_alive, false, 'a restating row of the same life keeps the verdict');
  assert.strictEqual(m.apply([orphan({ seq: 9, state: 'starting' })])[0].pid_alive, true, 'a relaunch is another life');
  let release; const gate = new Promise((r) => { release = r; });
  const late = createDeadPids({ graceMs: 8000, adapterAlive: gone, prepare: async () => { await gate; return { runsAs: () => false }; } });
  late.apply([orphan()]);
  late.apply([orphan({ seq: 9, state: 'starting', last_event_age_ms: 100 })]); // the relaunch lands while the first life's snapshot is in flight
  release(); await late.settled();
  assert.strictEqual(late.apply([orphan({ seq: 10, state: 'running', last_event_age_ms: 100 })])[0].pid_alive, true);
});

test('with the real identity check, a live pid whose creation time differs reads dead and its own creation time reads alive', { timeout: 60000 }, async () => {
  const { spawn } = require('node:child_process');
  const ID = require('../../src/core/proc-identity.cjs');
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  await new Promise((r) => child.once('spawn', r));
  try {
    const snap = await ID.processSnapshot({ kind: 'test' });
    const created = snap && snap.get(child.pid) && snap.get(child.pid).created;
    if (created == null) return; // no readable creation time on this host: nothing to compare
    const run = async (c) => { const m = createDeadPids({ graceMs: 8000, adapterAlive: gone }); const r = orphan({ pid: child.pid, pid_created: c }); m.apply([r]); await m.settled(); return m.apply([r])[0].pid_alive; };
    assert.strictEqual(await run(created), true, 'the process the row names');
    assert.strictEqual(await run(created - 60000), false, 'another process holding the number');
  } finally { child.kill(); }
});
