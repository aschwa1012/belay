'use strict';
require('../helpers/tmp.cjs');
// A resume whose start fails before any row moved goes back to the park it started from. That park keeps its own facts ({ at, by }),
// so a message is refused naming who paused it and when, the row keeps the park's paused_at and paused_by, and a later resume reports
// them. The failure is forced by refusing the relaunch's `starting` row write once.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore, FakeCoreError } = require('./fake-core.cjs');

const fwd = (p) => String(p).split(path.sep).join('/');
const FAKE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
const USER_SETTINGS = fwd(path.join(__dirname, 'fixtures', 'user-settings.json'));

test('a resume that fails to start keeps the park it came from, with its own paused_at and paused_by', async (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-resfail-'));
  fs.mkdirSync(path.join(d, 'wt'));
  const core = createFakeCore();
  const m = createRunManager({ core, dataDir: fwd(d), runId: 'run-resfail', paths: { claudeExe: FAKE, userSettings: USER_SETTINGS } });
  t.after(async () => { await m.shutdown().catch(() => {}); try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* tmp */ } });

  await m.spawn({ substrate: 'claude-code', worktree: fwd(path.join(d, 'wt')), prompt: 'one', worker_id: 'w1' });
  await m._waitTurn('w1', 20000);
  const park = await m.pause({ worker_id: 'w1', by: 'operator:1' });
  const write = core.worker.write;
  let failOnce = true;
  core.worker.write = async (r) => {
    if (failOnce && r.id === 'w1' && r.state === 'starting') { failOnce = false; throw new FakeCoreError('E_TIMEOUT', 'fake core: simulated starting-row write failure'); }
    return write(r);
  };
  await assert.rejects(m.resume({ worker_id: 'w1', by: 'operator:2' }), (e) => e.code === 'E_TIMEOUT');
  core.worker.write = write;
  const w = m._worker('w1');
  await new Promise((res) => (w.child ? w.child.once('exit', res) : res()));
  await w.queue;

  const row = core.currentWorker('w1');
  assert.equal(row.state, 'paused');
  assert.equal(row.paused_at, park.paused_at, 'the row keeps the park\'s own paused_at');
  assert.equal(row.paused_by, 'operator:1');
  await assert.rejects(m.message({ worker_id: 'w1', text: 'hi' }), (e) => e.code === 'E_PAUSED' && e.message.includes(`by operator:1 at ${park.paused_at}`) && !/undefined/.test(e.message));
  const again = await m.resume({ worker_id: 'w1', by: 'operator:3' });
  assert.equal(again.resumed, true);
  assert.equal(again.paused_at, park.paused_at);
  assert.equal(again.paused_by, 'operator:1');
});
