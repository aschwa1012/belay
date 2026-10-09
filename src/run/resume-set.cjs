'use strict';
// resume-set.cjs — build step 6i-2 design item 1 (ADR 0023 amendment 4 decisions 1 and 2). A pure
// function: no store, no process, just the run's paused worker rows and the run row's own recorded
// `pause_parks`, classified by equality — never by comparing two processes' clocks (amendment 4's whole
// point, R1/V1: 6i's `paused_at >= run.paused_at` does not hold across the run and worker processes).

function pairEqual(recorded, row) {
  return !!recorded && recorded.paused_at === row.paused_at && recorded.paused_by === row.paused_by;
}

function findByWorkerId(list, workerId) {
  return (Array.isArray(list) ? list : []).find((e) => e.worker_id === workerId) || null;
}

// `rows`: the run's current worker rows reading `paused` (each needs `id`, `paused_at`, `paused_by`).
// `pauseParks`: the run row's own `pause_parks` — `{ parked, already_parked, unconfirmed }`, or
// null/undefined when this pause (or a legacy one carried by `run.attach`) recorded nothing.
// Returns `{ resume: [worker_id, ...], left_parked: [{ worker_id, reason, paused_by }, ...] }`, `reason`
// one of amendment 4 decision 2's table: 'already_parked', 're_paused', 'park_unconfirmed', 'not_this_pause'.
function classifyResumeSet(rows, pauseParks) {
  const resume = [];
  const left_parked = [];
  if (pauseParks == null) {
    // Decision 1's fourth bullet: a run row read with pause_parks null while paused resumes nothing at
    // all, and never guesses which row was this pause's own.
    for (const w of rows) left_parked.push({ worker_id: w.id, reason: 'park_unconfirmed', paused_by: w.paused_by });
    return { resume, left_parked };
  }
  for (const w of rows) {
    const pair = { paused_at: w.paused_at, paused_by: w.paused_by };
    const parked = findByWorkerId(pauseParks.parked, w.id);
    if (parked) {
      if (pairEqual(parked, pair)) resume.push(w.id);
      else left_parked.push({ worker_id: w.id, reason: 're_paused', paused_by: w.paused_by });
      continue;
    }
    const already = findByWorkerId(pauseParks.already_parked, w.id);
    if (already) {
      left_parked.push({ worker_id: w.id, reason: pairEqual(already, pair) ? 'already_parked' : 're_paused', paused_by: w.paused_by });
      continue;
    }
    if ((pauseParks.unconfirmed || []).includes(w.id)) {
      left_parked.push({ worker_id: w.id, reason: 'park_unconfirmed', paused_by: w.paused_by });
      continue;
    }
    left_parked.push({ worker_id: w.id, reason: 'not_this_pause', paused_by: w.paused_by });
  }
  return { resume, left_parked };
}

// item a (blocking, R-review) + R12: `doPause` builds `pause_parks` from each receipt's own pair here —
// never a fresh row re-read, which a hand resume + re-pause racing a later park could show instead
// (amendment 4 decision 1: the run process's clock and the worker adapter's do not keep causal order).
//
// fixer-c regression (reviewer-2, 6i-2 second review): a hand pause by another identity, in flight when
// this pause's own `pauseWorker` call for the same worker reaches it, shares that operation
// (lifecycle.cjs's `runOp` shares a same-name op's promise) — the receipt that comes back is the hand
// pause's own: `success: true`, `already: false`, `paused_by` the other identity, never `by`. `already:
// false` alone is therefore not "this pause's own park": only a receipt whose `paused_by` equals `by`
// (doPause's own `<role>:<pid>`, the same string control.cjs stamps for a park this pause itself makes,
// src/run/control.cjs:69) goes in `parked`; every other successful receipt — `already: true` or a
// `paused_by` that is not `by` — goes in `already_parked` with the receipt's own pair, never `parked`.
function buildParks(outcomes, alreadyParkedRows, by) {
  const pairFromReceipt = (o) => ({ worker_id: o.worker_id, paused_at: o.receipt.paused_at, paused_by: o.receipt.paused_by });
  const ok = [...outcomes.values()].filter((o) => o.ok);
  const already = alreadyParkedRows.map((w) => ({ worker_id: w.id, paused_at: w.paused_at, paused_by: w.paused_by }));
  const notAlready = ok.filter((o) => !o.receipt.already);
  const isOwn = (o) => o.receipt.paused_by === by;
  return {
    parked: notAlready.filter(isOwn).map(pairFromReceipt),
    already_parked: [
      ...already,
      ...ok.filter((o) => o.receipt.already).map(pairFromReceipt),
      ...notAlready.filter((o) => !isOwn(o)).map(pairFromReceipt),
    ],
    unconfirmed: [...outcomes.values()].filter((o) => !o.ok).map((o) => o.worker_id),
  };
}

module.exports = { classifyResumeSet, buildParks };
