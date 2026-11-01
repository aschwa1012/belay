'use strict';
// spawn-register-retire.test.cjs — retire() acts on the record its caller judged, not on whatever holds the pid number (Windows reuses
// pids), and a dead record's lifetime never closes before the process could have been alive: a stamped one a refresh interval past its
// stamp (capped at the time it is found dead), an unstamped one at the time it is found dead. A record from before the boot gets no
// lifetime at all, and a descendant tombstone without via_from (old-code output) is dropped.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { core, deadPid } = require('./helpers.cjs');

const SR = core('spawn-register.cjs');
const Prov = core('spawn-provenance.cjs');

const H = 3600000;
const NOW = Date.now();
const BOOT = NOW - 22 * H;

function withRegistry(fn) {
  const keep = process.env.BELAY_SPAWN_REGISTRY;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-retire-'));
  process.env.BELAY_SPAWN_REGISTRY = dir;
  try { return fn(dir); } finally { process.env.BELAY_SPAWN_REGISTRY = keep; fs.rmSync(dir, { recursive: true, force: true }); }
}
const put = (dir, rec) => fs.writeFileSync(path.join(dir, `${rec.pid}.json`), JSON.stringify({ kind: 'worker', data_dir: null, worker_id: 'w1', by_pid: 1, spawned_at: null, ...rec }));
const tomb = (pid) => SR.tombstones().find((t) => t.pid === pid);
const T = NOW - 5 * H;

test('retire with expect refuses a record of another worker, or of another process, under the same pid', () => withRegistry((dir) => {
  const pid = deadPid();
  put(dir, { pid, created: T, at: T + 100, seen_at: T + 1000 });
  const file = path.join(dir, `${pid}.json`);
  assert.strictEqual(SR.retire(pid, NOW, null, { checked: true, expect: { workerId: 'w2', created: T } }), false, 'another worker id');
  assert.strictEqual(SR.retire(pid, NOW, null, { checked: true, expect: { workerId: 'w1', created: T + 5 } }), false, 'another creation time');
  assert.ok(fs.existsSync(file), 'the record stays');
  assert.strictEqual(tomb(pid), undefined, 'and no lifetime is closed');
  assert.strictEqual(SR.retire(pid, NOW, null, { checked: true, expect: { workerId: 'w1', created: null } }), true, 'an unknown creation time on the caller side is not compared');
  assert.ok(!fs.existsSync(file));
  assert.ok(tomb(pid));
}));

test('retire with expect retires its own worker record when the creation times agree', () => withRegistry((dir) => {
  const pid = deadPid();
  put(dir, { pid, created: T, at: T + 100 });
  assert.strictEqual(SR.retire(pid, NOW, null, { checked: true, expect: { workerId: 'w1', created: T } }), true);
  assert.ok(!fs.existsSync(path.join(dir, `${pid}.json`)));
}));

test('a dead unstamped record closes at the time it is found dead; a stamped one a refresh interval after its stamp, capped at that time', () => withRegistry((dir) => {
  const [a, b, c] = [deadPid(), deadPid(), deadPid()];
  put(dir, { pid: a, created: T, at: T + 100 });
  put(dir, { pid: b, created: T, at: T + 100, seen_at: T + 1000 });
  put(dir, { pid: c, created: T, at: T + 100, seen_at: NOW - 1000 });
  const r = SR.scan({ snap: new Map(), now: NOW, boot: BOOT });
  const until = (pid) => r.dead.find((d) => d.rec.pid === pid).tomb.until;
  assert.strictEqual(until(a), NOW, 'unstamped: now');
  assert.strictEqual(until(b), T + 1000 + SR.SEEN_REFRESH_MS, 'stamped long ago: stamp plus one refresh interval');
  assert.strictEqual(until(c), NOW, 'stamped a moment ago: capped at now');
  // retire agrees with scan
  const d = deadPid(); const e = deadPid();
  put(dir, { pid: d, created: T, at: T + 100 });
  put(dir, { pid: e, created: T, at: T + 100, seen_at: T + 1000 });
  SR.retire(d, NOW, T + 90000, { checked: true });
  SR.retire(e, NOW, T + 90000, { checked: true });
  assert.strictEqual(tomb(d).until, NOW);
  assert.strictEqual(tomb(e).until, T + 1000 + SR.SEEN_REFRESH_MS);
}));

test('the reported defect stays fixed: a pre-boot record gets no tombstone, and a descendant tombstone without via_from is dropped', () => withRegistry((dir) => {
  const pid = deadPid();
  put(dir, { pid, created: BOOT - 10 * H, at: BOOT - 10 * H + 500, seen_at: BOOT - 9 * H });
  const r = SR.scan({ snap: new Map(), now: NOW, boot: BOOT });
  assert.strictEqual(r.dead.length, 1);
  assert.strictEqual(r.dead[0].tomb, null, 'a pre-boot record has no lifetime');
  SR.saveTombstone({ pid: 11156, created: BOOT + 48000, from: BOOT + 48000, until: null, kind: 'descendant', via: 'worker pid 118952' });
  const shot = new Map([[11156, { ppid: 9, created: BOOT + 48000, image: 'explorer.exe' }]]);
  assert.deepStrictEqual(Prov.refresh(shot, { now: NOW, boot: BOOT }).alive.map((a) => a.pid), []);
  assert.strictEqual(tomb(11156), undefined, 'the legacy descendant tombstone is dropped');
}));
