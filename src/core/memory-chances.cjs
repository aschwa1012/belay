'use strict';
// memory-chances.cjs — the delivery, area and use facts of the notes lifecycle (the sinking record; nothing here ranks).
//
// A note's CHANCE is one time belay put it in front of a worker: in the first-message index, in a memory_search
// result, or in a memory_retrieve. At task end the harness calls `memory.recordChances` with what the worker's stream
// showed (search and retrieve results); the core adds the index deliveries from its own `index_injected` receipts and
// writes one `note_chance` event per delivered note and route. The facts are recorded, never judged: `area` says the
// note names a file or term of the task, `used` says the worker listed the note in its `memory_ids`, `opened` says the
// worker retrieved the whole note. Code records these; a model or an operator decides what they mean.
//
// `memory.noteDeliveries` is the read: which tasks were shown note X, by route, before a time.
//
// Everything is gated by the run's `notes_sink` lever (`off` writes nothing; `record` and `penalty` write the same
// events, the penalty being unbuilt). A read never writes and never loads the embedding library.

const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const { validId } = require('./memory-rows.cjs');
const { recordEventSync } = require('./methods-ledger.cjs');

const SHOWN_ROUTES = ['search', 'retrieve', 'list', 'timeline'];
const ROUTES = ['index', ...SHOWN_ROUTES];
const CHANGED_MAX = 500; // note ids on one note_changed event
const FILES_MAX = 2000;
const SHOWN_MAX = 200;
const IDS_MAX = 200;

const isStr = v => typeof v === 'string' && v.length > 0;
const parse = s => { if (s == null) return null; try { return JSON.parse(s); } catch { return null; } };
const marks = list => list.map(() => '?').join(', ');

// One spelling for a path: forward slashes, no leading ./ or trailing slash, lower case.
const fold = p => String(p).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '').toLowerCase();
const related = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const overlap = (paths, others) => paths.some(a => others.some(b => related(a, b)));

function leversOf(E, runId) {
  const M = require('./methods-memory.cjs');
  const o = M.leversOf(E, { run_id: runId });
  return o && typeof o === 'object' ? o : null;
}
// The run's sink mode: 'off' unless notes is on and notes_sink says record or penalty.
function sinkOf(lv) { return lv && lv.notes === true && (lv.notes_sink === 'record' || lv.notes_sink === 'penalty') ? lv.notes_sink : 'off'; }

// The note ids a worker said it applied, written inside the release's transaction. With the sink off the ids were
// checked and nothing is stored, and the result says so (no success without effect).
function recordApplied(E, caller, prep, taskId) {
  const ids = prep.memoryIds;
  if (sinkOf(prep.lv) === 'off') return { ids, recorded: false, reason: 'memory.notes_sink is off, so the ids were checked and not stored' };
  // The facts a reader needs to exclude a citation (REPORT section 3): the notes this hand-back reported wrong, whether it
  // carried a review verdict, and whether it came after the release (the reflection turn).
  const message = JSON.stringify({ count: ids.length, reported_wrong: prep.wrong.map(w => w.id), verdict: prep.verdict || null, late: prep.late === true });
  const ev = recordEventSync(E, caller, { kind: 'notes_applied', worker_id: caller.worker_id, task_id: taskId, row_ids: ids, message });
  return { ids, recorded: true, event_id: ev.id, seq: ev.seq };
}

// A list longer than its cap is cut and the cut is counted (`dropped`, and `truncated` on every fact): one oversized
// argument never loses a task's whole record. A malformed entry is still refused by name.
function checkShown(list, dropped) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw err('E_ARGS', 'memory.recordChances shown must be an array of { route, ids }', { field: 'shown' });
  if (list.length > SHOWN_MAX) { dropped.shown = list.length - SHOWN_MAX; list = list.slice(0, SHOWN_MAX); }
  return list.map((s, i) => {
    if (!s || typeof s !== 'object' || !SHOWN_ROUTES.includes(s.route) || !Array.isArray(s.ids) || s.ids.some(x => !validId(x))) {
      throw err('E_ARGS', `memory.recordChances shown[${i}] must be { route: ${SHOWN_ROUTES.join(' | ')}, ids: [memory ids], at?, full? }`, { field: 'shown', index: i });
    }
    if (s.at !== undefined && !Number.isInteger(s.at)) throw err('E_ARGS', `memory.recordChances shown[${i}].at must be an integer time in ms`, { field: 'shown', index: i });
    if (s.full !== undefined && (!Array.isArray(s.full) || s.full.some(x => !validId(x)))) throw err('E_ARGS', `memory.recordChances shown[${i}].full must be an array of memory ids`, { field: 'shown', index: i });
    let ids = s.ids;
    if (ids.length > IDS_MAX) { dropped.ids = (dropped.ids || 0) + ids.length - IDS_MAX; ids = ids.slice(0, IDS_MAX); }
    return { route: s.route, ids, at: s.at, full: s.full || [] };
  });
}
function checkFiles(list, dropped) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.some(x => !isStr(x))) throw err('E_ARGS', 'memory.recordChances changed_files must be an array of paths', { field: 'changed_files' });
  const all = [...new Set(list.map(fold).filter(Boolean))];
  if (all.length > FILES_MAX) { dropped.changed_files = all.length - FILES_MAX; return all.slice(0, FILES_MAX); }
  return all;
}

function chanceOut(r) {
  const m = parse(r.message) || {};
  const ids = parse(r.row_ids) || [];
  return { id: r.id, seq: Number(r.seq), task_id: r.task_id, run_id: r.run_id, worker_id: r.worker_id, note_id: ids[0] || null, recorded_at: r.written_at, ...m };
}

// The deliveries of one task, before the notes behind them are looked up: [{ id, route, slot, size, at, worker_id }].
function deliveriesOf(E, task, workerId, shown) {
  const out = [];
  const seen = new Set();
  const push = (d) => { const k = `${d.id}|${d.route}`; if (!seen.has(k)) { seen.add(k); out.push(d); } };
  const evs = E.store.p("SELECT row_ids, worker_id, written_at FROM memory_event WHERE kind = 'index_injected' AND ok = 1 AND run_id = ? AND task_id = ? AND worker_id = ? ORDER BY seq").all(task.run_id, task.id, workerId);
  for (const ev of evs) {
    const ids = parse(ev.row_ids);
    if (Array.isArray(ids)) ids.forEach((id, i) => push({ id, route: 'index', slot: i + 1, size: ids.length, at: ev.written_at, worker_id: ev.worker_id }));
  }
  for (const s of shown) s.ids.forEach((id, i) => push({ id, route: s.route, slot: i + 1, size: s.ids.length, at: s.at == null ? null : s.at, worker_id: workerId }));
  return out;
}

// memory.recordChances { task_id, shown?: [{ route: 'search'|'retrieve'|'list'|'timeline', ids, at? }], changed_files?: [paths], worker_id? }.
// Harness only (the run manager, at task end). `worker_id` is required: the record is of one worker's life of the task
// (index events, applied ids and chances are all scoped to it), so a retry by another worker is recorded on its own.
// Once per (task, worker): a second call answers the first one's events with `already: true` and writes nothing.
async function recordChances(E, caller, args) {
  if (!isStr(args.task_id)) throw err('E_ARGS', 'memory.recordChances needs a task_id');
  if (!isStr(args.worker_id)) throw err('E_ARGS', 'memory.recordChances needs the worker_id whose hand-back ended the task', { field: 'worker_id' });
  const task = rows.current(E.store, 'task', args.task_id);
  if (!task) throw err('E_NOT_FOUND', `no task row exists for ${args.task_id}`, { task_id: args.task_id });
  if (caller.role === 'orchestrator' && caller.run_id !== task.run_id) throw err('E_ROLE', `task ${task.id} belongs to run ${task.run_id}, not this caller's run`, { task_id: task.id });
  const lv = leversOf(E, task.run_id);
  const sink = sinkOf(lv);
  if (sink === 'off') throw err('E_LEVER_OFF', 'memory.recordChances needs the run\'s memory.notes_sink lever on (record or penalty), and this run has it off', { lever: 'notes_sink' });
  const dropped = {};
  const shown = checkShown(args.shown, dropped);
  const changed = checkFiles(args.changed_files, dropped);
  const truncated = Object.keys(dropped).length > 0;
  const out = E.store.tx(() => {
    const prior = E.store.p("SELECT * FROM memory_event WHERE task_id = ? AND worker_id = ? AND kind IN ('note_chance', 'note_changed') ORDER BY seq").all(task.id, args.worker_id);
    if (prior.length) return { task_id: task.id, run_id: task.run_id, already: true, written: 0, chances: prior.filter(r => r.kind === 'note_chance').map(chanceOut), changed: null, dropped };

    const project = (E.store.p('SELECT project FROM run WHERE id = ? ORDER BY seq DESC LIMIT 1').get(task.run_id) || {}).project;
    const ns = project ? `project/${project}` : null;
    const delivered = deliveriesOf(E, task, args.worker_id, shown);
    const ids = [...new Set(delivered.map(d => d.id))];
    const noteRows = new Map();
    if (ns && ids.length) {
      for (const r of E.store.p(`SELECT id, body FROM memory_entries WHERE type = 'note' AND namespace = ? AND id IN (${marks(ids)})`).all(ns, ...ids)) noteRows.set(r.id, parse(r.body) || {});
    }
    // opened: the worker saw the whole note, by a retrieve or by a search answer that carried the full row.
    const opened = new Set();
    for (const s of shown) { if (s.route === 'retrieve') for (const id of s.ids) opened.add(id); for (const id of s.full) opened.add(id); }
    const applied = E.store.p("SELECT row_ids, message FROM memory_event WHERE kind = 'notes_applied' AND task_id = ? AND worker_id = ? ORDER BY seq").all(task.id, args.worker_id);
    const appliedIds = new Set(applied.flatMap(r => parse(r.row_ids) || []));
    const wrongIds = new Set(applied.flatMap(r => (parse(r.message) || {}).reported_wrong || []));
    const reviewHandback = applied.some(r => (parse(r.message) || {}).verdict != null);

    const { prepareText, subjectHits } = require('./memory-index-notes.cjs');
    const owned = (Array.isArray(task.files_owned) ? task.files_owned : []).filter(isStr).map(fold);
    const prep = prepareText(typeof task.spec === 'string' ? task.spec : '');
    const chances = [];
    for (const d of delivered) {
      const body = noteRows.get(d.id);
      if (!body) continue; // not a live note of this run's project: not a note chance
      const paths = (Array.isArray(body.applies_to) ? body.applies_to : []).filter(isStr).map(fold);
      const by = [];
      if (paths.length && overlap(paths, owned)) by.push('owned');
      if (paths.length && overlap(paths, changed)) by.push('diff');
      if (subjectHits(body.subjects, prep, fold) > 0) by.push('term');
      const facts = {
        route: d.route, slot: d.slot, set_size: d.size, opened: opened.has(d.id) || d.route === 'retrieve',
        area: by.length > 0, area_by: by, used: appliedIds.has(d.id), applied_reported: applied.length > 0,
        reported_wrong: wrongIds.has(d.id), review_handback: reviewHandback, truncated,
        delivered_at: d.at, sink,
      };
      const ev = recordEventSync(E, caller, {
        kind: 'note_chance', run_id: task.run_id, task_id: task.id, worker_id: args.worker_id,
        key: `${task.id}:${args.worker_id}:${d.id}:${d.route}`, row_ids: [d.id], message: JSON.stringify(facts),
      });
      chances.push(chanceOut(E.store.p('SELECT * FROM memory_event WHERE seq = ?').get(ev.seq)));
    }

    // The changed-file fact, for a future global audit only: live notes whose applies_to paths changed in this task's diff.
    let changedEv = null;
    if (ns && changed.length) {
      const hit = [];
      for (const r of E.store.p("SELECT id, body FROM memory_entries WHERE type = 'note' AND namespace = ? AND COALESCE(status, 'unverified') <> 'refuted' LIMIT 1000").all(ns)) {
        const p = ((parse(r.body) || {}).applies_to || []).filter(isStr).map(fold);
        if (p.length && overlap(p, changed)) hit.push(r.id);
        if (hit.length >= CHANGED_MAX) break;
      }
      if (hit.length) {
        const ev = recordEventSync(E, caller, { kind: 'note_changed', run_id: task.run_id, task_id: task.id, worker_id: args.worker_id, key: `${task.id}:${args.worker_id}`, row_ids: hit, message: JSON.stringify({ changed_files: changed.length }) });
        changedEv = { id: ev.id, seq: ev.seq, note_ids: hit };
      }
    }
    return { task_id: task.id, run_id: task.run_id, already: false, written: chances.length + (changedEv ? 1 : 0), chances, changed: changedEv, dropped };
  });
  return out;
}

// memory.noteDeliveries { note_id, before?: ms } — the chances recorded for one note, oldest first, optionally only
// those delivered before a time (the delivery time when the route knew it, else the time the fact was recorded).
async function noteDeliveries(E, caller, args) {
  if (!validId(args.note_id)) throw err('E_ARGS', 'memory.noteDeliveries needs a note_id');
  if (args.before !== undefined && args.before !== null && !Number.isInteger(args.before)) throw err('E_ARGS', 'memory.noteDeliveries before must be an integer time in ms');
  let found;
  try {
    found = E.store.p("SELECT * FROM memory_event WHERE kind = 'note_chance' AND row_ids = ? ORDER BY seq").all(JSON.stringify([args.note_id]));
  } catch (e) {
    if (/no such table/i.test(String(e && e.message))) return { note_id: args.note_id, deliveries: [], table_absent: true };
    throw e;
  }
  let list = found.map(chanceOut);
  // A kept note answers for the duplicates archived into it: their deliveries are its lesson's deliveries. A chance
  // recorded for a duplicate is joined as it is (note_id the kept note, from_duplicate the archived one); a delivery
  // only the transfer kept (delivery_history) is joined when no chance covers the same task, worker and route.
  const keptRow = E.store.p("SELECT body FROM memory_entries WHERE id = ?").get(args.note_id);
  const kept = (keptRow && parse(keptRow.body)) || {};
  const taken = new Set(list.map(c => `${c.task_id}|${c.worker_id}|${c.route || 'index'}`));
  for (const m of Array.isArray(kept.merged_from) ? kept.merged_from : []) {
    if (!m || !validId(m.id)) continue;
    for (const r of E.store.p("SELECT * FROM memory_event WHERE kind = 'note_chance' AND row_ids = ? ORDER BY seq").all(JSON.stringify([m.id]))) {
      const c = chanceOut(r);
      const k = `${c.task_id}|${c.worker_id}|${c.route || 'index'}`;
      if (taken.has(k)) continue;
      taken.add(k);
      list.push({ ...c, note_id: args.note_id, from_duplicate: m.id });
    }
  }
  for (const d of Array.isArray(kept.delivery_history) ? kept.delivery_history : []) {
    if (!d || !validId(d.from)) continue;
    const k = `${d.task_id}|${d.worker_id}|${d.route || 'index'}`;
    if (taken.has(k)) continue;
    taken.add(k);
    list.push({ id: null, seq: null, task_id: d.task_id, run_id: d.run_id, worker_id: d.worker_id, note_id: args.note_id, ...(d.from === args.note_id ? {} : { from_duplicate: d.from }), route: d.route || 'index', delivered_at: d.at, recorded_at: d.at, used: false, from_history: true });
  }
  // A hand-back after the record (the reflection turn) can still cite the note: join those later ids on read.
  const later = new Map();
  for (const c of list) {
    const k = `${c.task_id}|${c.worker_id}`;
    if (!later.has(k)) later.set(k, E.store.p("SELECT seq, row_ids FROM memory_event WHERE kind = 'notes_applied' AND task_id = ? AND worker_id = ?").all(c.task_id, c.worker_id));
    c.used_after_record = later.get(k).some(a => Number(a.seq) > c.seq && (parse(a.row_ids) || []).includes(c.note_id));
  }
  if (args.before != null) list = list.filter(c => (c.delivered_at == null ? c.recorded_at : c.delivered_at) < args.before);
  return { note_id: args.note_id, deliveries: list };
}

module.exports = { recordApplied, recordChances, noteDeliveries, sinkOf, ROUTES };
