'use strict';
// The panel's memory line (notes held for the archive reviewer), tested in npm test and CI. The plugin's own tests
// (src/mod/tests/*.test.ts) run only in Claude Code's plugin harness; these load the same pure model by type stripping.
const test = require('node:test');
const assert = require('node:assert');
const { loadPanelModule } = require('./load-ts.cjs');

let M;
test.before(async () => { M = { ...(await loadPanelModule('model')), ...(await loadPanelModule('held')) }; });

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
  assert.ok(M.reviewLine(r('interrupted')).includes('cut off'));
  assert.strictEqual(M.reviewLine({ ...r('ok'), text: 'kept 3' }), 'archive review of acme ended ok · kept 3');
  assert.strictEqual(M.reviewLine({ ...r('failed'), text: 'E_ARGS' }), 'archive review of acme FAILED · E_ARGS');
});

test('reviewOutcome and reviewLine put a finished review in words, never raw JSON', () => {
  const r = { project: 'smoke', state: 'ok', pid: null, ts: 1, job: 'archreview-run-abc-lx3k9q2m' };
  const t = 'ran as archreview-run-abc-lx3k9q2m: {"verdicts":1,"applied":1,"refused":0,"undecided":0,"refused_stale":0}';
  assert.strictEqual(M.reviewOutcome(t), '1 verdict: 1 applied');
  assert.strictEqual(M.reviewLine({ ...r, text: t }), 'archive review of smoke done · 1 verdict: 1 applied · job …lx3k9q2m');
  assert.strictEqual(M.reviewOutcome('ran as j: {"verdicts":5,"applied":2,"refused":1,"undecided":1,"refused_stale":1}'), '5 verdicts: 2 applied, 1 refused, 1 undecided, 1 stale');
  assert.strictEqual(M.reviewOutcome('ran as j: {"verdicts":0}'), '0 verdicts');
assert.strictEqual(M.reviewOutcome('ran as j: {"verdicts":3,"applied":2,"refused":1,"undecided":0,"refused_stale":0}'), '3 verdicts: 2 applied, 1 refused');
  for (const x of [null, 'kept 3', 'ran as j: {nope}', 'nothing to do (x)']) assert.strictEqual(M.reviewOutcome(x), null, String(x));
  assert.strictEqual(M.reviewLine({ ...r, text: 'kept 3' }), 'archive review of smoke ended ok · kept 3');
});

test('a review notice shows a short id once, the verdict and the reviewer', () => {
  const id = 'ea6e2a67-1111-4222-8333-444455556666';
  const [n] = M.normNotices({ events: [{ kind: 'review_verdict', ts: 1, task_id: id, verdict: 'holds', judged_by: 'note-reviewer' }] });
  assert.strictEqual(n.text, 'review holds · note-reviewer');
  assert.strictEqual(n.ids, 'ea6e2a67');
  assert.ok(!n.text.includes(id) && !n.ids.includes(id));
  assert.strictEqual(n.taskId, id, 'the full id stays on the row for matching');
});

test('parseMemoryNotice and buildSnapshot: the no-project notice rides the settings read, survives a failed read and goes when belay stops reporting it', async () => {
  const F = await loadPanelModule('fetch');
  const notice = { title: 'Memory is off for this project', why: 'Notes are per project.', fix: 'Add "memory": { "project": "<name>" } to belay.config.json.', config_line: '"memory": { "project": "<name>" }', short: 'set one: belay settings memory.project <name>' };
  assert.deepStrictEqual(M.parseMemoryNotice({ memory_notice: notice }), { title: notice.title, why: notice.why, fix: notice.fix, configLine: notice.config_line, short: notice.short });
  for (const j of [null, {}, { memory_notice: null }, { memory_notice: { title: 'x' } }, { memory_notice: 'x' }]) assert.strictEqual(M.parseMemoryNotice(j), null, JSON.stringify(j));
  const parts = (settings, prev) => ({ watch: { runId: null, dataDir: null, cli: null, fixed: false }, prev, now: 1, agents: { json: { agents: [] } }, notices: null, transcript: null, settings });
  const on = F.buildSnapshot(parts({ json: { memory_notice: notice, settings: [] } }, null));
  assert.strictEqual(on.memoryNotice.title, notice.title);
  assert.strictEqual(F.buildSnapshot(parts({ error: 'belay settings exit 3' }, on)).memoryNotice.title, notice.title, 'a failed read keeps the earlier notice');
  assert.strictEqual(F.buildSnapshot(parts({ json: { memory_notice: null, settings: [] } }, on)).memoryNotice, null, 'a project set clears it');
  assert.strictEqual(F.buildSnapshot(parts(null, null)).memoryNotice, null);
  // A run the agents read names answers for itself: its own notice, or none, whatever the config says now.
  const runNotice = { ...notice, title: 'Memory notes are off: redaction is disabled' };
  const live = (memory_notice) => ({ ...parts({ json: { memory_notice: notice, settings: [] } }, null), agents: { json: { agents: [], run_id: 'r1', memory_notice } } });
  assert.strictEqual(F.buildSnapshot(live(null)).memoryNotice, null, 'the run has none (notes on, explicitly off, or memory null): the config notice is dropped');
  assert.strictEqual(F.buildSnapshot(live(runNotice)).memoryNotice.title, runNotice.title, 'its own notice, not the config notice');
  assert.strictEqual(F.buildSnapshot({ ...live(runNotice), settings: { json: { memory_notice: null, settings: [] } } }).memoryNotice.title, runNotice.title, 'a config that gained a project does not clear a run launched without one');
  assert.strictEqual(F.buildSnapshot({ ...live(runNotice), settings: { error: 'belay settings exit 3' } }).memoryNotice.title, runNotice.title, 'nor does a failed settings read');
  assert.strictEqual(F.buildSnapshot({ ...parts({ json: { memory_notice: notice, settings: [] } }, null), agents: { json: { agents: [], run_id: null } } }).memoryNotice.title, notice.title, 'no run selected: the config notice');
  // A failed agents read keeps the selected run's cached notice (null included); the config notice is for a panel with no run.
  const failedAgents = (prevSnap, settings, watchRunId = null) => ({ ...parts(settings, prevSnap), watch: { runId: watchRunId, dataDir: null, cli: null, fixed: false }, agents: { error: 'belay agents exit 3' } });
  const cfg = { json: { memory_notice: notice, settings: [] } };
  const cfgOk = { json: { memory_notice: null, settings: [] } };
  const silent = F.buildSnapshot(live(null));
  const redacted = F.buildSnapshot(live(runNotice));
  assert.strictEqual(silent.runId, 'r1');
  assert.strictEqual(F.buildSnapshot(failedAgents(silent, cfg)).memoryNotice, null, 'a silent run gains no no-project warning from the config');
  assert.strictEqual(F.buildSnapshot(failedAgents(redacted, cfg)).memoryNotice.title, runNotice.title, 'a redaction-disabled run keeps its own warning');
  assert.strictEqual(F.buildSnapshot(failedAgents(redacted, cfgOk)).memoryNotice.title, runNotice.title, 'a config that gained a project does not clear it');
  const noProj = F.buildSnapshot({ ...live(notice), settings: cfg });
  assert.strictEqual(F.buildSnapshot(failedAgents(noProj, cfgOk)).memoryNotice.title, notice.title, 'a no-project run keeps its warning after the config gains a project');
  assert.strictEqual(F.buildSnapshot(failedAgents(null, cfg, 'r1')).memoryNotice, null, 'a run named by the watch with nothing cached: not the config notice');
  assert.strictEqual(F.buildSnapshot(failedAgents(on, cfg)).memoryNotice.title, notice.title, 'no run selected: the config notice');
  // the band's warning line and the plain surfaces' line are built here, so a removed or reworded line fails
  const p = M.parseMemoryNotice({ memory_notice: notice });
  assert.strictEqual(M.memoryTitleSegs(p).map((s) => s.t).join(''), '▲ Memory is off for this project');
  assert.strictEqual(p.short, 'set one: belay settings memory.project <name>');
  assert.deepStrictEqual(M.memoryFallbackSegs(p), [{ t: `▲ ${notice.title}. ${p.short}`, c: 'warning' }]);
});

test('the held count is one count broken down by ground, with how many await the operator', () => {
  const g = M.normHeld({ events: [held(3, { acme: 3 }, { by_ground: { reported: 2, same_claim: 1 }, awaiting_operator: 1 })] });
  assert.deepStrictEqual([g.byGround, g.awaiting], [{ reported: 2, same_claim: 1 }, 1]);
  assert.strictEqual(M.heldLine(g), '3 held: 2 reported wrong, 1 duplicate; 1 awaits you');
  assert.strictEqual(M.heldLine(H({ count: 4, byGround: { reported: 2, report_confirmed: 1, unsupported: 1 }, awaiting: 2 })), '4 held: 3 reported wrong, 1 unsupported; 2 await you');
  assert.strictEqual(M.heldLine(H({ count: 1, byGround: { reported: 1 }, awaiting: 0 })), '1 held: 1 reported wrong');
  assert.strictEqual(M.normHeld({ events: [held(2, { acme: 2 })] }).byGround, undefined, 'without a breakdown the line is as before');
});

test('normAwaiting: only entries that await the operator, capped, cleaned', () => {
  const e = (id, aw, extra = {}) => ({ note_id: id, project: 'acme', title: 'a\nb', awaiting_operator: aw, undecided: { reason: 'cannot say' }, ...extra });
  const out = M.normAwaiting({ entries: [e('n1', true), e('n2', false), e('n3', true), e('n4', true), e('n5', true), e('n6', true), e('n7', true), { awaiting_operator: true }, null] });
  assert.deepStrictEqual(out.map((n) => n.id), ['n1', 'n3', 'n4', 'n5', 'n6']);
  assert.deepStrictEqual(out[0], { id: 'n1', project: 'acme', title: 'a b', reason: 'cannot say' });
  assert.deepStrictEqual(M.normAwaiting(null), []);
});

test('settleArgs keeps the reason one element, whatever it holds; settleLine shows the proof or the error', () => {
  for (const reason of ['two words', '-x', '--archive', 'it\'s "q"', '']) {
    assert.deepStrictEqual(M.settleArgs('reoffer', 'n1', reason), ['memory', 'held', 'settle', 'n1', '--reoffer', '--reason', reason, '--if-awaiting']);
  }
  const ok = JSON.stringify({ id: 'abcdef0123456789', action: 'archive', outcome: 'archived', receipt: 'held-settle:x@1' });
  assert.strictEqual(M.settleLine(0, ok, ''), 'belay: archive abcdef01: archived · receipt held-settle:x@1');
  assert.strictEqual(M.settleLine(1, JSON.stringify({ error: { code: 'E_STALE', message: 'moved' } }), ''), 'belay: the note was not settled (exit 1): E_STALE: moved');
  assert.match(M.settleLine(2, '', 'boom'), /outcome unknown/);
  assert.match(M.settleLine(0, 'not json', ''), /outcome unknown/);
});

test('settleLine: stdout receipt, stderr pretty error, and an unknown outcome for anything that may have committed', () => {
  const pretty = (o) => JSON.stringify(o, null, 2);
  const nf = pretty({ error: { code: 'E_NOT_FOUND', message: 'note x has no active hold', detail: { id: 'x' } } });
  assert.strictEqual(M.settleLine(1, '', nf), 'belay: the note was not settled (exit 1): E_NOT_FOUND: note x has no active hold');
  const unknown = 'belay: outcome unknown: re-read with belay memory held';
  assert.strictEqual(M.settleLine(1, '', pretty({ error: { code: 'E_TIMEOUT', message: 'm' } })), `${unknown} (E_TIMEOUT)`);
  assert.strictEqual(M.settleLine(1, '', pretty({ error: { code: 'E_OWNER_LOST', message: 'm', detail: { sent: true } } })), `${unknown} (E_OWNER_LOST)`);
  assert.strictEqual(M.settleLine(1, '', pretty({ error: { code: 'E_OTHER', message: 'm', detail: { may_have_committed: true } } })), `${unknown} (E_OTHER)`);
  assert.strictEqual(M.settleLine(1, '', 'boom'), `${unknown} (exit 1)`, 'output that is not a refusal is not a definite refusal');
  assert.strictEqual(M.settleLine(0, 'x', ''), `${unknown} (exit 0)`);
});

test('reasonProblem: over 160 characters, or exactly a global option, is refused; anything else is not', () => {
  assert.strictEqual(M.reasonProblem('x'.repeat(160)), null);
  assert.match(M.reasonProblem('x'.repeat(161)), /161 characters; at most 160/);
  for (const f of ['--json', '--fix', '--data', '--help', '-h', '--']) assert.match(M.reasonProblem(f), /cannot be exactly/);
  for (const ok of ['--json x', '-x', '--reason', 'json', '-h!']) assert.strictEqual(M.reasonProblem(ok), null, ok);
});

test('launcherLine reads the error the real CLI prints to stderr', async () => {
  const F = await loadPanelModule('fetch');
  const err = JSON.stringify({ error: { code: 'E_BUSY', message: 'a review is running', detail: {} } }, null, 2);
  assert.strictEqual(F.launcherLine(1, '', err, 'acme'), 'belay: the review was not started (exit 1): E_BUSY: a review is running');
  assert.strictEqual(F.launcherLine(1, '', 'plain words' + String.fromCharCode(10) + 'more', 'acme'), 'belay: the review was not started (exit 1): plain words');
});

test('a usage error ({"error": "<text>"}, exit 2) is a definite refusal with its message, in the settle and the launcher toasts', async () => {
  const usage = JSON.stringify({ error: 'belay memory held settle needs exactly one of --archive, --release or --reoffer' });
  assert.strictEqual(M.settleLine(2, '', usage), 'belay: the note was not settled (exit 2): belay memory held settle needs exactly one of --archive, --release or --reoffer');
  const F = await loadPanelModule('fetch');
  assert.strictEqual(F.launcherLine(2, '', JSON.stringify({ error: 'belay memory: bad flag' }, null, 2), 'acme'), 'belay: the review was not started (exit 2): belay memory: bad flag');
});

test('tokensShort never renders 1000.0k', () => {
  assert.strictEqual(M.tokensShort(18247), '18.2k');
  assert.strictEqual(M.tokensShort(999949), '999.9k');
  assert.strictEqual(M.tokensShort(999950), '1.0M');
  assert.strictEqual(M.tokensShort(999999), '1.0M');
  assert.strictEqual(M.tokensShort(1234567), '1.2M');
  assert.strictEqual(M.tokensShort(847), '847');
});

test('pruneSettled drops only resolved entries, oldest first, and never the newest', () => {
  const m = {};
  for (let i = 0; i < 22; i += 1) m['n' + i] = i === 0 ? { label: 'u', at: 1, unknown: true } : i === 1 ? { label: 'p', at: 1, pending: true } : { label: 'ok', at: i };
  const out = M.pruneSettled(m, 'n21');
  assert.strictEqual(Object.keys(out).length, 20);
  assert.ok(out.n0 && out.n1, 'an unknown and a pending entry are kept');
  assert.ok(out.n21, 'the newest is kept');
  assert.ok(!out.n2 && !out.n3, 'the oldest resolved ones went');
  const all = {};
  for (let i = 0; i < 25; i += 1) all['u' + i] = { label: 'u', at: i, unknown: true };
  assert.strictEqual(Object.keys(M.pruneSettled(all, 'u24')).length, 25, 'nothing unresolved is ever dropped');
});

test('ctxSegs: tokens always, the percent when the window is known, a percent never alone when tokens are known', () => {
  const S = { context: 'figure' };
  const text = (a, s = S, m) => M.ctxSegs(a, s, m).map((x) => x.t).join('');
  assert.strictEqual(text({ ctxTokens: 18247, ctxPct: null }), '18.2k');
  assert.strictEqual(text({ ctxTokens: 18247, ctxPct: 2 }), '18.2k · 2%');
  assert.strictEqual(text({ ctxTokens: 610000, ctxPct: 60.6 }), '610.0k · 61%');
  assert.strictEqual(text({ ctxTokens: 18247, ctxPct: 2 }, S, 'tokens'), '18.2k');
  assert.strictEqual(text({ ctxTokens: null, ctxPct: 38 }), '38%');
  assert.strictEqual(text({ ctxTokens: null, ctxPct: null }), '—');
  assert.strictEqual(text({ ctxTokens: 18247, ctxPct: 2 }, { context: 'both' }, 'mid'), '18.2k · 2%');
  assert.ok(text({ ctxTokens: 18247, ctxPct: 50 }, { context: 'both' }).startsWith('▰▰▰▱▱▱ 18.2k · 50%'));
});

test('a dead review worker is not live; a dead coder is', () => {
  assert.strictEqual(M.isLive({ id: 'archreview-r-1-abc', state: 'dead' }), false);
  assert.strictEqual(M.isLive({ id: 'coder-1', state: 'dead' }), true);
  assert.strictEqual(M.isLive({ id: 'archreview-r-1-abc', state: 'running' }), true);
  assert.strictEqual(M.isLive({ id: 'coder-1', state: 'done' }), false);
});
