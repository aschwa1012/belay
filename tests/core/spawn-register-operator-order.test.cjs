'use strict';
// spawn-register-operator-order.test.cjs — the operator check end to end, in the order the owner runs it: the spawned-process list
// first (owner._spawnedProcesses, which reads the register), then the provenance refresh, both against the one snapshot. Review of the
// 2026-10-30 lockout fix found the list read the register by bare pid and retired a dead record at the time of the read, which gave a
// worker that died hours ago a lifetime up to now and refused a detached tool started since. And an operator check for a READ
// writes nothing under the register (invariant 6): the same files give the same answer next time.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { core, deadPid } = require('./helpers.cjs');

const OC = core('operator-check.cjs');
const SR = core('spawn-register.cjs');
const Prov = core('spawn-provenance.cjs');
const { Owner } = core('owner.cjs');

const H = 3600000;
const NOW = Date.now();
const BOOT = SR.bootMs(NOW);
const PEER = 4242;
const tcp = () => ({ belayTransport: 'tcp', remotePort: 61000, localPort: 52100 });
const tableOf = (pid) => async () => `  TCP    127.0.0.1:52100        127.0.0.1:61000        ESTABLISHED     1234\r\n  TCP    127.0.0.1:61000        127.0.0.1:52100        ESTABLISHED     ${pid}\r\n`;
const snapOf = (o) => new Map(Object.entries(o).map(([pid, v]) => [Number(pid), v]));
// The owner's own list function, with no store behind it (it names no workers of its own then).
const spawned = (ctx) => Owner.prototype._spawnedProcesses.call({ store: null, opts: {} }, ctx);
const check = (shot) => OC.create({ startedAt: NOW, spawned, provenance: (s, o) => Prov.refresh(s, o), deps: { table: tableOf(PEER), snapshot: async () => shot } });
const tree = (dir) => {
  const out = {};
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8'); } };
  walk(dir);
  return out;
};

function withRegistry(fn) {
  const keep = process.env.BELAY_SPAWN_REGISTRY;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-spawn-order-'));
  process.env.BELAY_SPAWN_REGISTRY = dir;
  return Promise.resolve().then(() => fn(dir)).finally(() => { process.env.BELAY_SPAWN_REGISTRY = keep; fs.rmSync(dir, { recursive: true, force: true }); });
}
const putRecord = (dir, rec) => fs.writeFileSync(path.join(dir, `${rec.pid}.json`), JSON.stringify({ kind: 'worker', data_dir: null, worker_id: 'w', by_pid: 1, spawned_at: null, ...rec }));
const OLD_SHELL = { 4000: { ppid: 1, created: NOW - 9 * H, image: 'explorer.exe' } };

test('a detached tool started after a dead worker\'s last-seen time is not refused, whether the check persists or not', async () => {
  for (const persist of [false, true]) {
    await withRegistry(async (dir) => {
      const dead = deadPid();
      // the driver shape: worker spawned 3 h ago, last seen 2 h ago, its adapter died with it, never read since
      putRecord(dir, { pid: dead, created: NOW - 3 * H, at: NOW - 3 * H + 500, seen_at: NOW - 2 * H });
      const shot = snapOf({ ...OLD_SHELL, [PEER]: { ppid: 99999, created: NOW - 30 * 60000, image: 'cmd.exe' } });
      const r = await check(shot)({ conn: tcp(), persist });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
    });
  }
});

test('an operator check for a read leaves the register byte for byte as it was; one for a write retires the record', async () => {
  await withRegistry(async (dir) => {
    const dead = deadPid();
    putRecord(dir, { pid: dead, created: NOW - 3 * H, at: NOW - 3 * H + 500, seen_at: NOW - 2 * H });
    // a legacy descendant tombstone the old code left
    SR.saveTombstone({ pid: 236, created: BOOT + 75, from: BOOT + 75, until: null, kind: 'descendant', via: 'worker pid 118952' });
    const before = tree(dir);
    const shot = snapOf({ ...OLD_SHELL, 236: { ppid: 0, created: BOOT + 75, image: 'smss.exe' }, [PEER]: { ppid: 99999, created: NOW - 30 * 60000, image: 'cmd.exe' } });
    assert.strictEqual((await check(shot)({ conn: tcp(), persist: false })).ok, true);
    assert.deepStrictEqual(tree(dir), before, 'nothing written, nothing removed');
    assert.strictEqual((await check(shot)({ conn: tcp(), persist: false })).ok, true, 'the same answer the next time');
    assert.strictEqual((await check(shot)({ conn: tcp(), persist: true })).ok, true);
    assert.ok(!fs.existsSync(path.join(dir, `${dead}.json`)), 'a writer\'s check retires the record');
    assert.ok(!Object.keys(tree(dir)).some((k) => k.includes('236-')), 'and drops the legacy descendant tombstone');
  });
});

test('a pre-boot record with no creation time whose pid is now another process refuses nobody', async () => {
  await withRegistry(async (dir) => {
    // an orchestrator record: created stays null. This process holds the pid now, created a second ago.
    putRecord(dir, { pid: process.pid, created: null, kind: 'orchestrator', spawned_at: BOOT - 10 * H, at: BOOT - 10 * H + 500 });
    const shot = snapOf({ ...OLD_SHELL, 11156: { ppid: 9, created: BOOT + 48000, image: 'explorer.exe' }, [process.pid]: { ppid: 11156, created: NOW - 1000, image: 'node.exe' } });
    const listed = spawned({ snap: shot, persist: false });
    assert.deepStrictEqual(listed.filter((s) => s.pid === process.pid), [], 'not listed as spawned');
    const chain = [{ pid: process.pid, created: NOW - 1000 }, { pid: 11156, created: BOOT + 48000 }];
    assert.strictEqual(OC.spawnedMatch(chain, listed.concat(Prov.refresh(shot, { persist: false }).alive)), null);
  });
});

test('the register read without a snapshot closes a dead record at its last-seen time, never at the read', async () => {
  await withRegistry(async (dir) => {
    const dead = deadPid();
    putRecord(dir, { pid: dead, created: NOW - 3 * H, at: NOW - 3 * H + 500, seen_at: NOW - 2 * H });
    assert.deepStrictEqual(SR.list(), []);
    // a stamped process can live one refresh interval past its stamp, so the close is the stamp plus that
    assert.strictEqual(SR.tombstones().find((t) => t.pid === dead).until, NOW - 2 * H + SR.SEEN_REFRESH_MS);
  });
});

test('every descendant tombstone without via_from is dropped on the first writing check (all are old-code output); one with it is judged by its lifetime', async () => {
  await withRegistry(async () => {
    SR.saveTombstone({ pid: 11156, created: BOOT + 48000, from: BOOT + 48000, until: null, kind: 'descendant', via: 'worker pid 118952' }); // legacy, at the boot
    SR.saveTombstone({ pid: 11157, created: BOOT + 5 * H, from: BOOT + 5 * H, until: null, kind: 'descendant', via: 'worker pid 118952' }); // legacy, a login hours after the boot
    SR.saveTombstone({ pid: 3000, created: BOOT + 5 * H, from: BOOT + 5 * H, until: null, kind: 'descendant', via: 'worker pid 7', via_from: BOOT - 2 * H });
    SR.saveTombstone({ pid: 3001, created: BOOT + 5 * H, from: BOOT + 5 * H, until: null, kind: 'descendant', via: 'worker pid 8', via_from: BOOT + 4 * H });
    const shot = snapOf({ 11156: { ppid: 9, created: BOOT + 48000, image: 'explorer.exe' }, 11157: { ppid: 9, created: BOOT + 5 * H, image: 'explorer.exe' }, 3000: { ppid: 9, created: BOOT + 5 * H, image: 'a.exe' }, 3001: { ppid: 9, created: BOOT + 5 * H, image: 'b.exe' } });
    assert.deepStrictEqual(Prov.refresh(shot, { now: NOW, boot: BOOT, persist: false }).alive.map((a) => a.pid), [3001], 'a read ignores them too');
    assert.strictEqual(SR.tombstones().length, 4, 'and deletes nothing');
    assert.deepStrictEqual(Prov.refresh(shot, { now: NOW, boot: BOOT }).alive.map((a) => a.pid), [3001]);
    assert.deepStrictEqual(SR.tombstones().map((t) => t.pid), [3001]);
  });
});

test('a headless orchestrator whose run process died is covered up to its last stamp: an orphan made hours into its life is still refused', async () => {
  await withRegistry(async (dir) => {
    const s4 = NOW - 4 * H;
    const pid = deadPid();
    putRecord(dir, { pid, kind: 'orchestrator', created: null, spawned_at: s4, at: s4 + 300 });
    const shot = snapOf({ 99001: { ppid: pid, created: s4 + H, image: 'node.exe' } });
    const chain = [{ pid: 99001, created: s4 + H }];
    const match = () => OC.spawnedMatch(chain, spawned({ snap: shot, persist: false }).concat(Prov.refresh(shot, { persist: false }).alive));
    // never stamped: the record closes at the moment it was found dead, so the orphan made an hour in is covered (a lifetime is never closed before the process could have been alive)
    assert.ok(match(), 'never stamped: covered up to the time it was found dead');
    assert.strictEqual(SR.touch(pid, s4 + 3.5 * H), true, 'the run process timer, 3.5 h in');
    assert.ok(match(), 'stamped: the orphan made an hour in is a descendant');
  });
});
