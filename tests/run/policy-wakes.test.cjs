'use strict';
require('../helpers/tmp.cjs');
// policy-wakes.test.cjs — ADR 0073 decisions 1 to 4: the exceptions that wake the orchestrator under a plan. Each exception is derived from
// seeded store rows (no model), carries kind, task, trigger and plan field inside the wake byte cap, wakes once, halts the task's steps
// only while it is current, and a routine turn end or evaluation of a task under a plan is not a wake while a task with no plan wakes as before.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');

const PW = require('../../src/run/policy-wakes.cjs');
const RE = require('../../src/run/release-eval.cjs');
const { wakeRecord } = require('../../src/run/wake-record.cjs');
const { startWakePublisher } = require('../../src/run/wake-pipe.cjs');
const { runOrchestrator } = require('../../src/run/orchestrator.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const RUN = 'r1';
const B = (s) => Buffer.byteLength(s, 'utf8');
const PLAN = { review: { worker: 'rv' }, fix: 'builder', re_review: 'refuter', integrate: 'on_hold' };
const UUID = '0b6f4a9e-3c1d-4f7a-9e2b-8d5c6a7f1e30';

let nextSeq = 100;
const task = (id, over = {}) => ({ id, seq: nextSeq++, run_id: RUN, state: 'open', policy: null, depends_on: [], repairs: null, results: null, handoff: null, lease: null, review: null, integration: null, written_at: 50, ...over });
const release = (over = {}) => ({ trigger: 'release', evaluated_at: 20, executable: true, passed: true, checks: [{ kind: 'command', argv: ['npm', 'test'], passed: true }], ...over });
const handoff = (by = 'w1') => ({ by, at: 10 });
const f = (severity, title) => ({ severity, title, where: 'a.cjs:1' });
function reviewTask(id, work, verdict, findings, over = {}) {
  const passed = verdict === 'holds';
  return task(id, { state: passed ? 'done' : 'released', depends_on: [work], handoff: handoff('rv'), results: release({ passed, checks: [{ kind: 'verdict', executable: true, passed, detail: { verdict, summary: 's', findings } }] }), ...over });
}
const work = (id, over = {}) => task(id, { state: 'done', policy: PLAN, handoff: handoff(), results: release(), ...over });
const kinds = (xs) => xs.map((e) => `${e.exception}${e.field !== 'none' ? `:${e.field}` : ''}`).sort();
const snap = (tasks, extra = {}) => ({ runId: RUN, tasks, integrations: [], steps: [], failures: [], ...extra });

test('a refuted review: a plan with a fix step is routine; without one it is E1 on fix; at the fix cap it is E2 with the titles', () => {
  const rv = { state: 'refuted', review_id: 'R', rounds_left: 1, fix_rounds_used: 1, max_fix_rounds: 2 };
  const R = reviewTask('R', 'W', 'refuted', [f('blocking', 'null deref in parse'), f('should-fix', 'no test')]);
  assert.deepStrictEqual(PW.derive(snap([work('W', { review: rv }), R])), [], 'the executor takes the fix: no wake');
  const e1 = PW.derive(snap([work('W', { policy: { ...PLAN, fix: undefined }, review: rv }), R]));
  assert.deepStrictEqual(kinds(e1), ['E1:fix']);
  assert.deepStrictEqual(e1[0].trigger, { table: 'task', id: 'R', seq: R.seq });
  const e2 = PW.derive(snap([work('W', { review: { ...rv, rounds_left: 0, fix_rounds_used: 2 } }), R]));
  assert.deepStrictEqual(kinds(e2), ['E2:fix']);
  assert.match(PW.wakeOf(e2[0]).text, /Fix cap reached \(2 used of 2\).*"null deref in parse"; "no test"/);
});

test('E2 also comes from a fix step refused for the cap, on the same trigger, so it is one exception', () => {
  const rv = { state: 'refuted', review_id: 'R', rounds_left: 0, fix_rounds_used: 2, max_fix_rounds: 2 };
  const R = reviewTask('R', 'W', 'refuted', [f('blocking', 'x')]);
  const W = work('W', { review: rv });
  const step = { seq: 3, run_id: RUN, task_id: 'W', step: 'fix', trigger_table: 'task', trigger_id: 'R', trigger_seq: R.seq, outcome: 'exception', error: 'E_FIX_ROUNDS: past the hard cap', at: 60, finished_at: 61 };
  const ex = PW.derive(snap([W, R], { steps: [step] }));
  assert.deepStrictEqual(kinds(ex), ['E2:fix'], 'the rows and the refused step name one trigger: one exception');
  const one = PW.derive(snap([work('W', { review: { ...rv, rounds_left: 1 } }), R], { steps: [step] }));
  assert.deepStrictEqual(kinds(one), ['E2:fix'], 'a refused fix is E2 even when the rows alone show a round left');
});

test('a hold: should-fix findings are E7 with their titles when follow_up is absent or wake; none otherwise; no integrate step is E1', () => {
  const rv = { state: 'holds', review_id: 'R', rounds_left: 2 };
  const R = reviewTask('R', 'W', 'holds', [f('should-fix', 'tests run only in UTC'), f('should-fix', 'no empty week test'), f('note', 'rename x')]);
  const e7 = PW.derive(snap([work('W', { review: rv }), R]));
  assert.deepStrictEqual(kinds(e7), ['E7']);
  assert.strictEqual(e7[0].field, 'none');
  assert.match(PW.wakeOf(e7[0]).text, /holds with 2 should-fix. "tests run only in UTC"; "no empty week test"/);
  assert.deepStrictEqual(kinds(PW.derive(snap([work('W', { review: rv, policy: { ...PLAN, follow_up: 'wake' } }), R]))), ['E7:follow_up']);
  assert.deepStrictEqual(PW.derive(snap([work('W', { review: rv, policy: { ...PLAN, follow_up: 'digest' } }), R])), [], 'a plan that names another follow_up is not woken');
  const clean = reviewTask('R2', 'W2', 'holds', []);
  assert.deepStrictEqual(PW.derive(snap([work('W2', { review: { ...rv, review_id: 'R2' } }), clean])), []);
  assert.deepStrictEqual(kinds(PW.derive(snap([work('W2', { review: { ...rv, review_id: 'R2' }, policy: { ...PLAN, integrate: undefined } }), clean]))), ['E1:integrate']);
});

test('E1 on a done piece of work with no review step, and on a done fix with no re_review step', () => {
  assert.deepStrictEqual(kinds(PW.derive(snap([work('W', { policy: { fix: 'builder' } })]))), ['E1:review']);
  assert.deepStrictEqual(PW.derive(snap([work('W', { policy: { fix: 'builder' } }), reviewTask('R', 'W', 'holds', [])])), [], 'a review exists for it');
  const W = work('W', { policy: { ...PLAN, re_review: undefined } });
  const F = work('F', { repairs: 'W', policy: null, acted_by: 'policy' });
  assert.deepStrictEqual(kinds(PW.derive(snap([W, F]))), ['E1:re_review'], 'only the fix: W has a review step in its plan');
});

test('E5: a failed evaluation, one that could not judge, and a release evaluation that ended with no result; a clean refutation is not E5', () => {
  const failed = work('W', { state: 'released', results: release({ passed: false, checks: [{ kind: 'command', argv: ['npm', 'test'], passed: false, exit_code: 1 }] }) });
  const e = PW.derive(snap([failed]));
  assert.deepStrictEqual(kinds(e), ['E5']);
  assert.match(PW.wakeOf(e[0]).text, /evaluation failed: command npm test exit 1/);
  const blind = work('W', { state: 'released', results: release({ passed: false, executable: false, checks: [{ kind: 'verdict', executable: false, passed: false }] }) });
  assert.match(PW.wakeOf(PW.derive(snap([blind]))[0]).text, /could not judge/);
  const lost = work('W', { state: 'released', results: null });
  const ev = { id: 'ev1', seq: 7, kind: 'release_failed', task_id: 'W', code: 'E_BUSY', written_at: 30 };
  const q = PW.derive(snap([lost], { failures: [ev, { ...ev, id: 'ev2', seq: 8, code: 'E_CANCELLED' }] }));
  assert.deepStrictEqual(kinds(q), ['E5']);
  assert.strictEqual(q[0].seq, 7);
  assert.match(PW.wakeOf(q[0]).text, /E_BUSY/);
  const refuted = reviewTask('R', 'W', 'refuted', [f('blocking', 'x')]);
  assert.ok(!PW.derive(snap([work('W', { review: { state: 'refuted', review_id: 'R', rounds_left: 1 } }), refuted])).some((x) => x.exception === 'E5'));
  assert.deepStrictEqual(PW.derive(snap([work('W2', { state: 'released', results: release({ passed: false, trigger: 'task_evaluate' }) })])), [], "the orchestrator's own evaluation is not a wake");
});

test('E6: a flaky pass, and a failing check that ran beside other evaluations (which is E6, not also E5)', () => {
  const flaky = PW.derive(snap([work('W', { results: release({ flaky: true }), policy: PLAN, review: null }), reviewTask('R', 'W', 'holds', [])]));
  assert.deepStrictEqual(kinds(flaky), ['E6']);
  assert.match(PW.wakeOf(flaky[0]).text, /passed on a retry \(flaky\)/);
  const beside = work('W', { state: 'released', results: release({ passed: false, checks: [{ kind: 'command', argv: ['npm', 'test'], passed: false, exit_code: 1, concurrent: ['a', 'b'] }] }) });
  const e = PW.derive(snap([beside]));
  assert.deepStrictEqual(kinds(e), ['E6']);
  assert.match(PW.wakeOf(e[0]).text, /failed beside other evaluations: command npm test exit 1 \(with 2\)/);
});

test('E3: a conflict at a policy integrate; an orchestrator integrate, or one a newer row supersedes, is not', () => {
  const W = work('W');
  const row = (over) => ({ id: 'i1', seq: 4, run_id: RUN, state: 'conflict', acted_by: 'policy', task_ids: ['W'], conflict: { task_id: 'W', files: ['a', 'b'] }, ...over });
  const e = PW.derive(snap([W], { integrations: [row()] }));
  assert.deepStrictEqual(kinds(e), ['E3:integrate']);
  assert.deepStrictEqual(e[0].trigger, { table: 'integration', id: 'i1', seq: 4 });
  assert.match(PW.wakeOf(e[0]).text, /Integrate conflict on task W \(2 files\)/);
  assert.deepStrictEqual(PW.derive(snap([W], { integrations: [row({ acted_by: null })] })), []);
  assert.deepStrictEqual(PW.derive(snap([W], { integrations: [row(), row({ id: 'i2', seq: 9, state: 'merged', acted_by: null })] })), []);
});

test('E8: a policy step that finished as an exception; lifted once the task has a newer row', () => {
  const step = { seq: 3, run_id: RUN, task_id: 'W', step: 're_review', trigger_table: 'task', trigger_id: 'F', trigger_seq: 12, outcome: 'exception', error: 'the named refuter is dead', at: 60, finished_at: 61 };
  const e = PW.derive(snap([work('W', { written_at: 40 })], { steps: [step, { ...step, seq: 4, step: 'fix', outcome: 'done' }, { ...step, seq: 5, step: 'integrate', outcome: 'skipped' }] }));
  assert.deepStrictEqual(kinds(e), ['E8:re_review']);
  assert.match(PW.wakeOf(e[0]).text, /Step re_review failed: the named refuter is dead\./);
  // Sent once whenever it is read; lifted only when the orchestrator acts after the step. The run's own rows (an evaluation, a worktree record,
  // a dead holder's release, a policy step) are task rows too and lift nothing.
  const later = (over, more = []) => PW.derive(snap([work('W', { written_at: 90, ...over }), ...more], { steps: [{ ...step, policy_rev: 1 }] }));
  const lifted = (x) => x.map((e) => [e.exception, !!e.lifted]);
  assert.deepStrictEqual(lifted(later({})), [['E8', false]]);
  assert.deepStrictEqual(lifted(later({ written_by: 'orchestrator', state: 'done' })), [['E8', false]], 'a bare orchestrator-stamped row (a worktree record) is not an act');
  assert.deepStrictEqual(lifted(later({ written_by: 'orchestrator', results: release({ evaluated_at: 70 }) })), [['E8', false]]);
  assert.deepStrictEqual(lifted(later({ policy_rev: 2 })), [['E8', true]], 'an amend, and it is still sent');
  assert.deepStrictEqual(lifted(later({ written_by: 'orchestrator', state: 'cancelled' })), [['E8', true]]);
  assert.deepStrictEqual(lifted(later({ written_by: 'orchestrator', state: 'assigned' })), [['E8', true]]);
  assert.deepStrictEqual(lifted(later({ written_by: 'orchestrator', state: 'assigned', acted_by: 'policy' })), [['E8', false]]);
  assert.deepStrictEqual(lifted(later({}, [task('F', { repairs: 'W', written_by: 'orchestrator', written_at: 95 })])).map((x) => x[1]), [true], 'a fix the orchestrator made of it');
  const T = [work('W', { written_at: 90, policy_rev: 2 })];
  assert.deepStrictEqual([...PW.haltedIds(PW.derive(snap(T, { steps: [{ ...step, policy_rev: 1 }] })), T)], [], 'a lifted E8 halts nothing');
});

test('every text names kind, task, trigger and plan field, inside the wake cap, for long ids and long titles', () => {
  const longTitles = Array.from({ length: 4 }, (_, i) => f('blocking', `a finding title of about forty-eight characters ${i}`));
  const cases = [
    PW.derive(snap([work(UUID, { review: { state: 'refuted', review_id: `rev-${UUID}`, rounds_left: 0, fix_rounds_used: 2, max_fix_rounds: 2 } }), reviewTask(`rev-${UUID}`, UUID, 'refuted', longTitles)])),
    PW.derive(snap([work(UUID, { review: { state: 'holds', review_id: `rev-${UUID}`, rounds_left: 2 } }), reviewTask(`rev-${UUID}`, UUID, 'holds', longTitles.map((x) => ({ ...x, severity: 'should-fix' })))])),
    PW.derive(snap([work(UUID, { state: 'released', results: release({ passed: false, checks: [1, 2, 3, 4].map((n) => ({ kind: 'command', argv: ['npm', 'run', `check-number-${n}`], passed: false, exit_code: 1 })) }) })])),
  ];
  assert.ok(cases.every((c) => c.length === 1), JSON.stringify(cases.map((c) => c.length)));
  for (const [e] of cases) {
    const w = PW.wakeOf(e);
    assert.ok(B(w.text) <= RE.WAKE_TEXT_MAX, `${B(w.text)}: ${w.text}`);
    assert.ok(w.text.includes(`exception ${e.exception}, task ${UUID}, trigger task:`) && w.text.includes(`, field ${e.field}.`), w.text);
    assert.deepStrictEqual([w.exception, w.task_id, w.trigger.startsWith('task:')], [e.exception, UUID, true]);
  }
  assert.ok(cases.slice(0, 2).every(([e]) => PW.wakeOf(e).text.endsWith(' Halted.')), 'the halt notice outlives the facts');
  const short = PW.derive(snap([work('W', { review: { state: 'refuted', review_id: 'R', rounds_left: 0, fix_rounds_used: 2, max_fix_rounds: 2 } }), reviewTask('R', 'W', 'refuted', longTitles)]));
  assert.match(PW.wakeOf(short[0]).text, /"a finding title of about forty-eight/, 'E2 carries the titles that fit');
});

test('the watcher sends one wake per exception, never again for it, and a new trigger is a new wake', async () => {
  const W = work('W', { state: 'released', results: release({ passed: false, checks: [{ kind: 'command', argv: ['x'], passed: false, exit_code: 1 }] }) });
  const s = { tasks: [W] };
  const core = { task: { list: async () => ({ tasks: s.tasks }) } };
  const w = PW.createPolicyWatcher({ core, runId: RUN });
  assert.deepStrictEqual(await w.poll({}), [], 'not armed: a run with no plan reads nothing');
  const seen = { policyArmed: true };
  const first = await w.poll(seen);
  assert.strictEqual(first.length, 1);
  assert.deepStrictEqual(await w.poll(seen), []);
  s.tasks = [{ ...W, seq: W.seq + 50, written_at: 99 }];
  assert.deepStrictEqual(await w.poll(seen), [], 'an amend rewrote the row: the same evaluation is the same fact');
  s.tasks = [{ ...W, seq: W.seq + 60, results: { ...W.results, evaluated_at: 21 } }];
  const next = await w.poll(seen);
  assert.strictEqual(next.length, 1, 'a new evaluation that fails is a new fact');
  assert.notStrictEqual(next[0].seq, first[0].seq);
});

test('a halt covers the task and its fixes only while the exception is current, and chain scope is the seam for the open question', () => {
  const W = work('W', { state: 'released', results: release({ passed: false, checks: [{ kind: 'command', argv: ['x'], passed: false, exit_code: 1 }] }) });
  const F = task('F', { repairs: 'W', state: 'open' });
  const D = task('D', { depends_on: ['W'], policy: PLAN });
  const other = work('O');
  const tasks = [W, F, D, other];
  const ex = PW.derive(snap(tasks));
  assert.deepStrictEqual([...PW.haltedIds(ex, tasks)].sort(), ['F', 'W']);
  assert.deepStrictEqual([...PW.haltedIds(ex, tasks, 'chain')].sort(), ['D', 'F', 'W']);
  assert.strictEqual(PW.HALT_SCOPE, 'task');
  const acted = [{ ...W, state: 'assigned', seq: W.seq + 9 }, F, D, other];
  assert.deepStrictEqual([...PW.haltedIds(PW.derive(snap(acted)), acted)], [], 'the orchestrator acted: no halt');
  assert.deepStrictEqual([...PW.haltedIds([{ exception: 'E4', task_id: 'W' }, { exception: 'E9', task_id: 'W' }], tasks)], [], 'a worker death and the budget are not a task halt');
});

test('exceptionOf names today\'s wakes E4, E9 and E10, and a routine wake nothing; the receipt entry carries exception and task_id', () => {
  const x = PW.exceptionOf;
  assert.deepStrictEqual(['death', 'stale', 'restart_failed', 'budget_pause', 'paused', 'pre_close', 'note_refuted', 'scrub_alarm', 'turn_end', 'evaluated'].map((event) => x({ event })), ['E4', 'E4', 'E4', 'E9', 'E10', 'E10', 'E10', 'E10', null, null]);
  const e = PW.derive(snap([work('W', { policy: { fix: 'builder' } })]))[0];
  const w = PW.wakeOf(e);
  const rec = wakeRecord(w, w.text, 5, true);
  assert.deepStrictEqual([rec.exception, rec.task_id, rec.event, rec.trigger, rec.key], ['E1', 'W', 'evaluated', w.trigger, `W@20`]);
  const plain = wakeRecord({ event: 'turn_end', worker_id: 'w1', turn: 1, seq: 2 }, 't', 5, false);
  assert.deepStrictEqual([plain.exception, plain.task_id], [null, null]);
});

// enrichWakes: the routine filter.
const turnEnd = (worker_id = 'w1') => ({ event: 'turn_end', worker_id, turn: 1, seq: 4 });
const handed = (over = {}) => task('W', { state: 'released', handoff: handoff(), results: release({ evaluated_at: 20 }), ...over });
const coreOf = (tasks) => ({ task: { list: async () => ({ tasks }) } });

test('routine events of a task under a plan are not wakes: its turn end, its evaluation, and the late evaluated wake', async () => {
  const seen = new Map();
  const out = await RE.enrichWakes(coreOf([handed({ policy: PLAN })]), RUN, [turnEnd()], seen);
  assert.deepStrictEqual(out, [], 'the turn end that handed back a task under a plan is routine');
  assert.strictEqual(seen.policyArmed, true);
  assert.ok(Array.isArray(seen.policyTasks), 'the policy watcher is handed the rows this poll read');
  // The late wake: the evaluation lands after the turn end went out for something else.
  const late = new Map();
  const t = handed({ policy: PLAN, results: null });
  const core = coreOf([t]);
  const first = await RE.enrichWakes(core, RUN, [turnEnd()], late, { holdMs: 1000, now: () => 0 });
  assert.deepStrictEqual(first, []);
  t.results = release({ evaluated_at: 20 });
  assert.deepStrictEqual(await RE.enrichWakes(core, RUN, [], late, { holdMs: 1000, now: () => 5 }), [], 'no `evaluated` wake follows');
  assert.strictEqual(late.get('W'), 20, 'the evaluation is still consumed');
});

test('the same hand-back with no plan wakes exactly as before; a worker with a task under a plan and one without still wakes', async () => {
  const seen = new Map();
  const out = await RE.enrichWakes(coreOf([handed()]), RUN, [turnEnd()], seen);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].evaluated[0].task_id, 'W');
  assert.ok(!seen.policyArmed && !seen.policyTasks, 'no plan, nothing armed');
  const mixed = await RE.enrichWakes(coreOf([handed({ policy: PLAN }), handed({ id: 'P', seq: 3 })]), RUN, [turnEnd()], new Map());
  assert.strictEqual(mixed.length, 1, 'a hand-back with no plan is not routine');
  assert.deepStrictEqual(mixed[0].evaluated.map((e) => e.task_id), ['P'], 'and the plan task is not carried on it');
});

// The two wake paths.
test('interactive path: the publisher sends an exception wake once, with the policy watcher armed by the poll that read the rows', async () => {
  const W = work('W', { policy: { fix: 'builder' }, handoff: handoff('w1') });
  const rows = [{ id: 'w1', run_id: RUN, state: 'running', turns: 0, seq: 1, pid_alive: true, mid_turn: 0 }];
  const core = { worker: { list: async () => ({ workers: rows.map((r) => ({ ...r })) }) }, task: { list: async () => ({ tasks: [W] }) } };
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\belay-test-pw-${crypto.randomBytes(5).toString('hex')}` : path.join(os.tmpdir(), `belay-test-pw-${crypto.randomBytes(5).toString('hex')}.sock`);
  const pub = startWakePublisher({ core, runId: RUN, pipeName: pipe, pollMs: 20 });
  await pub.listening;
  const lines = [];
  const sock = net.connect(pipe);
  let buf = '';
  sock.on('data', (d) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  sock.on('error', () => {});
  try {
    const until = async (fn) => { for (let n = 0; n < 400 && !fn(); n++) await new Promise((r) => setTimeout(r, 20)); return fn(); };
    rows[0] = { ...rows[0], turns: 1, seq: 2 }; // a turn end: enrichWakes reads the tasks and arms the watcher
    assert.ok(await until(() => lines.some((l) => l.text && /exception E1, task W,/.test(l.text))), JSON.stringify(lines));
    const polls = pub.stats().polls;
    assert.ok(await until(() => pub.stats().polls >= polls + 3));
    const ws = lines.filter((l) => l.text);
    assert.strictEqual(ws.filter((l) => /exception E1,/.test(l.text)).length, 1, JSON.stringify(ws));
    assert.ok(!ws.some((l) => /finished turn/.test(l.text)), 'the routine turn end is not published');
    assert.ok(B(ws[0].text) <= RE.WAKE_TEXT_MAX);
    const rc = pub.receipt();
    assert.deepStrictEqual(rc.map((r) => [r.exception, r.task_id]), [['E1', 'W']], 'the interactive receipt fills wakes[] too');
    assert.match(rc[0].trigger, /^task:W:/);
  } finally { sock.destroy(); await pub.stop(); }
});

test('headless path: the run writes the exception wake to the orchestrator once, with exception and task_id on its receipt entry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-policy-wake-'));
  const fwd = (p) => String(p).split(path.sep).join('/');
  const sb = { worktree: fwd(path.join(root, 'wt')), dataDir: fwd(path.join(root, '.belay')), orchestratorDir: fwd(path.join(root, 'orch')) };
  fs.mkdirSync(sb.worktree, { recursive: true });
  fs.mkdirSync(sb.dataDir, { recursive: true });
  const core = createFakeCore();
  const W = work('W', { state: 'released', results: release({ passed: false, checks: [{ kind: 'command', argv: ['npm', 'test'], passed: false, exit_code: 1 }] }) });
  core.task = { ...(core.task || {}), list: async () => ({ tasks: [W] }) };
  const saved = process.env.BELAY_CLAUDE_EXE;
  process.env.BELAY_CLAUDE_EXE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
  try {
    const out = await runOrchestrator({ core, runId: RUN, dataDir: sb.dataDir, onAttached: async () => ({ ok: true }), spec: {
      worktree: sb.worktree, promptText: 'hello', orchestratorDir: sb.orchestratorDir, model: 'claude-sonnet-5', allowedTools: null, policy: true,
      startupTimeoutMs: 8000, timeoutMs: 60000, mcpToolTimeoutMs: 60000, pollMs: 50, closeGraceMs: 3000,
    } });
    const woke = out.wakes.filter((w) => w.exception);
    assert.strictEqual(woke.length, 1, JSON.stringify(out.wakes));
    assert.deepStrictEqual([woke[0].exception, woke[0].task_id], ['E5', 'W']);
    assert.ok(woke[0].bytes <= 400);
  } finally {
    if (saved === undefined) delete process.env.BELAY_CLAUDE_EXE; else process.env.BELAY_CLAUDE_EXE = saved;
    cleanup(root);
  }
});

test('a plain task that depends on planned work does not take its plan; the review of planned work and a policy step rows do', async () => {
  const W = work('W');
  const T = task('T', { depends_on: ['W'], state: 'released', handoff: handoff(), results: release() });
  const byId = new Map([W, T].map((t) => [t.id, t]));
  assert.strictEqual(PW.policyOf(T, byId), null);
  assert.ok(PW.policyOf(reviewTask('R', 'W', 'holds', []), new Map([['W', W]])), 'a review of the work');
  assert.ok(PW.policyOf(task('R2', { depends_on: ['W'], acted_by: 'policy' }), byId), 'a row a policy step wrote');
  assert.strictEqual(PW.policyOf(task('F', { repairs: 'W' }), byId), null, 'an orchestrator fix resolves its own plan');
  assert.ok(PW.policyOf(task('F2', { repairs: 'W', acted_by: 'policy' }), byId));
  const out = await RE.enrichWakes(coreOf([W, T]), RUN, [turnEnd()], new Map());
  assert.strictEqual(out.length, 1, 'T finished and the orchestrator learns it');
  assert.strictEqual(out[0].evaluated[0].task_id, 'T');
});

test('a turn end with no hand-back is kept under a plan: a worker still holding the lease, or out of turns', async () => {
  const W = task('W', { policy: PLAN, state: 'assigned', lease: { holder: 'w1' } });
  const out = await RE.enrichWakes(coreOf([W]), RUN, [turnEnd()], new Map());
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].event, 'turn_end');
  const other = await RE.enrichWakes(coreOf([handed({ policy: PLAN })]), RUN, [turnEnd('w9')], new Map());
  assert.strictEqual(other.length, 1, 'another worker turn end is not the hand-back one');
});

test('E2 fires only when the re-review of the final allowed fix refutes: with a cap of 1, fix 1 runs and is re-reviewed first', () => {
  const R1 = reviewTask('R1', 'W', 'refuted', [f('blocking', 'first')]);
  const cap = (over) => ({ state: 'refuted', rounds_left: 0, fix_rounds_used: 1, max_fix_rounds: 1, ...over });
  // Before any fix the cap is 1: a refute with a round left is the fix's to take (routine), not E2.
  assert.deepStrictEqual(PW.derive(snap([work('W', { review: cap({ review_id: 'R1', rounds_left: 1, fix_rounds_used: 0 }) }), R1])), []);
  // Fix 1 exists, the derived rounds_left is already 0, but the fix has not been handed back or re-reviewed: no E2, the last round is not lost.
  const F1 = task('F1', { repairs: 'W', acted_by: 'policy', state: 'assigned' });
  assert.deepStrictEqual(PW.derive(snap([work('W', { review: cap({ review_id: 'R1' }) }), R1, F1])), [], 'the review that refuted the work is not the cap');
  // The re-review of fix 1 refutes: now E2, filed under the work.
  const R2 = reviewTask('R2', 'F1', 'refuted', [f('blocking', 'still broken')]);
  const e = PW.derive(snap([work('W', { review: cap({ review_id: 'R2' }) }), R1, F1, R2]));
  assert.deepStrictEqual(kinds(e), ['E2:fix']);
  assert.deepStrictEqual([e[0].task_id, e[0].trigger.id], ['W', 'R2']);
  // A refused fix for the cap is still E2 (the other source), and with no fixes at all a cap of 0 is E2 at once.
  assert.deepStrictEqual(kinds(PW.derive(snap([work('W', { review: cap({ review_id: 'R1', fix_rounds_used: 0 }) }), R1]))), ['E2:fix']);
});

test('a plan amend (a higher policy_rev in the task rows after the exception) lifts the halts of E1, E2, E5, E6 and E7, and a restart still sees it lifted', () => {
  const rv = (state, id, extra = {}) => ({ state, review_id: id, rounds_left: 1, fix_rounds_used: 0, max_fix_rounds: 2, ...extra });
  const cases = {
    E1: (rev) => [work('W', { policy_rev: rev, policy: { ...PLAN, fix: undefined }, review: rv('refuted', 'R') }), reviewTask('R', 'W', 'refuted', [f('blocking', 'x')])],
    E2: (rev) => [work('W', { policy_rev: rev, review: rv('refuted', 'R', { rounds_left: 0 }) }), reviewTask('R', 'W', 'refuted', [f('blocking', 'x')])],
    E5: (rev) => [work('W', { policy_rev: rev, state: 'released', results: release({ passed: false, checks: [{ kind: 'command', argv: ['x'], passed: false, exit_code: 1 }] }) })],
    E6: (rev) => [work('W', { policy_rev: rev, results: release({ flaky: true }) }), reviewTask('R', 'W', 'holds', [])],
    E7: (rev) => [work('W', { policy_rev: rev, review: rv('holds', 'R') }), reviewTask('R', 'W', 'holds', [f('should-fix', 'a')])],
  };
  // The work's versions, as policy.revisions reads them: rev 1 written before the evaluations (evaluated_at 20), rev 2 by an amend after them.
  const versions = (...revs) => revs.map(([policy_rev, written_at], i) => ({ id: 'W', seq: i + 1, written_at, policy_rev }));
  for (const [E, mk] of Object.entries(cases)) {
    const before = mk(1);
    const first = PW.derive(snap(before, { revisions: versions([1, 5]) }));
    assert.ok(first.some((x) => x.exception === E && !x.lifted), `${E} is active at rev 1`);
    assert.ok([...PW.haltedIds(first, before)].includes('W'), `${E} halts the task`);
    const after = mk(2).map((t) => ({ ...t, seq: t.seq + 1000 })); // the amend wrote a newer row; the facts (evaluations) are the same
    for (let restart = 0; restart < 2; restart += 1) { // the second derive is a fresh process with no state: the answer is the same
      const second = PW.derive(snap(after, { revisions: versions([1, 5], [2, 30]) }));
      assert.ok(second.some((x) => x.exception === E && x.lifted), `${E} is lifted by the amend (derive ${restart + 1})`);
      assert.deepStrictEqual([...PW.haltedIds(second, after)], [], `${E}: no halt after an amend`);
    }
    assert.ok(PW.derive(snap(after, { revisions: versions([2, 5]) })).every((x) => !x.lifted), `${E}: an amend before the fact is not a lift`);
    assert.ok(PW.derive(snap(after)).every((x) => !x.lifted), `${E}: with no revisions read there is no amend lift`);
  }
});
