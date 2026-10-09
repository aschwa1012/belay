// wire-log-relaunch.test.cjs — build 12 A1 fix round 1 (review B1, S1): a worker whose adapter.log is
// already at the cap from earlier launches must still show this launch's start line and tools/list
// past the offset the run manager records, because ADR 0001 §8's Codex ready check reads exactly that.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { launch, sandboxDir } = require('./rpc.cjs');
const { wireLogHasToolsList, rotateWireLog, ROTATE_AT } = require('../../src/run/wire-log.cjs');

const prefilled = (data, bytes) => {
  const dir = `${data}/workers/wk-1`;
  fs.mkdirSync(dir, { recursive: true });
  const log = `${dir}/adapter.log`;
  fs.writeFileSync(log, 'x'.repeat(bytes - 1) + '\n'); // earlier launches' bytes
  return log;
};

async function relaunch(data, log, since) {
  const a = launch({ role: 'worker', data, workerId: 'wk-1', log });
  try {
    await a.initialize();
    await a.list();
    await a.close();
  } finally { a.kill(); }
  return { grew: fs.statSync(log).size - since, hit: wireLogHasToolsList(log, since) };
}

test('a launch over a log already past the frame cap still logs tools/list past its start offset', async (t) => {
  const data = sandboxDir('a1relaunch');
  t.after(() => { try { fs.rmSync(data, { recursive: true, force: true }); } catch { /* temp sweep */ } });
  const log = prefilled(data, ROTATE_AT + 10);
  const since = fs.statSync(log).size; // no rotation: the writer's own caps must not depend on the file
  const r = await relaunch(data, log, since);
  assert.strictEqual(r.hit.seen, true, `tools/list not seen past the offset; log grew by ${r.grew}`);
  assert.match(fs.readFileSync(log, 'utf8'), /## start role=worker/);
});

test('rotation at launch moves a large log to .1, replaces an older .1, and the launch reads from a small offset', async (t) => {
  const data = sandboxDir('a1rotate');
  t.after(() => { try { fs.rmSync(data, { recursive: true, force: true }); } catch { /* temp sweep */ } });
  const log = prefilled(data, ROTATE_AT + 10);
  fs.writeFileSync(`${log}.1`, 'older rotation\n');
  assert.strictEqual(rotateWireLog(log), true);
  assert.strictEqual(fs.existsSync(log), false, 'the live file starts fresh');
  assert.strictEqual(fs.statSync(`${log}.1`).size, ROTATE_AT + 10, 'the old .1 was replaced by the large file');
  assert.strictEqual(rotateWireLog(log), false, 'nothing to rotate when absent');
  const r = await relaunch(data, log, 0);
  assert.strictEqual(r.hit.seen, true);
  assert.ok(fs.statSync(log).size < 64 * 1024, 'the fresh file holds only this launch');
  fs.writeFileSync(log, 'small\n');
  assert.strictEqual(rotateWireLog(log), false, 'a log under the threshold is left alone');
});
