'use strict';
// memory-nominate.cjs — nomination of a note for promotion to an instruction file (CLAUDE.md), by code, from facts.
//
// A live note is NOMINATED when its independent sightings span 3 or more distinct tasks across 2 or more distinct runs.
// A sighting is independent when its writer had not been shown the note beforehand: not by the first-message index, not
// by a search result, not by a retrieve. The facts come from the note's own sightings (`seen_in`, including the ones
// transferred from archived duplicates), from its author, and from the `note_chance` records (`memory.noteDeliveries`,
// which also answers for the duplicates archived into the note). The same writer in the same task counts once.
//
// The author counts as the first sighting: a writer cannot have been shown a note that did not exist yet. A sighting
// whose write time is unknown (it was handed over by a duplicate that merged other sightings) is dated by when it was
// recorded, which is later than the write: a delivery between the two excludes it. That can only lose a nomination, never
// make one.
//
// A nomination is a harness row in nomination/<project> (type nomination). It is never edited into a new meaning: a
// rejected nomination stays as it is, and a later one is a new row that points back at it. Nothing here judges: the
// scrubber drafts the rule, the operator decides (methods-memory-promote-note.cjs).

const L =require('./memory-lifecycle.cjs');
const C = require('./lifecycle-common.cjs');
const { parse } = require('./memory-facts.cjs');
const { noteDeliveries, sinkOf } = require('./memory-chances.cjs');
const { leversOf } = require('./methods-memory.cjs');

const MIN_TASKS = 3, MIN_RUNS = 2;
const LIST_MAX = 200;
const SIGHTINGS_KEEP = 30;

const nominationNs = project => L.nsOf('nomination', project);
const keyOf = (task, writer) => `${task}|${writer}`;
const workerOf = writer => (typeof writer === 'string' && writer.startsWith('worker:') ? writer.slice('worker:'.length) : null);

// Why a live note is not a candidate at all (its state, not its sightings).
function notCandidate(row, b) {
  if (b.promoted_to) return 'promoted';
  if (b.held) return 'held';
  if (b.superseded_by) return 'superseded';
  if ((row.status || 'unverified') === 'refuted') return 'refuted';
  return null;
}

// The write time of the pending row a sighting came from, when that row is still there and is the same writer's.
function writtenAt(E, s) {
  if (s.transferred_from) {
    const r = E.store.p('SELECT created_at, task_id, written_by FROM memory_entries WHERE id = ?').get(s.transferred_from);
    if (r && r.task_id === s.task_id && r.written_by === s.written_by) return r.created_at;
  }
  return typeof s.at === 'number' ? s.at : Infinity;
}

// The independent sightings of one note: { sightings, excluded, tasks, runs, keys }. `row` is the note's row
// (id, task_id, run_id, written_by, created_at, body) and `deliveries` is memory.noteDeliveries' list for it.
function countSightings(E, row, deliveries) {
  const b = parse(row.body) || {};
  const candidates = [];
  if (row.task_id && row.run_id && row.written_by) candidates.push({ task_id: row.task_id, run_id: row.run_id, writer: row.written_by, via: 'author', at: row.created_at, shown: false });
  for (const s of Array.isArray(b.seen_in) ? b.seen_in : []) {
    if (!s || !s.task_id || !s.run_id || !s.written_by) continue;
    candidates.push({
      task_id: s.task_id, run_id: s.run_id, writer: s.written_by, via: s.transferred_from ? 'transferred' : 'seen_in',
      ...(s.transferred_from ? { transferred_from: s.transferred_from } : {}), at: writtenAt(E, s), shown: s.in_index_beforehand === true,
    });
  }
  const seen = new Set(), known = new Set(), sightings = [], excluded = [], unrecorded = [];
  const recorded = new Map();
  const sinkOn = run => {
    if (!recorded.has(run)) recorded.set(run, sinkOf(leversOf(E, { run_id: run })) !== 'off');
    return recorded.get(run);
  };
  for (const c of candidates) {
    const key = keyOf(c.task_id, c.writer);
    if (seen.has(key)) continue; // the same writer in the same task counts once, the first record deciding
    seen.add(key);
    const wid = workerOf(c.writer);
    let why = null;
    // A writer who authored the note, or already holds a sighting of it, knows it for every later sighting.
    if (known.has(c.writer)) why = 'earlier_sighting';
    known.add(c.writer);
    // A run that did not record full delivery facts (notes_sink off) cannot show a sighting independent: not counted.
    if (!why && !sinkOn(c.run_id)) { unrecorded.push({ key, task_id: c.task_id, writer: c.writer, run_id: c.run_id }); continue; }
    if (!why && c.shown) why = 'index';
    if (!why && wid) {
      // By writer, in any task, at or before the write. A delivery with no time is taken as before it.
      const d = deliveries.find(x => x.worker_id === wid && (x.delivered_at == null || x.delivered_at <= c.at));
      if (d) why = d.route || 'index';
    }
    if (!why && wid && indexShown(E, row.id, c.run_id, wid, c.at)) why = 'index';
    if (why) { excluded.push({ key, task_id: c.task_id, writer: c.writer, shown_by: why }); continue; }
    sightings.push({ key, task_id: c.task_id, run_id: c.run_id, writer: c.writer, via: c.via, ...(c.transferred_from ? { transferred_from: c.transferred_from } : {}) });
  }
  return {
    sightings, excluded, unrecorded, keys: sightings.map(s => s.key),
    tasks: new Set(sightings.map(s => s.task_id)).size, runs: new Set(sightings.map(s => s.run_id)).size,
  };
}

// Did an index receipt of this run and worker list the note at or before the write? Recorded whatever the sink says.
function indexShown(E, noteId, runId, workerId, at) {
  let evs;
  try { evs = E.store.p("SELECT row_ids FROM memory_event WHERE kind = 'index_injected' AND ok = 1 AND run_id = ? AND worker_id = ? AND written_at <= ?").all(runId, workerId, at); } catch { return false; }
  return evs.some(ev => { try { return JSON.parse(ev.row_ids).includes(noteId); } catch { return false; } });
}

const meets = c => c.tasks >= MIN_TASKS && c.runs >= MIN_RUNS;

async function countFor(E, row) {
  const d = await noteDeliveries(E, null, { note_id: row.id });
  return countSightings(E, row, d.deliveries);
}

// The newest nomination row for each note of a project: Map(note_id → { id, created_at, body }).
function latestByNote(E, project, only) {
  const rows = E.store.p(`SELECT id, created_at, body FROM memory_entries WHERE namespace = ? AND type = 'nomination'${only ? " AND json_extract(body, '$.note_id') = ?" : ''} ORDER BY created_at DESC, rowid DESC LIMIT 5000`).all(nominationNs(project), ...(only ? [only] : []));
  const out = new Map();
  for (const r of rows) {
    const body = parse(r.body) || {};
    if (body.note_id && !out.has(body.note_id)) out.set(body.note_id, { id: r.id, created_at: r.created_at, body });
  }
  return out;
}

// memory.nominate {} — harness call. Counts the project's live notes and writes a nomination row for each that has
// reached the bar and is not nominated, promoted, or rejected-without-news. Returns every row it wrote.
async function nominate(E, caller, args) {
  C.needHarness(caller, 'memory.nominate');
  C.allowKeys(args, [], 'memory.nominate');
  const { project, runId } = C.notesContext(E, caller, 'memory.nominate');
  const live = E.store.p("SELECT id, task_id, run_id, written_by, created_at, status, body FROM memory_entries WHERE type = 'note' AND namespace = ?").all(`project/${project}`);
  const last = latestByNote(E, project);
  const nominated = [], skipped = [];
  for (const row of live) {
    const b = parse(row.body) || {};
    if (((b.seen_in || []).length + 1) < MIN_TASKS) continue; // cannot reach three tasks
    const why = notCandidate(row, b);
    if (why) { skipped.push({ id: row.id, reason: why }); continue; }
    const prior = last.get(row.id);
    if (prior && (prior.body.state === 'nominated' || prior.body.state === 'promoted')) { skipped.push({ id: row.id, reason: prior.body.state }); continue; }
    const counted = await countFor(E, row);
    if (!meets(counted)) continue;
    if (prior && prior.body.state === 'rejected') {
      const had = new Set(prior.body.rejected && prior.body.rejected.keys || []);
      if (!counted.keys.some(k => !had.has(k))) { skipped.push({ id: row.id, reason: 'rejected, and no new independent sighting since' }); continue; }
    }
    const out = E.store.tx(() => {
      const r = C.putRow(E, caller, {
        ns: nominationNs(project), type: 'nomination', runId,
        text: `nomination: ${row.id} seen in ${counted.tasks} tasks across ${counted.runs} runs (run ${runId})`,
        title: `nomination: ${row.id}`,
        body: {
          state: 'nominated', note_id: row.id, run_id: runId, at: Date.now(), previous: prior ? prior.id : null,
          counts: { tasks: counted.tasks, runs: counted.runs, sightings: counted.sightings.length, excluded: counted.excluded.length, unrecorded: counted.unrecorded.length },
          sightings: counted.sightings.slice(-SIGHTINGS_KEEP), excluded: counted.excluded.slice(-SIGHTINGS_KEEP), keys: counted.keys,
        },
      });
      return C.rowOut(E, r.id);
    });
    nominated.push(out);
  }
  if (nominated.length) E.noteWrite();
  return { project, run_id: runId, considered: live.length, nominated, skipped };
}

// The drafts stored for a note since a time: draft rows and, in propose mode, the scrubber's draft proposals. Newest first.
function draftsFor(E, project, noteId, since) {
  const out = [];
  for (const r of E.store.p("SELECT id, created_at, body FROM memory_entries WHERE namespace = ? AND type = 'draft' AND json_extract(body, '$.note_id') = ? AND created_at >= ?").all(L.nsOf('draft', project), noteId, since || 0)) {
    const b = parse(r.body) || {};
    if (b.rule && b.target) out.push({ source: 'draft', id: r.id, at: r.created_at, rule: b.rule, target: b.target });
  }
  for (const r of E.store.p("SELECT id, created_at, body FROM memory_entries WHERE namespace = ? AND type = 'proposal' AND json_extract(body, '$.note_id') = ? AND json_extract(body, '$.entry.action') = 'draft' AND created_at >= ?").all(L.nsOf('proposal', project), noteId, since || 0)) {
    const e = (parse(r.body) || {}).entry || {};
    if (e.draft && e.draft.rule && e.draft.target) out.push({ source: 'proposal', id: r.id, at: r.created_at, rule: e.draft.rule, target: e.draft.target });
  }
  return out.sort((a, b) => b.at - a.at);
}

// nominationsForScope(E, project) — the notes nominated and still waiting for a scrubber draft. Synchronous (a read of
// the store), so a caller may use it with or without await. Each entry: { id (the note), nomination_id, title, text,
// counts, nominated_at }. A note that is no longer live, or is held, superseded or promoted, is not asked for.
function nominationsForScope(E, project) {
  const out = [];
  for (const [noteId, n] of latestByNote(E, project)) {
    if (n.body.state !== 'nominated') continue;
    const note = E.store.p('SELECT id, namespace, title, text, status, body FROM memory_entries WHERE id = ?').get(noteId);
    if (!note || note.namespace !== `project/${project}`) continue;
    if (notCandidate(note, parse(note.body) || {})) continue;
    if (draftsFor(E, project, noteId, n.created_at).length) continue;
    out.push({ id: noteId, nomination_id: n.id, title: note.title, text: note.text, counts: n.body.counts, nominated_at: n.created_at });
  }
  return out.sort((a, b) => a.nominated_at - b.nominated_at || (a.id < b.id ? -1 : 1)).slice(0, LIST_MAX);
}

// The nominations of one project, or of every project: the newest row per note, with the drafts stored for it. Open
// nominations only unless `all`. Newest first, at most LIST_MAX.
function listNominations(E, project, all) {
  const rows = E.store.p(`SELECT id, namespace, run_id, created_at, body FROM memory_entries WHERE type = 'nomination' AND ${project ? 'namespace = ?' : "namespace LIKE 'nomination/%'"} ORDER BY created_at DESC, rowid DESC LIMIT 5000`).all(...(project ? [nominationNs(project)] : []));
  const seen = new Set(), out = [];
  for (const r of rows) {
    const body = parse(r.body) || {};
    const p = r.namespace.slice('nomination/'.length);
    const k = `${p}|${body.note_id}`;
    if (!body.note_id || seen.has(k)) continue;
    seen.add(k);
    if (!all && body.state !== 'nominated') continue;
    const note = E.store.p('SELECT namespace, status, body FROM memory_entries WHERE id = ?').get(body.note_id);
    const note_state = !note ? 'missing' : note.namespace !== `project/${p}` ? `in ${note.namespace}` : (notCandidate(note, parse(note.body) || {}) || 'live');
    out.push({ id: r.id, project: p, run_id: r.run_id, created_at: r.created_at, body, note_state, drafts: draftsFor(E, p, body.note_id, r.created_at) });
    if (out.length >= LIST_MAX) break;
  }
  return out;
}

module.exports = { listNominations, nominate, nominationsForScope, countSightings, countFor, latestByNote, draftsFor, nominationNs, notCandidate, MIN_TASKS, MIN_RUNS };
