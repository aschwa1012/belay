'use strict';
// spawn-register-identity.test.cjs — the operator lockout of 2026-10-30. A record in the spawn register named a worker from before a
// reboot; the register trusted it by bare pid and retired it at the time it was read, so its lifetime covered the boot-time processes
// (explorer among them) as descendants, and every operator command from the desktop was refused. The register now checks a record's
// identity against a process snapshot (creation time, and never a lifetime that began before the current boot), and closes a retired
// record at the last moment it was seen alive. Every time here is a fake clock handed to refresh; no pid is waited on.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { core, deadPid } = require('./helpers.cjs');

const SR = core('spawn-register.cjs');
const Prov = core('spawn-provenance.cjs');

const HOUR = 3600000;
const BOOT = Date.parse('2026-10-29T05:12:08.500Z');
const NOW = BOOT + 22 * HOUR;
const snapOf = (o) => new Map(Object.entries(o).map(([pid, v]) => [Number(pid), v]));
const root = (created) => ({ ppid: 0, created, image: 'x.exe' });

function withRegistry(fn) {
  const keep = process.env.BELAY_SPAWN_REGISTRY;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-spawn-identity-'));
  process.env.BELAY_SPAWN_REGISTRY = dir;
  try { return fn(dir); } finally { process.env.BELAY_SPAWN_REGISTRY = keep; fs.rmSync(dir, { recursive: true, force: true }); }
}
// A record written as the harness would have, with the times chosen by the test.
function putRecord(dir, rec) {
  fs.writeFileSync(path.join(dir, `${rec.pid}.json`), JSON.stringify({ kind: 'worker', data_dir: null, worker_id: 'w', by_pid: 1, spawned_at: null, ...rec }));
}
const tomb = (pid) => SR.tombstones().find((t) => t.pid === pid);
const aliveOf = (snap, extra = {}) => Prov.refresh(snap, { now: NOW, boot: BOOT, ...extra }).alive.map((a) => a.pid);

test('a record whose pid now belongs to another process is not that worker, and its lifetime ends when it was last seen', () => withRegistry((dir) => {
  const spawned = NOW - 3 * HOUR;
  const seen = spawned + 20 * 60000;
  // This very process holds the pid, as a reused pid would be held; the record names a process created three hours ago.
  putRecord(dir, { pid: process.pid, created: spawned, at: spawned + 500, seen_at: seen });
  const during = 6000; // created while the worker ran
  const after = NOW - HOUR; // created long after it was last seen alive
  const snap = snapOf({ [process.pid]: root(NOW - 60000), 5001: root(seen - during), 5002: root(after) });
  assert.deepStrictEqual(aliveOf(snap), [5001], 'only the root made while it ran is a descendant');
  assert.strictEqual(SR.live({ snap, now: NOW, boot: BOOT }).length, 0, 'the reused pid is not the recorded process');
  assert.strictEqual(tomb(process.pid), undefined, 'the retired lifetime is dropped once what it reached is recorded');
}));

test('a retired record closes at its last-seen time, never at the time it is read', () => withRegistry((dir) => {
  const spawned = NOW - 5 * HOUR;
  putRecord(dir, { pid: 4100, created: spawned, at: spawned + 100, seen_at: spawned + 600000 });
  const snap = snapOf({ 6001: root(spawned + 300000), 6002: root(spawned + 600000 + 1000), 6003: root(NOW - HOUR) });
  const got = aliveOf(snap);
  assert.deepStrictEqual(got.sort(), [6001, 6002], 'roots made within the worker\'s life (and the slack) are recorded; one made hours later is not');
  assert.strictEqual(SR.live({ snap, now: NOW, boot: BOOT }).length, 0);
  const closed = SR.tombstones().filter((t) => t.pid === 4100);
  assert.strictEqual(closed.length, 0, 'its own tombstone is dropped after the refresh');
  // The same, read directly through the register: the tombstone's until is the stamp.
  putRecord(dir, { pid: 4101, created: spawned, at: spawned + 100, seen_at: spawned + 600000 });
  SR.live({ snap: snapOf({}), now: NOW, boot: BOOT });
  // A stamped process can live up to one refresh interval past its last stamp, so the lifetime closes there (never earlier).
  assert.strictEqual(tomb(4101).until, spawned + 600000 + SR.SEEN_REFRESH_MS);
  putRecord(dir, { pid: 4102, created: spawned, at: spawned + 100 });
  SR.live({ snap: snapOf({}), now: NOW, boot: BOOT });
  assert.strictEqual(tomb(4102).until, NOW, 'a record never stamped closes at the moment it was found dead');
}));

test('a record from before the current boot covers nothing, whatever answers to its pid', () => withRegistry((dir) => {
  const spawned = BOOT - 10 * HOUR;
  // This process holds the pid, so a bare pid check calls the record alive; its creation time (after the boot) says it is not.
  putRecord(dir, { pid: process.pid, created: spawned, at: spawned + 500 });
  const bootRoots = snapOf({ 4: root(BOOT + 75), 236: root(BOOT + 75), 11156: root(BOOT + 48000), [process.pid]: root(NOW - 60000) });
  assert.deepStrictEqual(aliveOf(bootRoots), [], 'boot-time processes are not descendants of a pre-boot worker');
  // And a record with no creation time at all, dated before the boot: the boot alone retires it.
  putRecord(dir, { pid: process.pid, created: null, at: spawned + 500 });
  assert.deepStrictEqual(aliveOf(bootRoots), []);
  assert.strictEqual(SR.live({ snap: bootRoots, now: NOW, boot: BOOT }).length, 0);
}));

test('an exited lifetime from before the boot is dropped, not applied to the processes the boot started', () => withRegistry(() => {
  // As the old code left it: retired when read, a day after the exit, so its window ran past the boot into the boot's own processes.
  SR.saveTombstone({ pid: 9001, created: BOOT - 10 * HOUR, from: BOOT - 10 * HOUR, until: BOOT + 1000, kind: 'worker', via: null });
  const snap = snapOf({ 236: root(BOOT + 75), 11156: root(BOOT + 48000) });
  assert.deepStrictEqual(aliveOf(snap), []);
  assert.strictEqual(tomb(9001), undefined, 'the pre-boot lifetime is gone');
}));

test('a read finds a live record alive and writes nothing to it; the adapter that holds the child stamps it', () => withRegistry((dir) => {
  const spawned = NOW - 20 * 60000;
  putRecord(dir, { pid: 4300, created: spawned, at: spawned + 100 });
  const file = path.join(dir, '4300.json');
  const before = fs.readFileSync(file, 'utf8');
  const snap = snapOf({ 4300: { ppid: 1, created: spawned, image: 'node.exe' }, 7001: root(NOW - 60000) });
  assert.deepStrictEqual(aliveOf(snap), [7001], 'a root made while the worker runs is its descendant');
  assert.deepStrictEqual(SR.live({ snap, now: NOW, boot: BOOT }).map((r) => r.pid), [4300]);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'reading the register stamped nothing');
  assert.strictEqual(SR.touch(4300, NOW), true, 'the adapter own stamp');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual([rec.seen_at, rec.created, rec.at], [NOW, spawned, spawned + 100], 'the stamp keeps the rest of the record, `at` included');
  assert.strictEqual(SR.touch(4300, NOW + 1000), false, 'a second stamp a moment later is not written');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).seen_at, NOW);
}));

test('without a snapshot the register reads as it did: by pid, so list() and its callers are unchanged', () => withRegistry(() => {
  SR.register({ pid: process.pid, kind: 'worker', created: 5000 });
  assert.strictEqual(SR.list().length, 1, 'an old fake creation time is not a boot check when no snapshot is given');
}));

test('retire closes a dead pid\'s record at the later of its stamp and the row\'s last event, never past now; a live pid is left', () => withRegistry((dir) => {
  const t = NOW - 5 * HOUR; const d1 = deadPid(); const d2 = deadPid();
  putRecord(dir, { pid: d1, created: t, at: t + 100, seen_at: t + 1000 });
  putRecord(dir, { pid: process.pid, created: t, at: t + 100 });
  assert.strictEqual(SR.retire(process.pid, NOW), false, 'a pid that still answers is not retired');
  assert.ok(fs.existsSync(path.join(dir, `${process.pid}.json`)));
  assert.strictEqual(SR.retire(d1, NOW, t + 90000), true);
  // A stamped process can live one refresh interval past its stamp: the close is that, and the row's last event does not move it.
  assert.strictEqual(tomb(d1).until, t + 1000 + SR.SEEN_REFRESH_MS);
  putRecord(dir, { pid: d2, created: t, at: t + 100 });
  SR.retire(d2, t + 50, t + 90000);
  assert.strictEqual(tomb(d2).until, t + 50, 'never later than the time of the close');
}));
