'use strict';
// mid-turn.test.cjs — build step 5b, Done item 2. A real
// RunManager against tests/run/fake-core.cjs, with tests/run/fakes/fake-claude.cjs as the worker,
// exactly as tests/run/wait.test.cjs drives it. Every assertion is about the row the fake core
// recorded, never about what the fake said.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const P = require('../../src/run/process.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');

// Every fake worker's own answer is delayed so a `message`'s mid-turn row write can be observed
// before its turn actually ends. The real subprocess round trip (a pipe write, the child's own
// event loop, a pipe read back) is already slower than the pure promise chain a queued write takes,
// but this removes any doubt and keeps the test deterministic rather than merely likely.
process.env.FAKE_ANSWER_DELAY_MS = '1200';

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-midturn-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: d.replace(/\\/g, '/'), worktree: path.join(d, 'wt').replace(/\\/g, '/') };
}

function mgr(sb, core) {
  return createRunManager({
    core, dataDir: sb.data, runId: 'run-midturn',
    paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
  });
}

test('the running row at ready carries mid_turn: 1, and the row onTurnEnd writes carries mid_turn: 0 with the same turns', async (t) => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  // Released even when an assertion below fails; otherwise the live fake worker's stdio keeps this
  // process's event loop alive and the runner never exits (wait.test.cjs's own adopted-worker test).
  t.after(() => m.shutdown());

  const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hello', worker_id: 'w1' });
  assert.equal(row.mid_turn, 1, 'the running row at ready must carry mid_turn: 1');
  assert.equal(row.turns, 0);

  await m._waitTurn('w1', 8000);
  const after = core.currentWorker('w1');
  assert.equal(after.state, 'running');
  assert.equal(after.mid_turn, 0, "onTurnEnd's row must carry mid_turn: 0");
  assert.equal(after.turns, 1);
});

test('message writes, before it returns, a running row with mid_turn: 1 and turns unchanged; the next turn end writes mid_turn: 0 one turn higher', async (t) => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  t.after(() => m.shutdown());

  await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hello', worker_id: 'w2' });
  await m._waitTurn('w2', 8000);
  const turnsBefore = core.currentWorker('w2').turns;
  assert.equal(turnsBefore, 1);

  await m.message({ worker_id: 'w2', text: 'again' });
  const midTurnRow = core.currentWorker('w2');
  assert.equal(midTurnRow.mid_turn, 1, 'message must write a running row with mid_turn: 1 before it returns');
  assert.equal(midTurnRow.turns, turnsBefore, 'turns must be unchanged at the message write');
  assert.equal(midTurnRow.state, 'running');

  await m._waitTurn('w2', 8000);
  const afterTurn = core.currentWorker('w2');
  assert.equal(afterTurn.mid_turn, 0, 'the next turn end must write mid_turn: 0');
  assert.equal(afterTurn.turns, turnsBefore + 1);
});

test('a worker killed by exact pid settles to a dead row whose death_established_by matches exit-event or pid-poll', async (t) => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  t.after(() => m.shutdown());

  const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hello', worker_id: 'w3' });
  await m._waitTurn('w3', 8000);

  require('../crash.cjs').crash(m._worker('w3').child);
  await m._waitExit('w3', 8000);
  await m._worker('w3').queue; // settle() queues its row write; wait for it to land before reading it back
  const dead = core.currentWorker('w3');
  assert.equal(dead.state, 'dead');
  assert.match(dead.death_established_by, /exit-event|pid-poll/);
});

test('src/run/manager.cjs is 536 lines or fewer', () => {
  const p = path.join(__dirname, '..', '..', 'src', 'run', 'manager.cjs');
  const content = fs.readFileSync(p, 'utf8');
  const count = (content.match(/\r\n|\r|\n/g) || []).length; // wc -l counts newlines, not lines
  assert.ok(count <= 536, `manager.cjs is ${count} lines, over the 536 budget`);
});
