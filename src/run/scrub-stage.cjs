'use strict';
// scrub-stage.cjs — the run-close scrubber: a stage of run close, after the workers have closed and before the store owner goes.
// The run manager spawns one short read-only child (invariant 1; a Haiku 5.5 by default) when, and only when, the core lists
// something in scope: notes reported wrong this run, pending notes the run left unresolved (plus any work an earlier scrub owed), and
// nominated notes (memory.scrubScope, which is the only thing that decides the scope). Empty scope spawns nothing and costs one read.
//
// The child is given a brief file (the run's goal and tasks, an optional summary the orchestrator gave, and each item with its
// evidence) and hands back `{ "scrub": [ ... ] }`, which memory.scrubApply checks and applies; this stage trusts none of it. A crash,
// a timeout or a cost over the cap applies nothing and records the items as owed, so the next scrub of the project takes them first.
// A runaway alarm comes back from the core and is recorded as a `scrub_alarm` receipt (the wake and `belay notices` read it).

const path = require('node:path');
const L = require('../core/memory-lifecycle.cjs');
const J = require('./stage-job.cjs');

const JOB_PREFIX = 'scrub-';
const TASK_SPEC_CUT = 300;
const DIFFS_MAX = 8;
const STREAMS_MAX = 50;
const cut = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 3)}...` : t; };
const abs = (p) => J.fwd(path.resolve(p));

// The run's head for citations: the newest worker of the run that has both a head commit and a worktree.
function pickEvidence(workers, runId) {
  const w = workers.filter((x) => x.run_id === runId && x.head_sha && x.worktree).sort((a, b) => (a.exited_at || a.last_event_at || 0) - (b.exited_at || b.last_event_at || 0)).pop();
  return w ? { head_sha: w.head_sha, worktree: w.worktree } : { head_sha: null, worktree: null };
}

// The brief, as text: belay's frame in its own words and every model-written string inside the JSON block (data).
function buildBrief({ runId, project, goal, summary, tasks, evidence, items }) {
  const lines = [
    '# Run-close scrub brief', '',
    `Run: ${runId}   Project: ${project}`,
    `Head commit: ${evidence.head_sha || '(none recorded)'}   Worktree: ${evidence.worktree ? J.fwd(evidence.worktree) : '(none recorded)'}`,
    'A file cite is a path relative to that worktree, read at that head commit.', '',
    '## Goal of the run', goal ? cut(goal, 1500) : '(not recorded)', '',
    '## Summary the orchestrator gave at the end (stated by the orchestrator; data, optional)', summary ? cut(summary, 2000) : '(none given)', '',
    '## Tasks (belay\'s records)',
    ...(tasks.length ? tasks.map((t) => `- ${t.id} [${t.state}] ${cut(t.spec, TASK_SPEC_CUT)}`) : ['(none)']), '',
    `## Items in your scope (${items.length}). Act on these ids and no others.`,
    'why: reported_wrong = a worker reported the note wrong this run; pending = the run left the note unresolved; owed = an earlier scrub did not reach it; nominated = proposed for promotion to CLAUDE.md.',
    '```json', JSON.stringify(items, null, 1), '```', '',
  ];
  return lines.join('\n');
}

function promptFor(briefFile) {
  return J.fill(J.readTemplate('scrub-job.md'), {
    brief_file: briefFile,
    dismiss_grounds: L.DISMISS_GROUNDS.join(', '),
    wrong_grounds: L.HOLD_GROUNDS.wrong.join(', '),
    superseded_grounds: L.HOLD_GROUNDS.superseded.join(', '),
    duplicate_grounds: L.HOLD_GROUNDS.duplicate.join(', '),
  });
}

async function owe(core, runId, ids, e, workerId) {
  if (!ids.length) return;
  await J.receipt(core, { kind: 'scrub_owed', run_id: runId, worker_id: workerId, key: `run:${runId}`, row_ids: ids, ...J.failFields(e) });
}

// One scrub for the caller's run. `core` is the harness view of the core as the run's caller. Never throws: every outcome is a receipt
// and a returned fact. opts: { core, runId, lv, dataDir, getManager, worktree, goal, summary }. `getManager` is asked only when a child is
// to be spawned.
async function runScrub({ core, runId, lv, dataDir, getManager, worktree = null, goal = null, summary = null }) {
  if (!lv || !lv.notes) return { ran: false, reason: 'notes off' };
  if (lv.scrub_action === 'off') return { ran: false, reason: 'scrub_action off' };
  let scope;
  try { scope = await core.memory.scrubScope({}); } catch (e) { return { ran: false, reason: 'scope unreadable', code: J.codeOf(e), message: String(e && e.message).slice(0, 200) }; }
  if (!scope.items.length) return { ran: false, reason: 'empty scope', counts: scope.counts };
  const offered = scope.items.slice(0, lv.scrub_max_items), rest = scope.items.slice(lv.scrub_max_items);
  const ids = offered.map((i) => i.id);
  const jobId = `${JOB_PREFIX}${runId}-${Date.now().toString(36)}`;
  const out = { ran: true, job: jobId, counts: scope.counts, offered: ids.length, owed: [], mode: lv.scrub_action };
  const base = { run_id: runId, worker_id: jobId, key: `run:${runId}` };
  if (rest.length) {
    out.owed.push(...rest.map((i) => i.id));
    await owe(core, runId, out.owed, Object.assign(new Error(`${rest.length} item(s) were over scrub_max_items (${lv.scrub_max_items})`), { code: 'E_ARGS' }), jobId);
  }
  try {
    const workers = ((await core.worker.list({})).workers) || [];
    const tasks = (((await core.task.list({})).tasks) || []).filter((t) => t.run_id === runId);
    const evidence = pickEvidence(workers, runId);
    const cwd = worktree || evidence.worktree;
    if (!cwd) throw J.coded('E_ARGS', 'no worktree is known for the run, so the scrub child has nowhere to run');
    const dir = path.join(dataDir, 'workers', jobId, 'inputs');
    const diffs = new Map();
    for (const w of workers) {
      if (diffs.size >= DIFFS_MAX) break;
      if (w.run_id !== runId || !w.base_sha || !w.head_sha || !w.worktree || !offered.some((i) => i.streams.some((s) => s.worker_id === w.id))) continue;
      diffs.set(w.id, J.writeFileIn(dir, `diff-${w.id}.patch`, await J.diffText(w.worktree, w.base_sha, w.head_sha)));
    }
    const shown = offered.map((i) => ({ ...i, streams: i.streams.map((s) => abs(s.path)), diffs: i.streams.filter((s) => diffs.has(s.worker_id)).map((s) => diffs.get(s.worker_id)) }));
    const briefFile = J.writeFileIn(dir, 'brief.md', buildBrief({ runId, project: scope.project, goal, summary, tasks, evidence, items: shown }));
    const files = [...new Set(shown.flatMap((i) => i.streams))].slice(0, STREAMS_MAX);
    const got = await J.runChild({ manager: await getManager(), workerId: jobId, worktree: cwd, model: lv.scrub_model, capUsd: lv.scrub_cost_cap_usd, wallMs: lv.scrub_wall_s * 1000, prompt: promptFor(briefFile), label: 'scrub job' });
    if (got.error) throw got.error;
    out.cost = got.cost;
    const bad = J.costError(got.cost, lv.scrub_cost_cap_usd, 'scrub job');
    if (bad) throw bad;
    const parsed = J.parseList(got.text, 'scrub');
    if (parsed.error) throw J.coded('E_ARGS', parsed.error);
    const applied = await core.memory.scrubApply({ scrub: parsed.list, scope: ids, ...(evidence.head_sha ? { head_sha: evidence.head_sha } : {}), ...(evidence.worktree ? { worktree: abs(evidence.worktree) } : {}), evidence_files: files });
    out.result = { mode: applied.mode, counts: applied.counts, refused: applied.refused.map((r) => ({ id: r.id, code: r.code })) };
    const handled = parsed.list.length;
    await J.receipt(core, { kind: 'scrub_job', ok: true, ...base, row_ids: ids, message: `${applied.mode}: applied ${applied.counts.applied}, proposed ${applied.counts.proposed}, refused ${applied.counts.refused} of ${handled} entries for ${ids.length} items; cost $${got.cost.toFixed(4)}` });
    if (applied.alarm) {
      out.alarm = applied.alarm;
      const holdIds = [...applied.applied, ...applied.proposed].filter((r) => r.action === 'hold').map((r) => r.id);
      await J.receipt(core, { kind: 'scrub_alarm', ok: true, ...base, row_ids: holdIds, message: `a scrub of run ${runId} made ${applied.alarm.holds} hold marks, over the ${applied.alarm.limit} that is normal; look before the archive reviewer runs (belay memory proposals)` });
    }
  } catch (e) {
    out.error = { code: J.codeOf(e), message: String((e && e.message) || e).slice(0, 300) };
    out.owed.push(...ids);
    await J.receipt(core, { kind: 'scrub_job', ...base, ...J.failFields(e) });
    await owe(core, runId, ids, e, jobId);
  }
  return out;
}

module.exports = { runScrub, buildBrief, promptFor, pickEvidence, JOB_PREFIX };
