'use strict';
// policy-wakes.cjs — ADR 0073 decisions 1 to 4. Under a plan (a task's `policy`) the run wakes the orchestrator on exceptions and on
// nothing routine. The exceptions are derived from store rows, level-triggered, never taken from a worker's words:
//   E1 the plan has no field for the step a fact calls for   E2 the fix cap          E3 a conflict at a policy integrate
//   E4 a worker death, stale or restart_failed (today's wakes, unchanged)            E5 an evaluation that failed or could not judge
//   E6 a pass on a retry, or a failing check that ran beside other evaluations       E7 a hold with should-fix findings
//   E8 a policy step that failed (a policy_step row finished `exception`)            E9 budget (today's budget_pause)
//   E10 paused, pre_close, note_refuted, scrub_alarm (today's wakes, unchanged)
// E4, E9 and E10 already are wakes; `exceptionOf` only names them for the run receipt. E1 to E3 and E5 to E8 are derived here: one wake
// per (exception, trigger row), kept in the watcher's `sent` set, and the same text on both wake paths (headless and interactive).
// The wake is an `evaluated` event (wake.cjs passes its text through): kind, task, trigger row and plan field (or `none`) come first,
// then the facts and a closing `Halted.` (no policy step on the task until the orchestrator acts or amends), the whole cut to the wake cap; E2 and E7 carry the finding titles review-wake.cjs already builds (ADR 0063).
// A wake derived here is data, never an instruction, and no exception is resolved by belay (decision 4): this module only reads.
// Halt (decision 3): an active E1 to E8 halts the task and its fixes; `haltedIds` says which, for the executor (haltScope is the seam
// for ADR 0073 Q1, per task or per chain). E1, E2, E3, E5, E6 and E7 are active while the condition they name holds in the rows, so an
// orchestrator's act that clears it (a new task row, an amend included) lifts the halt; E8 lifts only on an amend, a cancel, a re-assign or a
// fix or review the orchestrator made of the task, after the step. A wake is keyed on the FACT (the evaluation, the review, the step), never on the trigger row's current seq, so an amend
// that rewrites the row does not send it again. The canonical table of trigger, task, key and lift is in api.md (Policy exception wakes).

const reviewWake = require('./review-wake.cjs');

const WAKE_TEXT_MAX = 221; // release-eval.cjs WAKE_TEXT_MAX; the mod's text budget less the plugin name
const ESC_KINDS = new Set(['question', 'blocked', 'scope', 'conflict', 'spec']);
// A hand-back's escalation (ADR 0074 amendment 4): the facts, and whether the orchestrator has acted on the task since (re-assigned or
// cancelled it after the hand-back). null when the hand-back asks for nothing.
function escalationFact(x) {
  const esc = x && x.handoff && x.handoff.result && x.handoff.result.escalate;
  if (!esc || typeof esc !== 'object' || typeof esc.reason !== 'string' || !esc.reason.trim()) return null;
  const at = Number(x.handoff.at) || 0;
  const acted = x.written_by === 'orchestrator' && x.acted_by !== 'policy' && Number(x.written_at) > at && (x.state === 'assigned' || x.state === 'cancelled');
  return { detail: { task: x.id, by: x.handoff.by || null, kind: ESC_KINDS.has(esc.kind) ? esc.kind : 'other', reason: esc.reason }, fact: { key: `${x.id}@${at}`, seq: at, at }, acted };
}
// The escalation of a task under no plan: it wakes and halts nothing. The same shape and key as derive's, so the wait and the wake claim it once.
function unplannedEscalation(x) {
  const es = escalationFact(x);
  if (!es) return null;
  return { exception: 'escalation', task_id: x.id, trigger: { table: 'task', id: x.id, seq: Number(x.seq) || 0 }, field: 'none', seq: es.fact.seq, key: es.fact.key, uid: `escalation:none:${es.fact.key}`, detail: { ...es.detail, planned: false } };
}
const REVISION_IDS = 200; // task ids per policy.revisions call (its cap is 500)
const AMEND_LIFTS = new Set(['E1', 'E2', 'E5', 'E6', 'E7', 'escalation']); // a plan amend after the exception lifts these halts (E8's own lift reads its step's policy_rev)
const HALTING = new Set(['E1', 'E2', 'E3', 'E5', 'E6', 'E7', 'E8', 'escalation']); // E4 is the worker's, E9 pauses the run, E10 is not a task's
// ADR 0073 Q1 (open): 'task' halts the task and its fixes (the recommendation); 'chain' also halts what depends on them.
const HALT_SCOPE = 'task';

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const parse = (v) => { if (v && typeof v === 'object') return v; try { const p = typeof v === 'string' ? JSON.parse(v) : null; return p && typeof p === 'object' ? p : null; } catch { return null; } };

const isReviewRow = (t) => ((t.results && t.results.checks) || []).some((c) => c && c.kind === 'verdict');
// Whether `t` takes the plan of `up`, the one task it depends on or repairs: a row a policy step wrote, or the review of planned work. Any other
// dependent (a plain task that waits on planned work) and a fix the orchestrator made (it resolves its own plan) do not.
const inherits = (t, up) => t.acted_by === 'policy' || t.policy_made === true || (t.repairs !== up.id && (isReviewRow(t) || !!(up.review && up.review.review_id === t.id)));
// The policy a task acts under: its own, else that of the work it reviews or the work a policy step made it repair.
function policyOf(task, byId) {
  let t = task;
  for (let n = 0; t && n < 100; n++) {
    const p = parse(t.policy);
    if (p) return p;
    const up = byId ? byId.get(t.repairs || (Array.isArray(t.depends_on) && t.depends_on.length === 1 ? t.depends_on[0] : null)) : null;
    t = up && inherits(t, up) ? up : null;
  }
  return null;
}
const rootOf = (task, byId) => { let t = task; for (let n = 0; t.repairs && byId.get(t.repairs) && n < 100; n++) t = byId.get(t.repairs); return t; };

// The run receipt's name for a wake: the exception it is, or null for a routine wake. A task's id when the wake names one.
function exceptionOf(ev) {
  if (ev.exception) return ev.exception;
  switch (ev.event) {
    case 'death': case 'stale': case 'restart_failed': return 'E4';
    case 'budget_pause': return 'E9';
    case 'time_bound': return 'E11'; // the run's time bound (time-wake.cjs): a cap, with its own code beside the budget's E9
    case 'paused': case 'pre_close': case 'note_refuted': case 'scrub_alarm': return 'E10';
    default: return null;
  }
}

const failing = (r) => ((r && r.checks) || []).filter((c) => c && c.passed === false);
const beside = (c) => (Array.isArray(c.concurrent) ? c.concurrent.length : 0);
const checkName = (c) => (c.kind === 'command' ? `command ${Array.isArray(c.argv) ? c.argv.slice(0, 3).join(' ') : '?'}${c.exit_code != null ? ` exit ${c.exit_code}` : ''}` : c.kind || '?');
// A clean refutation: the review ran, its verdict is the only failing check. The plan answers it (a fix), so it is not an E5.
const cleanRefutation = (r) => r.executable === true && failing(r).length > 0 && failing(r).every((c) => c.kind === 'verdict' && c.executable === true);

// -> the exceptions the rows show now. `snap`: { runId, tasks (task.list rows), integrations, steps (policy.list rows), failures (release_failed events) }.
// Each: { exception, task_id, trigger: { table, id, seq }, field, seq (the wake's), uid (its dedupe key), detail }.
// Whether review R judged the newest fix of the work (or the work itself, when no fix exists). The newest is by creation order, the seq of a fix's FIRST
// version (`firstSeq`, from policy.revisions): a later row on an older fix (a sweep, a worktree record) must not make it look newer. Without the
// versions read (a cut-off or failed read, or a fix missing from it) the order is unknown, and it fails toward waking: E2 is raised, never suppressed.
// A fix round is left on this derived review: the hard cap allows one when there is a hard cap, else max_fix_rounds is not yet reached.
// With a hard cap max_fix_rounds is a notice only: the fix past it is made with fix_notice, and the fix step wakes E2 on it.
function fixRoundsLeft(rv) {
  if (rv.rounds_left != null) return rv.rounds_left > 0;
  return !(rv.max_fix_rounds != null && rv.fix_rounds_used >= rv.max_fix_rounds);
}

function finalFixJudged(work, R, tasks, byId, firstSeq) {
  const fixes = tasks.filter((t) => t.id !== work.id && t.repairs && rootOf(t, byId).id === work.id);
  if (!fixes.length || !fixes.every((t) => firstSeq.has(t.id))) return true;
  const born = (t) => firstSeq.get(t.id);
  const newest = fixes.reduce((a, b) => (born(b) > born(a) ? b : a));
  return Array.isArray(R.depends_on) && R.depends_on.includes(newest.id);
}

// The seq of the task row a release_failed event was written against (its message), or null for an event from before it was recorded.
function rowSeqOf(ev) { try { const m = JSON.parse(ev.message); return m && Number.isFinite(Number(m.seq)) ? Number(m.seq) : null; } catch { return null; } }

function derive(snap) {
  const { runId } = snap;
  const tasks = (snap.tasks || []).filter((t) => t.run_id === runId);
  const byId = new Map((snap.tasks || []).map((t) => [t.id, t]));
  const dependents = new Set(); for (const t of tasks) for (const d of Array.isArray(t.depends_on) ? t.depends_on : []) dependents.add(d);
  const out = [];
  // `fact`: { key, seq } names the fact the wake is about (an evaluation, a review's verdict, a step), so the wake is one per fact and is not sent
  // again when the trigger row is rewritten. `trigger` is the row at derivation; `seq` (the fact's number) makes the interactive wake id stable.
  // `snap.revisions` (policy.revisions: every version's plan revision, from the append-only task rows) says which plan the exception's fact happened
  // under: the revision of the work's version current at the fact's time. A newer version with a higher revision is an amend after the exception,
  // which lifts E1, E2, E5, E6 and E7. It is read from the rows, so a restart and every process agree; a caller with no revisions sees no amend lift.
  const revOf = new Map();
  for (const r of snap.revisions || []) { if (!revOf.has(r.id)) revOf.set(r.id, []); revOf.get(r.id).push(r); }
  const firstSeq = new Map([...revOf].map(([id, vs]) => [id, Number(vs[0].seq)]));
  // The plan revision `id` carried when the fact was written: the fact's own row is the version of `fact.row` whose results hold that evaluation, and
  // the plan is the latest planned version of `id` at or before that seq (one global seq across task rows, so no clock is compared). A fact with no
  // row (a release_failed event) compares the version's write time with the event's; a fact whose row is not in the versions read has no baseline.
  const revAt = (id, fact) => {
    const vs = (revOf.get(id) || []).filter((r) => r.policy_rev != null);
    if (!vs.length) return null;
    let upTo;
    if (fact.rowSeq != null) upTo = (v) => Number(v.seq) <= fact.rowSeq;
    else if (fact.row) {
      const own = (revOf.get(fact.row) || []).find((r) => r.evaluated_at != null && Number(r.evaluated_at) === fact.at);
      if (!own) return null;
      upTo = (v) => Number(v.seq) <= Number(own.seq);
    } else upTo = (v) => Number(v.written_at) <= fact.at;
    let rev = Number(vs[0].policy_rev);
    for (const v of vs) if (upTo(v)) rev = Number(v.policy_rev);
    return rev;
  };
  const add = (exception, task, trigger, field, detail, fact, extra = {}) => {
    const uid = `${exception}:${field || 'none'}:${fact.key}`;
    let amended = false;
    if (snap.revisions && fact.at != null && AMEND_LIFTS.has(exception)) {
      const was = revAt(task.id, fact), now = task.policy_rev == null ? null : Number(task.policy_rev);
      amended = was !== null && now !== null && now > was;
    }
    out.push({ exception, task_id: task.id, trigger, field: field || 'none', seq: fact.seq, key: fact.key, uid, detail: detail || {}, ...(amended ? { lifted: true } : {}), ...extra });
  };
  const evOf = (t) => ({ key: `${t.id}@${t.results.evaluated_at}`, seq: Number(t.results.evaluated_at) || 0, at: Number(t.results.evaluated_at) || 0, row: t.id });
  const tref = (t) => ({ table: 'task', id: t.id, seq: Number(t.seq) || 0 });
  const fails = snap.failures || [];

  for (const x of tasks) {
    const P = policyOf(x, byId);
    if (!P) continue;
    const root = rootOf(x, byId);
    const r = x.results || {};
    const own = r.trigger === 'release' && x.handoff && Number(r.evaluated_at) >= Number(x.handoff.at); // belay's own evaluation of a hand-back
    // E5 / E6: the hand-back's evaluation.
    if (own && x.state === 'released' && !cleanRefutation(r) && !r.passed) {
      const ran = failing(r).filter((c) => beside(c) > 0);
      if (ran.length) add('E6', root, tref(x), null, { concurrent: ran.map((c) => ({ name: checkName(c), n: beside(c) })), task: x.id }, evOf(x));
      else add('E5', root, tref(x), null, { executable: r.executable !== false, failing: failing(r).map(checkName), task: x.id }, evOf(x));
    } else if (own && x.state === 'done' && r.flaky) add('E6', root, tref(x), null, { flaky: true, task: x.id }, evOf(x));
    // escalation (ADR 0074 amendment 4, not an E-code): a worker's hand-back asks for the orchestrator (`result.escalate: { kind, reason }`).
    // It always wakes, planned task or not, and halts the task's planned steps until the orchestrator acts on the task after the hand-back
    // (re-assigns or cancels it) or amends its plan. The reason is the worker's words: quoted, cut, never an instruction.
    const es = escalationFact(x);
    // A reviewer's escalation is filed under the work it judged, as a fix's is under its work, so an amend of the work's plan lifts it and the done wake can follow.
    const judgedWork = es && isReviewRow(x) && Array.isArray(x.depends_on) && x.depends_on.length === 1 ? byId.get(x.depends_on[0]) : null;
    if (es) add('escalation', judgedWork ? rootOf(judgedWork, byId) : root, tref(x), 'none', { ...es.detail, planned: true }, es.fact, es.acted ? { lifted: true } : {});
    // E5: a release evaluation that ended without a result (a queue refusal, an error): the ledger's release_failed events.
    if (x.state === 'released' && x.handoff) {
      for (const f of fails) if (f.task_id === x.id && f.code !== 'E_CANCELLED' && Number(f.written_at) >= Number(x.handoff.at)) add('E5', root, tref(x), null, { executable: true, failing: [], error: f.code, task: x.id }, { key: `${x.id}!${f.id}`, seq: Number(f.seq) || 0, at: Number(f.written_at) || 0, rowSeq: rowSeqOf(f) });
    }
    // E1, work done with no review step in the plan; a fix done with no re_review.
    if (own && x.state === 'done' && !isReviewRow(x) && !dependents.has(x.id)) {
      if (!x.repairs && !P.review) add('E1', root, tref(x), 'review', { task: x.id }, evOf(x));
      if (x.repairs && !P.re_review) add('E1', root, tref(x), 're_review', { task: x.id }, evOf(x));
    }
    // The review's verdict, on the work it judges (task.review is derived on the work and its fixes).
    const rv = x.review;
    if (!x.repairs && rv && (rv.state === 'refuted' || rv.state === 'holds')) {
      const R = byId.get(rv.review_id);
      if (!R || R.run_id !== runId || !(R.results && R.results.trigger === 'release')) continue;
      const facts = reviewWake.reviewOf(R);
      if (!facts) continue;
      const titles = facts.blocking.titles.concat(facts.should_fix.titles);
      const fact = evOf(R); // the review's verdict, by its evaluation
      if (rv.state === 'refuted') {
        if (!P.fix) add('E1', x, tref(R), 'fix', { review: R.id, titles }, fact);
        // E2 is a review REFUTED with no rounds left: the refute of the final allowed fix's re-review. While a newer fix than the one this review judged exists,
        // the last allowed round has not been reviewed yet, so the refute is not the cap.
        else if (!fixRoundsLeft(rv) && finalFixJudged(x, R, tasks, byId, firstSeq)) add('E2', x, tref(R), 'fix', { review: R.id, titles, used: rv.fix_rounds_used, max: rv.max_fix_rounds }, fact);
      } else if (facts.should_fix.n > 0 && (!P.follow_up || P.follow_up === 'wake') && !(rv.follow_ups && rv.follow_ups.length) && !(x.integration && x.integration.state === 'merged')) {
        add('E7', x, tref(R), P.follow_up ? 'follow_up' : 'none', { review: R.id, n: facts.should_fix.n, titles: facts.should_fix.titles }, fact);
      }
      if (rv.state === 'holds' && !P.integrate && x.state === 'done' && !(x.integration && x.integration.state === 'merged')) add('E1', x, tref(R), 'integrate', { review: R.id }, fact);
    }
  }

  // E3: a conflict at a policy integrate. Active while it is the newest integration row naming any of its tasks.
  const ints = snap.integrations || [];
  for (const i of ints) {
    if (i.run_id !== runId || i.state !== 'conflict' || i.acted_by !== 'policy') continue;
    const ids = Array.isArray(i.task_ids) ? i.task_ids : [];
    if (ints.some((o) => o.id !== i.id && Number(o.seq) > Number(i.seq) && (Array.isArray(o.task_ids) ? o.task_ids : []).some((t) => ids.includes(t)))) continue;
    const tid = (i.conflict && i.conflict.task_id) || ids[0];
    const t = byId.get(tid) || { id: tid };
    add('E3', byId.get(tid) ? rootOf(t, byId) : t, { table: 'integration', id: i.id, seq: Number(i.seq) || 0 }, 'integrate', { files: i.conflict && Array.isArray(i.conflict.files) ? i.conflict.files.length : null, task: tid }, { key: i.id, seq: Number(i.seq) || 0 });
  }

  // E8 (and E2 when the fix was refused for the cap): a policy step finished `exception`. Sent once, whenever it is read; it halts the task until a
  // task row the orchestrator wrote after the step (`lifted` says so), so the wake does not depend on how soon the orchestrator acts.
  for (const s of snap.steps || []) {
    if (s.run_id !== runId || s.outcome !== 'exception' || !s.task_id) continue;
    const t = byId.get(s.task_id);
    const trigger = { table: s.trigger_table, id: s.trigger_id, seq: Number(s.trigger_seq) || 0 };
    const cap = /E_FIX_ROUNDS|fix_notice/.test(String(s.error || ''));
    const R = cap && s.trigger_table === 'task' ? byId.get(s.trigger_id) : null; // the refused fix's trigger is the refuted review, and the wake is filed under the work it judged
    const judged = R && Array.isArray(R.depends_on) && R.depends_on.length === 1 ? byId.get(R.depends_on[0]) : null;
    const root = judged ? rootOf(judged, byId) : t ? rootOf(t, byId) : { id: s.task_id };
    // The orchestrator acted on the failed step: it amended the plan (policy_rev moved), cancelled or re-assigned the task, or made a fix or review of it.
    // A task row alone is not an act: the run's own evaluation, a worktree record, a dead holder's release and a policy step all write task rows too.
    const end = Number(s.finished_at || s.at);
    const byOrch = (o) => o && o.acted_by !== 'policy' && o.written_by === 'orchestrator' && Number(o.written_at) > end;
    const orchestratorRow = !!t && (t.policy_rev != null && s.policy_rev != null && Number(t.policy_rev) !== Number(s.policy_rev)
      || (byOrch(t) && (t.state === 'cancelled' || t.state === 'assigned'))
      || tasks.some((o) => byOrch(o) && o.id !== root.id && (o.repairs === root.id || (Array.isArray(o.depends_on) && o.depends_on.includes(root.id)))));
    if (cap && s.step === 'fix') add('E2', root, trigger, 'fix', { step: s.step, error: s.error }, R && R.results ? evOf(R) : { key: `step${s.seq}`, seq: Number(s.seq) }, { lifted: !!orchestratorRow });
    else if (/^E_BUDGET/.test(String(s.error || ''))) add('E9', root, trigger, s.step, { step: s.step, error: s.error }, { key: `step${s.seq}`, seq: Number(s.seq) }, { lifted: true }); // a step refused at the budget's soft threshold (policy-budget.cjs): the wake is the budget's, and it halts nothing
    else add('E8', root, trigger, s.step, { step: s.step, error: s.error }, { key: `step${s.seq}`, seq: Number(s.seq) }, { lifted: !!orchestratorRow });
  }
  return out.filter((e, i) => out.findIndex((o) => o.uid === e.uid) === i); // one exception per trigger: the rows' E2 and a refused fix's E2 are one
}

// The tasks a halt covers: the task and the fixes that repair it ('task'), and, for 'chain', what depends on any of those.
function haltScope(taskId, tasks, mode = HALT_SCOPE) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const ids = new Set([taskId]);
  for (const t of tasks) if (rootOf(t, byId).id === taskId) ids.add(t.id);
  if (mode === 'chain') {
    for (let grew = true; grew;) { grew = false; for (const t of tasks) if (!ids.has(t.id) && (t.depends_on || []).some((d) => ids.has(d))) { ids.add(t.id); grew = true; } }
  }
  return ids;
}
// The task ids the executor takes no step on: the scope of every active E1 to E8.
function haltedIds(exceptions, tasks, mode = HALT_SCOPE) {
  const out = new Set();
  for (const e of exceptions) if (HALTING.has(e.exception) && !e.lifted) for (const id of haltScope(e.task_id, tasks, mode)) out.add(id);
  return out;
}

const cut = (s, max) => reviewWake.cut(s, max);
const list = (a) => a.map((t) => `"${t}"`).join('; ');
// The wake text. Head first (kind, task, trigger, field), then the facts; only the facts give way to the cap.
function textOf(e) {
  const d = e.detail;
  if (e.exception === 'escalation') {
    const head = `belay: escalation (${d.kind}) from ${d.by || 'a worker'}, task ${d.task}${d.task !== e.task_id ? ` (work ${e.task_id})` : ''}: "`;
    const tail = d.planned === false ? '". No plan: answer as you see fit.' : '". Halted until you re-assign, cancel or amend it; a message alone lifts nothing.';
    const room = Math.max(16, WAKE_TEXT_MAX - bytes(head) - bytes(tail));
    return cut(`${head}${cut(clean(d.reason).replace(/"/g, "'"), room)}${tail}`, WAKE_TEXT_MAX);
  }
  const head = `belay: exception ${e.exception}, task ${e.task_id}, trigger ${e.trigger.table}:${e.trigger.id}:${e.trigger.seq}, field ${e.field}.`;
  const halt = HALTING.has(e.exception) ? ' Halted.' : '';
  const titles = Array.isArray(d.titles) && d.titles.length ? ` ${list(d.titles)}.` : '';
  let body;
  switch (e.exception) {
    case 'E1': body = ` The plan has no ${e.field} step for this.`; break;
    case 'E2': body = ` Fix cap reached${d.used != null ? ` (${d.used} used${d.max != null ? ` of ${d.max}` : ''})` : ''}; review ${d.review || 'refuted'}.${d.error ? ` ${d.error}` : ''}${titles}`; break;
    case 'E3': body = ` Integrate conflict on task ${d.task}${d.files != null ? ` (${d.files} file${d.files === 1 ? '' : 's'})` : ''}.`; break;
    case 'E5': body = d.executable === false ? ` Task ${d.task} evaluation could not judge.` : ` Task ${d.task} evaluation failed${d.error ? ` (${d.error})` : ''}${d.failing && d.failing.length ? `: ${d.failing.join(', ')}` : ''}.`; break;
    case 'E6': body = d.flaky ? ` Task ${d.task} passed on a retry (flaky).` : ` Task ${d.task} failed beside other evaluations: ${d.concurrent.map((c) => `${c.name} (with ${c.n})`).join(', ')}.`; break;
    case 'E7': body = ` Review ${d.review} holds with ${d.n} should-fix.${titles}`; break;
    case 'E9': body = ` Step ${d.step} not taken: ${clean(d.error)}.`; break;
    case 'E8': body = ` Step ${d.step} failed: ${clean(d.error)}.`; break;
    default: body = '';
  }
  const room = WAKE_TEXT_MAX - bytes(head);
  const keep = bytes(halt) <= room ? halt : ''; // the facts give way to the cap before the halt notice does
  return cut(`${head}${cut(body, room - bytes(keep))}${keep}`, WAKE_TEXT_MAX);
}
const clean = (s) => String(s || 'no reason').replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 80);

const wakeOf = (e) => ({ event: 'evaluated', worker_id: `policy:${e.exception}:${e.field}:${e.task_id}`, turn: 0, seq: e.seq, task_id: e.task_id, exception: e.exception, trigger: `${e.trigger.table}:${e.trigger.id}:${e.trigger.seq}`, field: e.field, key: e.key, text: textOf(e) });

// The tasks whose versions the lifts and the fix order need: every planned work task, the fixes that repair it and the tasks that take its plan
// (its reviews). Exact and bounded by the run's plans, not by the store's size.
function familyIds(runId, tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const mine = tasks.filter((t) => t.run_id === runId);
  const roots = new Set(mine.filter((t) => !t.repairs && parse(t.policy)).map((t) => t.id));
  return mine.filter((t) => roots.has(t.id) || roots.has(rootOf(t, byId).id) || policyOf(t, byId)).map((t) => t.id);
}
// -> the versions of those tasks (policy.revisions), or undefined when the core has no such read, there is nothing to read, a read fails or any
// part of the answer was cut off: an incomplete history is never read as "no amend".
async function readRevisions(policy, runId, tasks) {
  if (!policy || typeof policy.revisions !== 'function') return undefined;
  const ids = familyIds(runId, tasks);
  const out = [];
  for (let i = 0; i < ids.length; i += REVISION_IDS) {
    let r;
    try { r = await policy.revisions({ task_ids: ids.slice(i, i + REVISION_IDS) }); } catch { return undefined; }
    if (!r || r.truncated || !Array.isArray(r.revisions)) return undefined;
    out.push(...r.revisions);
  }
  return out.length ? out : undefined;
}

// The watcher both wake paths hold. `seen` is the release-eval map the caller already carries: enrichWakes sets `seen.policyTasks` (the
// task rows it read this poll) and `seen.policyArmed` once it sees a task under a plan, so a run with no plan reads nothing more.
// `enabled`: arm from the start (a run whose spec carries a plan). Reads: task.list when enrichWakes did not, then integration.list,
// policy.list and the release_failed events, only once armed. `active()` is the last derivation, for the executor's halt check.
function createPolicyWatcher({ core, runId, enabled = false }) {
  const sent = new Set();
  let last = [];
  let lastSnap = null; // this poll's rows, for the idle close (policy-close-hold.cjs); null while the watcher is off, { failed } when the read failed
  async function snapshot(seen) {
    let tasks = seen && seen.policyTasks; if (seen) seen.policyTasks = null;
    if (!tasks) { try { tasks = ((await core.task.list({})) || {}).tasks || []; } catch { return null; } }
    let readFailed = false; // a failed integration or step read is [] for the wakes, as before, and unknown facts for the idle close
    const ints = core.integration && core.integration.list ? await core.integration.list({}).then((r) => (r && r.integrations) || [], () => { readFailed = true; return []; }) : [];
    const steps = core.policy && core.policy.list ? await core.policy.list({}).then((r) => (r && r.rows) || [], () => { readFailed = true; return []; }) : [];
    const failures = core.memory && core.memory.events ? await core.memory.events({ run_id: runId, kinds: ['release_failed'] }).then((r) => ((r && r.events) || []).map((e) => ({ ...e, task_id: e.task_id || (Array.isArray(e.row_ids) ? e.row_ids[0] : null) })), () => []) : [];
    const revisions = await readRevisions(core.policy, runId, tasks);
    return { runId, tasks, integrations: ints, steps, failures, ...(revisions ? { revisions } : {}), ...(readFailed ? { readFailed } : {}) };
  }
  async function poll(seen) {
    if (!enabled && !(seen && seen.policyArmed)) { lastSnap = null; return []; }
    const snap = await snapshot(seen);
    lastSnap = snap || { failed: true };
    if (!snap) return [];
    last = derive(snap);
    const out = [];
    for (const e of last) if (!sent.has(e.uid)) { sent.add(e.uid); out.push(wakeOf(e)); }
    const done = require('./done-wake.cjs').doneOf(snap, last); // ADR 0074 amendment 4: the one routine wake, when every planned task has gone the whole way
    if (done && !sent.has(`done:${done.key}`)) { sent.add(`done:${done.key}`); out.push(require('./done-wake.cjs').wakeOf(runId, done)); }
    return out;
  }
  return { poll, active: () => last.slice(), snapshot: () => lastSnap };
}

module.exports = { unplannedEscalation, escalationFact, fixRoundsLeft, derive, readRevisions, familyIds, exceptionOf, policyOf, rootOf, haltScope, haltedIds, textOf, wakeOf, createPolicyWatcher, HALTING, HALT_SCOPE, WAKE_TEXT_MAX };
