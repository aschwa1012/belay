'use strict';
// Audit 0.3.1, run R2. `message` takes no operation slot and does not look at `stopRequested`, so a
// message that arrives once a stop has written its `stopping` row is still written to stdin, answered
// `{ channel: 'stdin' }`, and its `running` row is written over the stop's `stopping` row.
// The message is sent from inside the fake core's `stopping` write, so the ordering is forced, not timed.
// Run: node --test tests/audit-0-3-1/message-during-stop.audit.cjs (npm test does not glob *.audit.cjs).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('../run/fake-core.cjs');

const fwd = (p) => String(p).split(path.sep).join('/');
const FAKE = fwd(path.join(__dirname, '..', 'run', 'fakes', 'fake-claude.cjs'));
const USER_SETTINGS = fwd(path.join(__dirname, '..', 'run', 'fixtures', 'user-settings.json'));

test('a message sent once a stop has written its stopping row is refused, and no running row follows the stopping row', async (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-audit-msgstop-'));
  fs.mkdirSync(path.join(d, 'wt'));
  const recv = fwd(path.join(d, 'recv.jsonl'));
  process.env.FAKE_RECV_FILE = recv;
  t.after(() => { delete process.env.FAKE_RECV_FILE; try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* tmp */ } });

  const core = createFakeCore();
  const m = createRunManager({ core, dataDir: fwd(d), runId: 'run-msgstop', paths: { claudeExe: FAKE, userSettings: USER_SETTINGS } });
  t.after(() => m.shutdown().catch(() => {}));
  await m.spawn({ substrate: 'claude-code', worktree: fwd(path.join(d, 'wt')), prompt: 'hello', worker_id: 'w1' });
  await m._waitTurn('w1', 20000);

  let msg = null;
  const write = core.worker.write;
  core.worker.write = async (r) => {
    const out = await write(r);
    if (r.state === 'stopping' && !msg) msg = m.message({ worker_id: 'w1', text: 'sent during the stop' }).then((x) => ({ ok: x }), (e) => ({ err: e.code }));
    return out;
  };
  const stop = await m.stop({ worker_id: 'w1', mode: 'graceful', timeout_ms: 5000 });
  const answer = await msg;
  const states = core.rowsFor('w1').map((x) => x.state);
  const at = states.lastIndexOf('stopping');
  const received = fs.existsSync(recv) ? fs.readFileSync(recv, 'utf8').trim().split('\n').map((l) => JSON.parse(l).text) : [];
  console.log(JSON.stringify({ answer, states, after_stopping: states.slice(at + 1), received, stop: { graceful: stop.graceful, exit_code: stop.exit_code } }));
  assert.ok(answer.err, `a message to a worker being stopped must be refused; it was answered ${JSON.stringify(answer.ok)}`);
  assert.ok(!states.slice(at + 1).includes('running'), 'no running row may follow the stop\'s stopping row');
});
