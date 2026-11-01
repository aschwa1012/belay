'use strict';
// `belay stop` must not print "killed" for a worker whose kill was refused or whose pid is still alive
// after the kill (no success without effect). A pure test of the receipt -> text/exit decision: the
// receipt shapes are the ones src/run/stop.cjs's killWorkerRow and tree-kill attribution produce.
const { test } = require('node:test');
const assert = require('node:assert');
const { renderText, failedKills } = require('../../src/cli/cmd-stop.cjs');

const orchestrator = { pid: 100, exit_code: 0, exit_signal: null, ms_to_exit: 5, graceful: true };
const receipt = (workers) => ({ stopped: true, orchestrator, workers, left_parked: [] });
const row = (id, pid, killed, pid_alive = true) => ({ id, pid, state: 'running', pid_alive, killed });

test('a refused kill with the pid still alive is named, shows the pid, and is a failure', () => {
  const r = receipt([row('w-1', 4242, {
    tree: { ok: false, terminated: 0, ms: 1 }, pid: { signalled: false, error: 'EIDENTITY' }, identity: null,
    refused: 'identity', kind: 'unverifiable', detail: 'no creation time recorded', manual: 'end pid 4242 by hand',
    pid_alive_after: true, ms: 2,
  })]);
  const failed = failedKills(r);
  assert.strictEqual(failed.length, 1);
  assert.strictEqual(failed[0].pid, 4242);
  const text = renderText(r);
  assert.match(text, /NOT killed/);
  assert.match(text, /4242/);
  assert.match(text, /kill refused \(unverifiable: no creation time recorded\)/);
  assert.doesNotMatch(text, /, killed\n/);
  assert.match(text, /end pid 4242 by hand/);
});

test('a signalled kill whose pid is still alive is a failure too', () => {
  const r = receipt([row('w-2', 77, { tree: { ok: true, terminated: 1, ms: 1 }, pid: { signalled: true }, identity: { pid: 77 }, pid_alive_after: true, ms: 3 })]);
  assert.strictEqual(failedKills(r).length, 1);
  assert.match(renderText(r), /NOT killed, pid 77 is still alive: kill sent but the process is still alive/);
});

test('a mismatch or absent refusal on a reused pid reads as already gone, not as a failed kill', () => {
  for (const kind of ['mismatch', 'absent']) {
    const r = receipt([row('w-6', 55, { tree: { ok: false, terminated: 0, ms: 1 }, pid: { signalled: false, error: 'EIDENTITY' }, identity: null, refused: 'identity', kind, detail: 'another process', pid_alive_after: true, ms: 2 })]);
    assert.strictEqual(failedKills(r).length, 0, kind);
    const text = renderText(r);
    assert.match(text, new RegExp(`already gone, pid 55 now belongs to another process \\(kill refused: ${kind}\\)`));
    assert.doesNotMatch(text, /NOT killed/);
  }
});

test('an absent refusal with the pid dead reads gone, not that another process holds the pid', () => {
  const r = receipt([row('w-8', 57, { tree: { ok: false, terminated: 0, ms: 1 }, pid: { signalled: false }, identity: null, refused: 'identity', kind: 'absent', detail: 'not in snapshot', pid_alive_after: false, ms: 2 }, false)]);
  assert.strictEqual(failedKills(r).length, 0);
  const text = renderText(r);
  assert.match(text, /gone \(kill refused\)/);
  assert.doesNotMatch(text, /belongs to another process/);
});

test('a refused kill whose pid then ended by itself reads gone, not killed', () => {
  const r = receipt([row('w-7', 56, { tree: { ok: false, terminated: 0, ms: 1 }, pid: { signalled: false }, identity: null, refused: 'identity', kind: 'unverifiable', detail: 'x', pid_alive_after: false, ms: 2 }, false)]);
  assert.strictEqual(failedKills(r).length, 0);
  assert.match(renderText(r), /gone \(kill refused\)/);
});

test('a really killed process, a tree-killed one and an already-gone one keep their wording and are not failures', () => {
  const r = receipt([
    row('w-3', 11, { tree: { ok: true, terminated: 1, ms: 1 }, pid: { signalled: true }, identity: { pid: 11 }, pid_alive_after: false, ms: 3 }, false),
    row('w-4', 12, { by: "the orchestrator's tree kill", pid: 12, created: 1 }, false),
    row('w-5', 13, null, false),
  ]);
  assert.strictEqual(failedKills(r).length, 0);
  const text = renderText(r);
  assert.match(text, /worker w-3 pid 11: running, pid alive false, killed\n/);
  assert.match(text, /worker w-4 pid 12: running, pid alive false, killed\n/);
  assert.match(text, /worker w-5 pid 13: running, pid alive false, not killed\n/);
  assert.doesNotMatch(text, /NOT killed/);
});
