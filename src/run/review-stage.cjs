'use strict';
// review-stage.cjs — the Opus 5.5 archive reviewer ("hold, then decide"), a stage of run close after the scrub. The run manager spawns
// one read-only child that clears the WHOLE held queue of the project in one spawn, with no item cap, under its wall cap and its cost
// cap (the recorded cost is the binding check). It runs when the queue has at least `review_min_held` marks, or the oldest has waited
// `review_max_age_runs` runs, or a mark targets a note a review verified, and ONLY when the lever `archive_review_auto` is true (default
// false); `belay memory review` runs it on demand with no trigger at all. It reviews EVERY held kind: `wrong`, `duplicate` (archived only
// on `same_claim: true`) and `superseded`, so a hold of an older store or of the scrubber is never stranded.
//
// The child is given each held row with both notes, the cites, and the files the cites name as they were at the mark's head commit
// (read with git, saved beside the brief). It hands back `{ "verdicts": [ ... ] }`, which memory.reviewApply checks and applies; a note
// it leaves out stays held and carries over to the next review. This stage trusts nothing in the answer.

const path = require('node:path');
const J = require('./stage-job.cjs');
const { pickEvidence } = require('./scrub-stage.cjs');

const JOB_PREFIX = 'archreview-';
const VERDICTS_PER_APPLY = 500; // checkVerdicts takes 1 to 500
const STREAMS_MAX = 50;
const FILES_MAX = 60;
const WIDE_OTHERS = 20; // other workers' streams offered per unsupported entry
const WIDE_PER_ENTRY = 25; // streams one unsupported entry may add to the evidence files
const LINE_SUFFIX = /:\d+(?:-\d+)?$/;
const abs = (p) => J.fwd(path.resolve(p));

// Why the reviewer runs, or null: the three triggers of the rulings.
function triggerOf(counts, lv) {
  if (counts.count >= lv.review_min_held) return `${counts.count} marks held (review_min_held ${lv.review_min_held})`;
  if (counts.max_runs_waited >= lv.review_max_age_runs && counts.count > 0) return `the oldest mark has waited ${counts.max_runs_waited} runs (review_max_age_runs ${lv.review_max_age_runs})`;
  if (counts.review_verified > 0) return `${counts.review_verified} mark(s) target a note a review verified`;
  return null;
}

function buildBrief({ runId, project, held, head = null }) {
  return [
    '# Archive review brief', '',
    `Run: ${runId}   Project: ${project}   Held marks: ${held.length}`,
    `Head commit for an entry with no head_sha of its own (a hold written at write time): ${head || '(none recorded)'}. Your working directory is that commit's worktree.`,
    'Each entry is one held note. "files" are the repository files the mark cites, saved as they were at the mark\'s head commit.',
    'target_review_verified = a review confirmed this note earlier: weigh a mark against it with care.',
    'For a duplicate mark, "note" and "of_note" are both given in full: archive only if they make the same claim and do not contradict (same_claim: true), else release.',
    'An entry of kind "unsupported" is a note a reviewer could not prove or disprove from one place. It carries no warning. Its "evidence" lists PATHS: the streams of the task that wrote it, the streams of the run\'s other workers, and the task\'s diff. Read them selectively with Read, Glob and Grep; do not read them whole.', '',
    '```json', JSON.stringify(held, null, 1), '```', '',
  ].join('\n');
}

function promptFor(briefFile) {
  return J.fill(J.readTemplate('archive-review-job.md'), { brief_file: briefFile });
}

// For an unsupported note: the stream files of the task that wrote it and of the run's other workers (all become citable), and the task's diff
// saved beside the brief. Paths only; the reviewer reads what it needs.
async function wideEvidence(h, ctx, dir, streams) {
  const workers = (ctx.workers || []).filter((w) => w && w.run_id === (h.note && h.note.run_id));
  const stream = (w) => abs(path.join(ctx.dataDir || '.', 'workers', w.id, 'stream.jsonl'));
  const mine = workers.filter((w) => w.task_id === (h.note && h.note.task_id));
  const others = workers.filter((w) => w.task_id !== (h.note && h.note.task_id));
  for (const w of [...mine, ...others.slice(0, WIDE_OTHERS)].slice(0, WIDE_PER_ENTRY)) streams.add(stream(w));
  const w = mine.find((x) => x.base_sha && x.head_sha && x.worktree);
  const diff = w ? await J.diffText(w.worktree, w.base_sha, w.head_sha) : '(no worker of the task has a base and head commit recorded, so there is no diff)\n';
  return {
    task_streams: mine.map((x) => ({ worker: x.id, path: stream(x) })),
    other_streams: others.slice(0, WIDE_OTHERS).map((x) => ({ worker: x.id, task: x.task_id || null, path: stream(x) })),
    diff_file: J.writeFileIn(path.join(dir, 'diffs'), `${h.held_row}.patch`, diff),
  };
}

// The files each mark cites, at its head commit, saved under `dir`. Returns the entries with a `files` list and the stream paths named.
async function withFiles(held, worktree, dir, ctx = {}) {
  const streams = new Set(); // streams that marks CITE come first; the wide evidence of unsupported entries follows, so it never crowds a cited one out
  const wide = new Set();
  let n = 0;
  const out = [];
  for (const h of held) {
    const files = [];
    let evidence = null;
    if (h.kind === 'unsupported') evidence = await wideEvidence(h, ctx, dir, wide);
    for (const c of h.cites || []) {
      if (String(c.where).startsWith('stream:')) { streams.add(abs(String(c.where).slice(7))); continue; }
      if (!h.head_sha || !worktree || n >= FILES_MAX) { files.push({ where: c.where, saved_at: null }); continue; }
      const rel = J.fwd(String(c.where).replace(LINE_SUFFIX, ''));
      if (files.some((f) => f.path === rel)) continue;
      const text = await J.fileAt(worktree, h.head_sha, rel);
      n += 1;
      files.push({ where: c.where, path: rel, saved_at: J.writeFileIn(path.join(dir, 'files'), `${h.held_row}-${files.length}.txt`, text) });
    }
    out.push({ ...h, files, ...(evidence ? { evidence } : {}) });
  }
  return { held: out, streams: [...streams, ...[...wide].filter((s) => !streams.has(s))] };
}

// opts: { core, runId, lv, dataDir, getManager, worktree, force, jobId }. Never throws; every outcome is a receipt and a returned fact.
async function runReview({ core, runId, lv, dataDir, getManager, worktree = null, force = false, fast = null, log = null, sink = null, jobId: given = null }) {
  if (!lv || !lv.notes) return { ran: false, reason: 'notes off' };
  if (!force && !lv.archive_review_auto) return { ran: false, reason: 'archive_review_auto off' }; // on demand only: `belay memory review`, or the panel's button
  if (lv.scrub_action === 'off' && !force) return { ran: false, reason: 'scrub_action off' };
  let q;
  try { q = await core.memory.reviewQueue({}); } catch (e) { return { ran: false, reason: 'queue unreadable', code: J.codeOf(e), message: String(e && e.message).slice(0, 200) }; }
  if (!q.held.length) return { ran: false, reason: 'empty queue', counts: q.counts };
  if (fast && fast()) return { ran: false, reason: 'fast close', counts: q.counts }; // the marks stay held; the next review takes them
  const why = force ? 'asked by hand' : triggerOf(q.counts, lv);
  if (!why) return { ran: false, reason: 'below the triggers', counts: q.counts };
  const limit = await J.attemptLimit(core, 'review', 'review_stage', q.held.length, q.project); // half of an overrun attempt, oldest first, down to 1
  const queued = q.held.slice(0, limit);
  const jobId = given || `${JOB_PREFIX}${runId}-${Date.now().toString(36)}`; // a caller that holds a claim names the job in it
  const out = { ran: true, job: jobId, trigger: why, counts: q.counts, queue: q.held.length, offered: queued.length };
  const base = { run_id: runId, worker_id: jobId, key: `run:${runId}` };
  const noteOverrun = async (failedJob) => {
    if (out.overrun || !J.overran(out.cost, lv.review_cost_cap_usd, failedJob)) return;
    out.overrun = { cost: out.cost, cap: lv.review_cost_cap_usd, attempted: queued.length, next: Math.max(1, Math.floor(queued.length / 2)) };
    await J.receipt(core, { kind: 'stage_overrun', ok: false, code: 'E_COST_CAP', run_id: runId, worker_id: jobId, key: 'review', row_ids: queued.map((h) => h.id), message: `the review of ${queued.length} held mark(s) cost $${Number(out.cost).toFixed(4)} against a cap of $${lv.review_cost_cap_usd}; no verdict was applied and the next attempt takes ${out.overrun.next}, oldest first; raise memory.review_cost_cap_usd to take more` });
  };
  try {
    const workers = ((await core.worker.list({})).workers) || [];
    // The directory the reviewer reads in and the head a file cite is read at come from ONE worker, so a quoted file is the file at that head.
    const samePath = (a, b) => abs(a).toLowerCase() === abs(b).toLowerCase();
    const evidence = pickEvidence(workers, runId);
    const cwd = worktree || evidence.worktree || (workers.filter((w) => w.run_id === runId && w.worktree).pop() || {}).worktree;
    const head = worktree
      ? ((workers.filter((w) => w.run_id === runId && w.head_sha && w.worktree && samePath(w.worktree, worktree)).sort((a, b) => (a.exited_at || a.last_event_at || 0) - (b.exited_at || b.last_event_at || 0)).pop() || {}).head_sha || null)
      : (evidence.worktree && cwd === evidence.worktree ? evidence.head_sha : null);
    if (!cwd) throw J.coded('E_ARGS', 'no worktree is known for the run, so the review child has nowhere to run and no commit can be read');
    const dir = path.join(dataDir, 'workers', jobId, 'inputs');
    const { held, streams } = await withFiles(queued, cwd, dir, { workers, dataDir });
    const briefFile = J.writeFileIn(dir, 'brief.md', buildBrief({ runId, project: q.project, held, head }));
    if (log) log(`run close: reviewing ${queued.length} held mark(s), at most ${lv.review_wall_s} s and $${lv.review_cost_cap_usd}`);
    const got = await J.runChild({ manager: await getManager(), workerId: jobId, worktree: cwd, model: lv.archive_review_model, capUsd: lv.review_cost_cap_usd, wallMs: lv.review_wall_s * 1000, prompt: promptFor(briefFile), label: 'archive review', fast, sink });
    out.cost = got.cost;
    if (got.survivor) out.survivor = got.survivor;
    await noteOverrun(!!got.error);
    if (got.error) throw got.error;
    const bad = J.costError(got.cost, lv.review_cost_cap_usd, 'archive review');
    if (bad) throw bad;
    const parsed = J.parseList(got.text, 'verdicts');
    if (parsed.error) throw J.coded('E_ARGS', parsed.error);
    // A hold written at write time (a refine or replacement of a verified note) has no head commit of its own, so a file cite could never be read
    // for it: the head of the worktree the reviewer worked in (named in the brief) stands for its cites. A hold with a head keeps its own.
    const tally = { verdicts: parsed.list.length, applied: 0, refused: 0 };
    const applied = [], refused = [];
    for (let i = 0; i < parsed.list.length; i += VERDICTS_PER_APPLY) {
      const r = await core.memory.reviewApply({ verdicts: parsed.list.slice(i, i + VERDICTS_PER_APPLY), worktree: abs(cwd), evidence_files: streams.slice(0, STREAMS_MAX), ...(head ? { head_sha: head } : {}) });
      tally.applied += r.counts.applied; tally.refused += r.counts.refused;
      applied.push(...r.applied.map((a) => ({ id: a.id, outcome: a.outcome, receipt: a.receipt }))); refused.push(...r.refused.map((a) => ({ id: a.id, code: a.code })));
    }
    out.result = { counts: tally, applied, refused };
    out.left_held = q.held.length - applied.length; // every mark not decided stays held and carries over
    await J.receipt(core, { kind: 'review_stage', ok: true, ...base, row_ids: applied.map((a) => a.id), message: `${why}: ${tally.verdicts} verdicts for ${queued.length} of ${q.held.length} held marks; applied ${tally.applied}, refused ${tally.refused}; cost $${got.cost.toFixed(4)}` });
  } catch (e) {
    await noteOverrun(true);
    out.error = { code: J.codeOf(e), message: String((e && e.message) || e).slice(0, 300) };
    await J.receipt(core, { kind: 'review_stage', row_ids: queued.map((h) => h.id), ...base, ...J.failFields(e) });
  }
  return out;
}

module.exports = { runReview, triggerOf, buildBrief, promptFor, JOB_PREFIX };
