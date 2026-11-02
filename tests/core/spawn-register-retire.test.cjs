'use strict';
// spawn-register-retire.test.cjs — retire() acts on the record its caller judged, not on whatever holds the pid number (Windows reuses
// pids), and a dead record's lifetime is bounded: it closes two stamp periods after the last moment the process was seen alive, never
// left open to the time it is found dead. A record from before the boot gets no lifetime at all, and a descendant tombstone without
// via_from (old-code output) is dropped.

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
const BOOT = NOW - 10 * 24 * H; // a fixed boot, so the tests do not depend on the host's real uptime

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

// A machine whose uptime did not reset (Fast Startup) or a hard-killed run leaves a dead, unstamped record inside the current boot. Its
// window must not stay open to the time it is found dead: a root (explorer-like) created long after the record was written is not its
// descendant, or every operator check is refused until the next restart.
test('a dead unstamped record inside the current boot covers a root made within 60 s of its write, and none made later', () => withRegistry((dir) => {
  const pid = deadPid();
  put(dir, { pid, created: T, at: T + 500 });
  const root = (created) => ({ ppid: 0, created, image: 'explorer.exe' });
  const shot = new Map([[7001, root(T + 30000)], [7002, root(T + 500 + 2 * SR.SEEN_REFRESH_MS + 60000)], [7003, root(NOW - 60000)]]);
  const got = Prov.refresh(shot, { now: NOW, boot: BOOT }).alive.map((a) => a.pid).sort();
  assert.deepStrictEqual(got, [7001], 'only the root made inside the window is recorded');
}));

// The stamp timer runs every SEEN_REFRESH_MS. When the harness holding a worker is hard-killed between two ticks (no exit handler runs),
// the worker runs on unstamped; a descendant it makes 20 s after the last stamp, before it dies, is still its descendant.
test('a worker whose harness was hard-killed covers a descendant made 20 s after its last stamp', () => withRegistry((dir) => {
  const pid = deadPid();
  const last = T + H; // the last tick before the kill
  put(dir, { pid, created: T, at: T + 100, seen_at: last });
  const child = (created) => ({ ppid: pid, created, image: 'node.exe' });
  const shot = new Map([[7101, child(last + 20000)], [7102, child(last + 2 * SR.SEEN_REFRESH_MS + 10000)]]);
  const got = Prov.refresh(shot, { now: NOW, boot: BOOT }).alive.map((a) => a.pid).sort();
  assert.deepStrictEqual(got, [7101], 'the descendant made between the last stamp and the death is covered; one past two periods is not');
}));
