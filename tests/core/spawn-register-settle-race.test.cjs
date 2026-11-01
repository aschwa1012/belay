'use strict';
// spawn-register-settle-race.test.cjs — a record found dead by a scan is removed by the settle that follows it. Between the two a
// worker can be registered under the same pid (Windows hands the number out again within seconds); the settle must not delete that
// record, which belongs to a running worker. Forced with the real order of calls, not timing: scan, register, settle.

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
const BOOT = SR.bootMs(NOW);

function withRegistry(fn) {
  const keep = process.env.BELAY_SPAWN_REGISTRY;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-settle-race-'));
  process.env.BELAY_SPAWN_REGISTRY = dir;
  try { return fn(dir); } finally { process.env.BELAY_SPAWN_REGISTRY = keep; fs.rmSync(dir, { recursive: true, force: true }); }
}
const put = (dir, rec) => fs.writeFileSync(path.join(dir, `${rec.pid}.json`), JSON.stringify({ kind: 'worker', data_dir: null, worker_id: 'old', by_pid: 1, spawned_at: null, ...rec }));
const OLD = { created: NOW - 3 * H, at: NOW - 3 * H + 500, seen_at: NOW - 2 * H };

test('a record re-registered under the same pid between the scan and the settle is not deleted', () => withRegistry((dir) => {
  const pid = deadPid();
  put(dir, { pid, ...OLD });
  const found = SR.scan({ snap: new Map(), now: NOW, boot: BOOT });
  assert.deepStrictEqual(found.dead.map((d) => d.rec.pid), [pid], 'the old record is dead');
  SR.register({ pid, kind: 'worker', workerId: 'new', created: NOW - 1000 }); // the number went to a new worker
  SR.settle(found.dead);
  const kept = JSON.parse(fs.readFileSync(path.join(dir, `${pid}.json`), 'utf8'));
  assert.deepStrictEqual([kept.worker_id, kept.created], ['new', NOW - 1000], 'the running worker\'s record stands');
  assert.ok(SR.tombstones().some((t) => t.pid === pid && t.until === OLD.seen_at + SR.SEEN_REFRESH_MS), 'the old process\'s lifetime is still kept');
}));

test('the same through refresh: a register between its scan and its settle', () => withRegistry((dir) => {
  const pid = deadPid();
  put(dir, { pid, ...OLD });
  const afterScan = () => SR.register({ pid, kind: 'worker', workerId: 'new', created: NOW - 1000 });
  Prov.refresh(new Map(), { now: NOW, boot: BOOT, afterScan });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, `${pid}.json`), 'utf8')).worker_id, 'new');
}));

test('an unchanged record is removed as before, and one already gone is not an error', () => withRegistry((dir) => {
  const pid = deadPid();
  put(dir, { pid, ...OLD });
  const found = SR.scan({ snap: new Map(), now: NOW, boot: BOOT });
  SR.settle(found.dead);
  assert.ok(!fs.existsSync(path.join(dir, `${pid}.json`)));
  SR.settle(found.dead); // a second settle of the same scan
}));
