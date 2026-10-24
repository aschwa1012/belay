'use strict';
require('../helpers/tmp.cjs');
// A message never lands inside a stop, a restart or a resume. Each case sends the message from inside the fake core's write of the
// row that marks the window (the stop's `stopping`, the Codex stop's `stopped`, the restart's `starting`), so the ordering is forced,
// not timed. Without the refusal the message reached stdin after the stop began (its `running` row landing after `stopping`), started
// a new Codex turn process after the stop's kill, or reached a relaunched worker ahead of its resume text.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');

const fwd = (p) => String(p).split(path.sep).join('/');
const FAKE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
const FAKE_CODEX = fwd(path.join(__dirname, 'fakes', 'fake-codex.cjs'));
const USER_SETTINGS = fwd(path.join(__dirname, 'fixtures', 'user-settings.json'));

function setup(t, runId, env = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-msgstop-'));
  fs.mkdirSync(path.join(d, 'wt'));
  const recv = fwd(path.join(d, 'recv.jsonl'));
  const vars = { FAKE_RECV_FILE: recv, ...env };
  Object.assign(process.env, vars);
  const core = createFakeCore();
  const m = createRunManager({ core, dataDir: fwd(d), runId, paths: { claudeExe: FAKE, codexExe: FAKE_CODEX, userSettings: USER_SETTINGS } });
  t.after(async () => { await m.shutdown().catch(() => {}); for (const k of Object.keys(vars)) delete process.env[k]; try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* tmp */ } });
  const received = () => (fs.existsSync(recv) ? fs.readFileSync(recv, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).text) : []);
  return { core, m, worktree: fwd(path.join(d, 'wt')), received };
}

// Sends the message once, from inside the first write of `state` for w1; the answer is { ok } or { err }.
function messageOnWrite(core, m, state, text) {
  let msg = null;
  const write = core.worker.write;
  core.worker.write = async (r) => {
    const out = await write(r);
    if (r.id === 'w1' && r.state === state && !msg) msg = m.message({ worker_id: 'w1', text }).then((x) => ({ ok: x }), (e) => ({ err: e.code, op: e.detail && e.detail.op }));
    return out;
  };
  return () => msg;
}

test('a message sent once a stop has written its stopping row is refused, and no running row follows the stopping row', async (t) => {
  const { core, m, worktree, received } = setup(t, 'run-msgstop');
  await m.spawn({ substrate: 'claude-code', worktree, prompt: 'hello', worker_id: 'w1' });
  await m._waitTurn('w1', 20000);
  const answer = messageOnWrite(core, m, 'stopping', 'sent during the stop');
  await m.stop({ worker_id: 'w1', mode: 'graceful', timeout_ms: 5000 });
  const got = await answer();
  const states = core.rowsFor('w1').map((x) => x.state);
  assert.deepEqual(got, { err: 'E_BUSY', op: 'stop' }, `a message to a worker being stopped must be refused; got ${JSON.stringify(got)}`);
  assert.ok(!states.slice(states.lastIndexOf('stopping') + 1).includes('running'), 'no running row may follow the stop\'s stopping row');
  assert.ok(!received().includes('sent during the stop'));
});

test('a message to a Codex worker after the stop\'s kill, while the stop is still finishing, starts no turn process', async (t) => {
  const { core, m, worktree } = setup(t, 'run-msgstop-cx', { FAKE_CODEX_TURN_MS: '60000' });
  await m.spawn({ substrate: 'codex', worktree, prompt: 'a long turn', worker_id: 'w1' });
  const answer = messageOnWrite(core, m, 'stopped', 'sent after the kill');
  const stop = await m.stop({ worker_id: 'w1', mode: 'kill', timeout_ms: 5000 });
  const got = await answer();
  assert.deepEqual(got, { err: 'E_BUSY', op: 'stop' }, `got ${JSON.stringify(got)}`);
  assert.equal(m._worker('w1').child, null, 'no new turn process is running after the stop returned');
  assert.equal(core.currentWorker('w1').state, 'stopped');
  assert.equal(stop.killed, true);
});

test('a message during a restart is refused, so the relaunched worker gets its resume text first', async (t) => {
  const { core, m, worktree, received } = setup(t, 'run-msgstop-rs');
  await m.spawn({ substrate: 'claude-code', worktree, prompt: 'hello', worker_id: 'w1' });
  await m._waitTurn('w1', 20000);
  await m.stop({ worker_id: 'w1', mode: 'kill', timeout_ms: 5000 });
  const answer = messageOnWrite(core, m, 'starting', 'sent during the restart');
  await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 20000 });
  const got = await answer();
  assert.deepEqual(got, { err: 'E_BUSY', op: 'restart' }, `got ${JSON.stringify(got)}`);
  assert.ok(!received().includes('sent during the restart'));
});

// The second check, after the launch hold: a Codex message that passed the first check waits on the task's hold, a restart takes the
// slot meanwhile (its own hold is kept waiting until the message has answered), and the message must not then start a turn process.
test('a Codex message whose launch hold a restart overtakes is refused before it starts a process', async (t) => {
  const { core, m, worktree } = setup(t, 'run-msgstop-hold', { FAKE_CODEX_TURN_MS: '1500' });
  await m.spawn({ substrate: 'codex', worktree, prompt: 'one turn', worker_id: 'w1', task_id: 't1' });
  const w = m._worker('w1');
  await m.wait({ worker_ids: ['w1'], timeout_ms: 20000 });
  await w.queue;
  assert.equal(w.state, 'idle');
  const hold = core.task.ensureHold;
  let release; const released = new Promise((r) => { release = r; });
  let calls = 0; let restart = null;
  core.task.ensureHold = async (a) => {
    calls += 1;
    if (calls === 1) { // the message's hold: let a restart take the slot before it returns
      restart = m.restart({ worker_id: 'w1', first_turn_timeout_ms: 20000 }).catch((e) => e);
      for (let i = 0; i < 1000 && !w.op; i += 1) await new Promise((r) => setImmediate(r));
      assert.equal(w.op && w.op.name, 'restart');
    } else if (calls === 2) await released; // the restart's own hold waits for the message's answer
    return hold(a);
  };
  const got = await m.message({ worker_id: 'w1', text: 'overtaken' }).then((x) => ({ ok: x.channel }), (e) => ({ err: e.code, op: e.detail && e.detail.op }));
  release();
  await restart;
  assert.deepEqual(got, { err: 'E_BUSY', op: 'restart' }, `got ${JSON.stringify(got)}`);
  assert.equal(w.launches, 2, 'one launch for the spawn and one for the restart, none for the message');
});

// Sent from inside the resume's `running` write: the park is cleared by then (an earlier write still reads paused, E_PAUSED), and the
// resume still holds the slot until that write lands.
test('a message during a resume is refused until the resume returns', async (t) => {
  const { core, m, worktree, received } = setup(t, 'run-msgstop-resume');
  await m.spawn({ substrate: 'claude-code', worktree, prompt: 'hello', worker_id: 'w1' });
  await m._waitTurn('w1', 20000);
  await m.pause({ worker_id: 'w1', by: 'operator:1' });
  const answer = messageOnWrite(core, m, 'running', 'sent during the resume');
  await m.resume({ worker_id: 'w1', by: 'operator:2' });
  const got = await answer();
  assert.deepEqual(got, { err: 'E_BUSY', op: 'resume' }, `got ${JSON.stringify(got)}`);
  assert.ok(!received().includes('sent during the resume'));
});
