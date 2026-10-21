'use strict';
// The panel's memory line (notes held for the archive reviewer), tested in npm test and CI. The plugin's own tests
// (src/mod/tests/*.test.ts) run only in Claude Code's plugin harness; these load the same pure model by type stripping.
const test = require('node:test');
const assert = require('node:assert');
const { loadPanelModule } = require('./load-ts.cjs');

let M;
test.before(async () => { M = await loadPanelModule('model'); });

const held = (count, byProject, extra = {}) => ({ kind: 'notes_held', count, by_project: byProject, oldest_age_runs: 2, unsupported: 0, ...extra });
const H = (o = {}) => ({ count: 3, unsupported: 0, byProject: { acme: 3 }, oldestAgeRuns: 2, reviews: [], ...o });

test('normHeld: the count, the unsupported share (never above the count), the oldest wait and the projects', () => {
  const h = M.normHeld({ events: [held(3, { acme: 2, zed: 1 }, { unsupported: 9, oldest_age_runs: 4 })] });
  assert.deepStrictEqual(h, { count: 3, unsupported: 3, byProject: { acme: 2, zed: 1 }, oldestAgeRuns: 4, reviews: [] });
  // an empty project name and a non-numeric count are dropped, not invented
  const g = M.normHeld({ events: [held(2, { '': 1, ok: 2, bad: 'x' })] });
  assert.deepStrictEqual(g.byProject, { ok: 2 });
});

test('normHeld: nothing held and no review is null, for any shape of input', () => {
  for (const j of [null, undefined, 3, {}, { events: [] }, { events: 'x' }, { events: [held(0, {})] }, { events: [null, 7, { kind: 'other' }] }]) {
    assert.strictEqual(M.normHeld(j), null, JSON.stringify(j));
  }
});

test('normHeld: a review claim reads as running, interrupted, ok or failed, and keeps the memory line when no note is held', () => {
  const ev = (kind, o) => ({ kind, project: 'acme', pid: 77, ...o });
  const one = (e) => M.normHeld({ events: [e] }).reviews[0].state;
  assert.strictEqual(one(ev('review_running', { pid_alive: true })), 'running');
  assert.strictEqual(one(ev('review_running', { pid_alive: false })), 'interrupted');
  assert.strictEqual(one(ev('review_running', {})), 'interrupted', 'a pid that is not proved alive is not shown running');
  assert.strictEqual(one(ev('review_ended', { ok: true, text: 'done' })), 'ok');
  assert.strictEqual(one(ev('review_ended', { ok: false, code: 'E_ARGS' })), 'failed');
  assert.strictEqual(M.normHeld({ events: [ev('review_ended', { ok: false, code: 'E_ARGS' })] }).reviews[0].text, 'E_ARGS');
  assert.strictEqual(M.normHeld({ events: [{ kind: 'review_running', pid_alive: true }] }), null, 'a claim with no project is dropped');
});

test('heldLine: singular and plural, the unsupported split, the project list, and empty when nothing is held', () => {
  assert.strictEqual(M.heldLine(H()), '3 notes held for review · oldest 2 runs · acme');
  assert.strictEqual(M.heldLine(H({ count: 1, oldestAgeRuns: 1, byProject: {} })), '1 note held for review · oldest 1 run');
  assert.strictEqual(M.heldLine(H({ count: 8, unsupported: 3, byProject: { zed: 5, acme: 3 } })), '5 held as wrong or duplicate · 3 unsupported awaiting review · oldest 2 runs · acme, zed');
  assert.strictEqual(M.heldLine(H({ unsupported: 3 })), '3 unsupported awaiting review · oldest 2 runs · acme');
  assert.strictEqual(M.heldLine(H({ count: 0 })), '');
});

test('reviewProject: the project with the most held notes, ties by name, null when belay named none', () => {
  assert.strictEqual(M.reviewProject(H({ count: 6, byProject: { b: 2, a: 1, c: 3 } })), 'c');
  assert.strictEqual(M.reviewProject(H({ count: 4, byProject: { b: 2, a: 2 } })), 'a');
  assert.strictEqual(M.reviewProject(H({ byProject: {} })), null);
  assert.strictEqual(M.reviewProject(H({ count: 0 })), null);
  assert.strictEqual(M.reviewProject(null), null);
});

test('confirmLine: the count held in that project, the question, and the cost wording while no estimate exists', () => {
  assert.strictEqual(M.REVIEW_COST_ESTIMATE_USD, null);
  assert.strictEqual(M.confirmLine(H({ count: 5, byProject: { acme: 1, zed: 4 } }), 'zed'), '4 notes held in zed · dispatch the Opus archive reviewer? cost: measured after first run');
  assert.strictEqual(M.confirmLine(H({ count: 5, byProject: { acme: 1 } }), 'acme'), '1 note held in acme · dispatch the Opus archive reviewer? cost: measured after first run');
  assert.strictEqual(M.confirmLine(H({ count: 2, byProject: {} }), 'x'), '2 notes held in x · dispatch the Opus archive reviewer? cost: measured after first run', 'a project belay did not count falls back to the total');
});

test('runningReview and reviewLine: only a live review blocks the button; an old claim says it is a pid check', () => {
  const r = (state, project = 'acme') => ({ project, state, pid: 77, text: null, ts: 1000 });
  const h = H({ reviews: [r('interrupted'), r('running', 'acme')] });
  assert.strictEqual(M.runningReview(h, 'acme').state, 'running');
  assert.strictEqual(M.runningReview(h, 'other'), null);
  assert.strictEqual(M.runningReview(h, null).project, 'acme');
  assert.strictEqual(M.runningReview(H({ reviews: [r('ok'), r('failed')] }), null), null);
  assert.strictEqual(M.reviewLine(r('running')), 'archive review of acme running · pid 77');
  assert.ok(M.reviewLine(r('running'), 1000 + M.STALE_CLAIM_MS + 1).includes('may be stale'));
  assert.ok(!M.reviewLine(r('running'), 1000 + M.STALE_CLAIM_MS).includes('may be stale'));
  assert.ok(M.reviewLine(r('interrupted')).includes('INTERRUPTED'));
  assert.strictEqual(M.reviewLine({ ...r('ok'), text: 'kept 3' }), 'archive review of acme ended ok · kept 3');
  assert.strictEqual(M.reviewLine({ ...r('failed'), text: 'E_ARGS' }), 'archive review of acme FAILED · E_ARGS');
});

test('parseMemoryNotice and buildSnapshot: the no-project notice rides the settings read, survives a failed read and goes when belay stops reporting it', async () => {
  const F = await loadPanelModule('fetch');
  const notice = { title: 'Memory is off for this project', why: 'Notes are per project.', fix: 'Add "memory": { "project": "<name>" } to belay.config.json.', config_line: '"memory": { "project": "<name>" }' };
  assert.deepStrictEqual(M.parseMemoryNotice({ memory_notice: notice }), { title: notice.title, why: notice.why, fix: notice.fix, configLine: notice.config_line });
  for (const j of [null, {}, { memory_notice: null }, { memory_notice: { title: 'x' } }, { memory_notice: 'x' }]) assert.strictEqual(M.parseMemoryNotice(j), null, JSON.stringify(j));
  const parts = (settings, prev) => ({ watch: { runId: null, dataDir: null, cli: null, fixed: false }, prev, now: 1, agents: { json: { agents: [] } }, notices: null, transcript: null, settings });
  const on = F.buildSnapshot(parts({ json: { memory_notice: notice, settings: [] } }, null));
  assert.strictEqual(on.memoryNotice.title, notice.title);
  assert.strictEqual(F.buildSnapshot(parts({ error: 'belay settings exit 3' }, on)).memoryNotice.title, notice.title, 'a failed read keeps the earlier notice');
  assert.strictEqual(F.buildSnapshot(parts({ json: { memory_notice: null, settings: [] } }, on)).memoryNotice, null, 'a project set clears it');
  assert.strictEqual(F.buildSnapshot(parts(null, null)).memoryNotice, null);
  const live = { ...parts({ json: { memory_notice: notice, settings: [] } }, null), agents: { json: { agents: [], memory_notes: true } } };
  assert.strictEqual(F.buildSnapshot(live).memoryNotice, null, 'the live run has notes on (its spec set the project): the config notice is dropped');
  assert.strictEqual(F.buildSnapshot({ ...live, agents: { json: { agents: [], memory_notes: false } } }).memoryNotice.title, notice.title);
  // the band's warning line and the plain surfaces' line are built here, so a removed or reworded line fails
  const p = M.parseMemoryNotice({ memory_notice: notice });
  assert.deepStrictEqual(M.memoryBandSegs(p).map((s) => s.t).join(''), '▲ Memory is off for this project · add "memory": { "project": "<name>" }');
  assert.deepStrictEqual(M.memoryFallbackSegs(p), [{ t: `▲ ${notice.title}. ${notice.fix}`, c: 'warning' }]);
});
