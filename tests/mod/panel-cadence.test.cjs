'use strict';
// The panel's refresh cadence and the reading of `belay panel-read`'s one document, tested in npm test and CI by type stripping (the plugin's
// own tests in src/mod/tests run only in Claude Code's plugin harness). Pure functions of fetch.ts: no host, no clock, no process.
const test = require('node:test');
const assert = require('node:assert');
const { loadPanelModule } = require('./load-ts.cjs');

let F;
test.before(async () => { F = await loadPanelModule('fetch'); });

test('the wait before the next refresh: 5 s with the pane open, 10 s for the band, 60 s once the run has ended or died', () => {
  assert.strictEqual(F.PANE_EVERY_MS, 5000);
  assert.strictEqual(F.BAND_EVERY_MS, 10000);
  assert.strictEqual(F.ENDED_EVERY_MS, 60000);
  for (const [open, state, want] of [
    [false, 'running', 10000], [true, 'running', 5000],
    [false, 'paused', 10000], [true, 'paused', 5000],
    [false, null, 10000], [true, null, 5000], [false, undefined, 10000], // no state yet, or a failed read: the ordinary cadence
    [false, 'ended', 60000], [true, 'ended', 60000],
    [false, 'dead', 60000], [true, 'dead', 60000],
  ]) assert.strictEqual(F.refreshEvery(open, state), want, `open=${open} state=${state}`);
});

test('roundParts: each part of the document becomes the Ran the snapshot builder takes, and an unread part stays null', () => {
  const doc = { v: 1, at: 5, run_id: 'r-1', parts: { agents: { json: { run_id: 'r-1' } }, notices: { json: { events: [] } }, awaiting: null, transcript: { error: 'belay transcript r-1 exit 1' }, settings: null } };
  const { parts, slow } = F.roundParts({ json: doc });
  assert.deepStrictEqual(parts.agents, { json: { run_id: 'r-1' } });
  assert.deepStrictEqual(parts.notices, { json: { events: [] } });
  assert.strictEqual(parts.awaiting, null);
  assert.deepStrictEqual(parts.transcript, { error: 'belay transcript r-1 exit 1' });
  assert.strictEqual(parts.settings, null);
  assert.strictEqual(slow, false);
});

test('roundParts: a part that timed out marks the round slow and keeps its flag; so does a timeout of the whole process', () => {
  const t = F.roundParts({ json: { parts: { agents: { json: {} }, notices: { error: 'belay notices timed out', timedOut: true }, awaiting: null, transcript: null, settings: null } } });
  assert.strictEqual(t.slow, true);
  assert.deepStrictEqual(t.parts.notices, { error: 'belay notices timed out', timedOut: true });
  const whole = F.roundParts({ error: 'belay panel-read r-1 timed out (25 s)', timedOut: true });
  assert.strictEqual(whole.slow, true);
  assert.deepStrictEqual(whole.parts.agents, { error: 'belay panel-read r-1 timed out (25 s)', timedOut: true });
  assert.strictEqual(whole.parts.notices, null);
});

test('roundParts: a process that failed whole, or a document the panel cannot read, is an agents error and never a crash', () => {
  const exit2 = F.roundParts({ error: 'belay panel-read exit 2' }); // an older belay without the verb
  assert.deepStrictEqual(exit2.parts.agents, { error: 'belay panel-read exit 2' });
  assert.strictEqual(exit2.slow, false);
  for (const bad of [{ json: null }, { json: 'x' }, { json: {} }, { json: { parts: 3 } }]) {
    const r = F.roundParts(bad);
    assert.match(r.parts.agents.error, /panel-read/, JSON.stringify(bad));
    assert.strictEqual(r.slow, false);
  }
  const odd = F.roundParts({ json: { parts: { agents: 7, notices: {} } } });
  assert.match(odd.parts.agents.error, /not an object/);
  assert.match(odd.parts.notices.error, /neither json nor error/);
});

test('a failing part keeps the previous value for that part and is reported, while the others are new', () => {
  const watch = { runId: 'r-1', dataDir: 'C:/d', cli: null, node: null, orchDir: null, fixed: false, error: null };
  const ev = { kind: 'permission_pending', ts: 1000, run_id: 'r-1', worker_id: 'coder-2', request_id: 'p-1', tool: 'Bash', age_ms: 5 };
  const agents = { run_id: 'r-1', mode: 'interactive', agents: [{ id: 'orchestrator', role: 'orchestrator', state: 'alive', display_state: 'running' }], footer: null };
  const good = F.buildSnapshot({ watch, prev: null, now: 100, agents: { json: agents }, notices: { json: { run_id: 'r-1', events: [ev] } }, transcript: null, settings: null });
  assert.ok(good.notices.length > 0, 'the first round has a notice to keep');
  const next = F.roundParts({ json: { parts: { agents: { json: agents }, notices: { error: 'belay notices r-1 exit 1' }, awaiting: null, transcript: null, settings: null } } });
  const snap = F.buildSnapshot({ watch, prev: good, now: 200, ...next.parts });
  assert.deepStrictEqual(snap.notices, good.notices, 'the notices read failed, so the earlier notices stand');
  assert.strictEqual(snap.fetchedAt, 200, 'the agents read landed, so it is dated now');
  assert.deepStrictEqual(snap.readIssues.map((i) => [i.verb, i.timedOut]), [['notices', false]]);
  assert.strictEqual(snap.goodAt, good.goodAt, 'a round with a failed part is not "all fresh"');
});
