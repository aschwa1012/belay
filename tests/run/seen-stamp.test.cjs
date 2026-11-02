'use strict';
require('../helpers/tmp.cjs');
// seen-stamp.test.cjs — the stamp on a spawn-register record (seen-stamp.cjs). A process the harness observes (a child handle, the
// orchestrator hook) is stamped while it lives; an adopted worker holds no handle, so it is stamped only when one snapshot shows its
// pid with the creation time the row recorded, and retired when another process holds the pid. Seams stand in for the snapshot, so
// nothing here waits on a timer or a process.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SS = require('../../src/run/seen-stamp.cjs');
const SR = require('../../src/core/spawn-register.cjs');

const T0 = Date.now() - 6 * 3600000;
function withRegistry(fn) {
  const keep = process.env.BELAY_SPAWN_REGISTRY;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-seen-stamp-'));
  process.env.BELAY_SPAWN_REGISTRY = dir;
  return Promise.resolve().then(() => fn(dir)).finally(() => { SS.stopAdopted(); process.env.BELAY_SPAWN_REGISTRY = keep; fs.rmSync(dir, { recursive: true, force: true }); });
}
const put = (dir, pid) => fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, created: T0, kind: 'worker', data_dir: 'A:/store', worker_id: 'w-' + pid, spawned_at: T0, by_pid: 1, at: T0 }));
const seen = (dir, pid) => JSON.parse(fs.readFileSync(path.join(dir, `${pid}.json`), 'utf8')).seen_at;
const snapOf = (o) => new Map(Object.entries(o).map(([pid, v]) => [Number(pid), v]));
const adopt = (pid, o = {}) => ({ id: 'w-' + pid, dataDir: 'A:/store', pid, pidCreated: T0, state: 'running', ...o });

test('stampWhile stamps while the observer says the process lives, whatever a pid check would say', () => {
  let tick = null; let cleared = false; let alive = true; const stamped = [];
  const s = SS.stampWhile(() => alive, 77, { every: 30000, touch: (p) => stamped.push(p), setTimer: (fn, ms) => { tick = fn; assert.strictEqual(ms, 30000); return 't'; }, clearTimer: () => { cleared = true; } });
  tick(); alive = false; tick();
  assert.deepStrictEqual(stamped, [77], 'stamped while alive, not after the exit');
  s.stop();
  assert.strictEqual(cleared, true);
});

test('an adopted worker whose pid shows its recorded creation time is stamped; one whose pid another process holds is retired', () => withRegistry(async (dir) => {
  put(dir, 6001); put(dir, 6002);
  assert.ok(SS.stampAdopted(adopt(6001)));
  assert.ok(SS.stampAdopted(adopt(6002)));
  const NOW = T0 + 5 * 3600000;
  const snap = snapOf({ 6001: { ppid: 1, created: T0, image: 'claude.exe' }, 6002: { ppid: 1, created: T0 + 3600000, image: 'other.exe' } });
  await SS.tickAdopted({ snapshot: async () => snap, now: NOW });
  assert.strictEqual(seen(dir, 6001), NOW, 'stamped by pid and creation time');
  assert.ok(!fs.existsSync(path.join(dir, '6002.json')), 'the record of a pid another process holds is retired');
  const t = SR.tombstones().find((x) => x.pid === 6002);
  assert.strictEqual(t.until, T0 + 2 * SR.SEEN_REFRESH_MS, 'closed two stamp periods after its last-seen time (never stamped: its record time), not at the pass');
  assert.strictEqual(SS.adoptedSize(), 1, 'and no longer followed');
}));

test('an unreadable snapshot, an unverifiable pid or a worker with no life stamps and retires nothing', () => withRegistry(async (dir) => {
  put(dir, 6101); put(dir, 6102);
  SS.stampAdopted(adopt(6101));
  assert.strictEqual(SS.stampAdopted(adopt(6102, { state: 'dead' })), false, 'a terminal row has no life to hold');
  assert.strictEqual(SS.stampAdopted(adopt(6102, { pidCreated: null })), false, 'no recorded creation time: no identity to stamp by');
  await SS.tickAdopted({ snapshot: async () => null, now: T0 + 1000 });
  assert.strictEqual(seen(dir, 6101), undefined, 'no snapshot: no stamp');
  assert.ok(fs.existsSync(path.join(dir, '6101.json')), 'and no retirement');
  const w = adopt(6101);
  SS.stampAdopted(w);
  w.pid = 6999; // relaunched under another pid: the adopted record is not this worker's any more
  await SS.tickAdopted({ snapshot: async () => snapOf({}), now: T0 + 2000 });
  assert.ok(fs.existsSync(path.join(dir, '6101.json')), 'a worker that moved on is not retired by its old pid');
  assert.strictEqual(SS.adoptedSize(), 0);
}));

test('adopting a running worker from its row puts it under the stamp; adopting a stopped one does not', async () => {
  const W = require('../../src/run/worker.cjs');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-adopt-stamp-')).split(path.sep).join('/');
  const rowOf = (id, state, pid_created) => ({ id, run_id: 'run-s', substrate: 'claude-code', worktree: `${data}/wt`, state, seq: 3, pid: 6201, pid_created, turns: 1, session_id: 's1' });
  const adopt = (id, state, created) => W.adopt({ core: { worker: { get: async () => rowOf(id, state, created) } }, workerId: id, dataDir: data, runId: null });
  try {
    await adopt('wa', 'stopped', T0);
    assert.strictEqual(SS.adoptedSize(), 0, 'a stopped row has no life');
    await adopt('wb', 'running', null);
    assert.strictEqual(SS.adoptedSize(), 0, 'no recorded creation time: nothing to stamp by');
    await adopt('wc', 'running', T0);
    assert.strictEqual(SS.adoptedSize(), 1, 'a running row with its creation time is followed');
  } finally { SS.stopAdopted(); fs.rmSync(data, { recursive: true, force: true }); }
});
