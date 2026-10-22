'use strict';
// held-breaker.cjs — ADR 0047 amendment (2026-10-22), decision 9: the circuit breaker for a run that disputes too much. The decision is made once, at
// REPORT time, inside the report's transaction, and is written on the report entry (`withhold`, `breaker`), so no read recomputes it and a growing
// project cannot change it later. It is a write-side module: it reads the run's levers, the held rows and the project's notes, and loads no embedder.
//
// The reporting run comes from the caller (never the request). The operator's own reports (by 'operator') are exempt, and so is the archive review (it
// holds nothing through a report). A repeat report is decided afresh. `n` is the count of distinct notes this run has reported and held with withholding on in the project, this one
// included; the report withholds while n <= limit, so the (limit + 1)th note a run disputes is held and stays visible with its warning.
// limit = min(held_breaker_count, max(1, floor(held_breaker_share x live notes))): the share is rounded down and never below one note.

const { DEFAULTS } = require('./memory-levers.cjs');
const { leversOf } = require('./methods-memory.cjs');
const { bodySql } = require('./memory-note-gate.cjs');

const projectNs = (project) => `project/${project}`;

// The notes of the project the gate shows (not refuted, not superseded, not promoted or pending): a plain count.
function liveNotes(E, project) {
  const ns = projectNs(project);
  return Number(E.store.p(`SELECT COUNT(*) AS n FROM memory_entries e WHERE e.type = 'note' AND e.namespace = ? AND COALESCE(e.status, '') <> 'refuted'
    AND NOT EXISTS (SELECT 1 FROM memory_entries s WHERE s.supersedes = e.id AND +s.namespace = e.namespace) AND ${bodySql('e')}`).get(ns).n);
}

// Distinct notes OTHER than `noteId` that an active reported hold of the project holds on a report of this run that still withholds.
function otherHeldBy(E, project, runId, noteId) {
  return Number(E.store.p(`SELECT COUNT(DISTINCT json_extract(h.body, '$.note_id')) AS n FROM memory_entries h
    WHERE h.type = 'held' AND h.namespace = ? AND h.written_by = 'harness' AND json_extract(h.body, '$.state') = 'held' AND json_extract(h.body, '$.ground') = 'reported'
    AND json_extract(h.body, '$.note_id') <> ?
    AND EXISTS (SELECT 1 FROM json_each(h.body, '$.reports') r WHERE json_extract(r.value, '$.run_id') = ? AND json_extract(r.value, '$.by') <> 'operator' AND json_extract(r.value, '$.withhold') IS NOT 0)`).get(`held/${project}`, noteId, runId).n);
}

const limitOf = (lv, live) => Math.min(lv.held_breaker_count, Math.max(1, Math.floor(lv.held_breaker_share * live)));

// p: { project, note (id), by, runId }.
// Returns { withhold, breaker: { count, limit, live } | null, why }.
function decide(E, p) {
  if (p.by === 'operator' || !p.runId) return { withhold: true, breaker: null, why: 'operator report: not subject to the breaker' };
  // A repeat is decided again against the current count; the note itself is excluded from that count, so it is never counted twice.
  const o = leversOf(E, { run_id: p.runId });
  const lv = { ...DEFAULTS, ...(o && typeof o === 'object' ? o : {}) };
  const live = liveNotes(E, p.project);
  const count = otherHeldBy(E, p.project, p.runId, p.note) + 1;
  const limit = limitOf(lv, live);
  const withhold = count <= limit;
  const breaker = { count, limit, live };
  return { withhold, breaker, why: withhold ? `${count} of at most ${limit} notes this run may withhold` : `breaker: this run has disputed ${count} notes, over its limit of ${limit}; the note is held but stays visible with its warning` };
}

module.exports = { decide, liveNotes, limitOf };
