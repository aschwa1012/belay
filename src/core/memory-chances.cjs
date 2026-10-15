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

const ROUTES = ['index', 'search', 'retrieve'];
const SHOWN_ROUTES = ['search', 'retrieve'];
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
  const ev = recordEventSync(E, caller, { kind: 'notes_applied', worker_id: caller.worker_id, task_id: taskId, row_ids: ids, message: JSON.stringify({ count: ids.length }) });
  return { ids, recorded: true, event_id: ev.id, seq: ev.seq };
}

function checkShown(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > SHOWN_MAX) throw err('E_ARGS', `memory.recordChances shown must be an array of at most ${SHOWN_MAX} { route, ids }`, { field: 'shown' });
  return list.map((s, i) => {
    if (!s || typeof s !== 'object' || !SHOWN_ROUTES.includes(s.route) || !Array.isArray(s.ids) || s.ids.length > IDS_MAX || s.ids.some(x => !validId(x))) {
      throw err('E_ARGS', `memory.recordChances shown[${i}] must be { route: ${SHOWN_ROUTES.join(' | ')}, ids: [memory ids], at? }`, { field: 'shown', index: i });
    }
    if (s.at !== undefined && !Number.isInteger(s.at)) throw err('E_ARGS', `memory.recordChances shown[${i}].at must be an integer time in ms`, { field: 'shown', index: i });
    return { route: s.route, ids: s.ids, at: s.at };
  });
}
function checkFiles(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > FILES_MAX || list.some(x => !isStr(x))) throw err('E_ARGS', `memory.recordChances changed_files must be an array of at most ${FILES_MAX} paths`, { field: 'changed_files' });
  return [...new Set(list.map(fold).filter(Boolean))];
}

function chanceOut(r) {
  const m = parse(r.message) || {};
  const ids = parse(r.row_ids) || [];
  return { id: r.id, seq: Number(r.seq), task_id: r.task_id, run_id: r.run_id, worker_id: r.worker_id, note_id: ids[0] || null, recorded_at: r.written_at, ...m };
}

// The deliveries of one task, before the notes behind them are looked up: [{ id, route, slot, size, at, worker_id }].
function deliveriesOf(E, task, shown) {
  const out = [];
  const seen = new Set();
  const push = (d) => { const k = `${d.id}|${d.route}`; if (!seen.has(k)) { seen.add(k); out.push(d); } };
  const evs = E.store.p("SELECT row_ids, worker_id, written_at FROM memory_event WHERE kind = 'index_injected' AND ok = 1 AND run_id = ? AND task_id = ? ORDER BY seq").all(task.run_id, task.id);
  for (const ev of evs) {
    const ids = parse(ev.row_ids);
    if (Array.isArray(ids)) ids.forEach((id, i) => push({ id, route: 'index', slot: i + 1, size: ids.length, at: ev.written_at, worker_id: ev.worker_id }));
  }
  for (const s of shown) s.ids.forEach((id, i) => push({ id, route: s.route, slot: i + 1, size: s.ids.length, at: s.at == null ? null : s.at, worker_id: null }));
  return out;
}

// memory.recordChances { task_id, shown?: [{ route: 'search'|'retrieve', ids, at? }], changed_files?: [paths], worker_id? }.
// Harness only (the run manager, at task end). Once per task: a task that already has chance or changed-file events
// answers them with `already: true` and writes nothing.
async function recordChances(E, caller, args) {
  if (!isStr(args.task_id)) throw err('E_ARGS', 'memory.recordChances needs a task_id');
  const task = rows.current(E.store, 'task', args.task_id);
  if (!task) throw err('E_NOT_FOUND', `no task row exists for ${args.task_id}`, { task_id: args.task_id });
  if (caller.role === 'orchestrator' && caller.run_id !== task.run_id) throw err('E_ROLE', `task ${task.id} belongs to run ${task.run_id}, not this caller's run`, { task_id: task.id });
  const lv = leversOf(E, task.run_id);
  const sink = sinkOf(lv);
  if (sink === 'off') throw err('E_LEVER_OFF', 'memory.recordChances needs the run\'s memory.notes_sink lever on (record or penalty), and this run has it off', { lever: 'notes_sink' });
  const shown = checkShown(args.shown);
  const changed = checkFiles(args.changed_files);
  const out = E.store.tx(() => {
    const prior = E.store.p("SELECT * FROM memory_event WHERE task_id = ? AND kind IN ('note_chance', 'note_changed') ORDER BY seq").all(task.id);
    if (prior.length) return { task_id: task.id, run_id: task.run_id, already: true, written: 0, chances: prior.filter(r => r.kind === 'note_chance').map(chanceOut), changed: null };

    const project = (E.store.p('SELECT project FROM run WHERE id = ? ORDER BY seq DESC LIMIT 1').get(task.run_id) || {}).project;
    const ns = project ? `project/${project}` : null;
    const delivered = deliveriesOf(E, task, shown);
    const ids = [...new Set(delivered.map(d => d.id))];
    const noteRows = new Map();
    if (ns && ids.length) {
      for (const r of E.store.p(`SELECT id, body FROM memory_entries WHERE type = 'note' AND namespace = ? AND id IN (${marks(ids)})`).all(ns, ...ids)) noteRows.set(r.id, parse(r.body) || {});
    }
    const opened = new Set();
    for (const s of shown) if (s.route === 'retrieve') for (const id of s.ids) opened.add(id);
    const applied = E.store.p("SELECT row_ids FROM memory_event WHERE kind = 'notes_applied' AND task_id = ? ORDER BY seq").all(task.id);
    const appliedIds = new Set(applied.flatMap(r => parse(r.row_ids) || []));

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
        route: d.route, slot: d.slot, set_size: d.size, opened: opened.has(d.id) || (d.route === 'retrieve'),
        area: by.length > 0, area_by: by, used: appliedIds.has(d.id), applied_reported: applied.length > 0,
        delivered_at: d.at, sink,
      };
      const ev = recordEventSync(E, caller, {
        kind: 'note_chance', run_id: task.run_id, task_id: task.id, worker_id: d.worker_id || args.worker_id || undefined,
        key: `${task.id}:${d.id}:${d.route}`, row_ids: [d.id], message: JSON.stringify(facts),
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
        const ev = recordEventSync(E, caller, { kind: 'note_changed', run_id: task.run_id, task_id: task.id, key: task.id, row_ids: hit, message: JSON.stringify({ changed_files: changed.length }) });
        changedEv = { id: ev.id, seq: ev.seq, note_ids: hit };
      }
    }
    return { task_id: task.id, run_id: task.run_id, already: false, written: chances.length + (changedEv ? 1 : 0), chances, changed: changedEv };
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
  if (args.before != null) list = list.filter(c => (c.delivered_at == null ? c.recorded_at : c.delivered_at) < args.before);
  return { note_id: args.note_id, deliveries: list };
}

module.exports = { recordApplied, recordChances, noteDeliveries, sinkOf, ROUTES };
