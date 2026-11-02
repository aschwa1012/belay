'use strict';
// memory-search-scope.cjs — the default scope of memory.search for a run that has the notes lever on (ADR 0047
// decision 6): the run's project namespace, and only notes. A caller who names a scope keeps it: `namespace` or
// `namespaces` is taken as given, and a filter that states `types` is not widened or narrowed. With notes off,
// no project, or no run (the operator's CLI), nothing here applies and the search is what it always was.
// A read: every statement is a SELECT.

const { leversOf, projectOf } = require('./methods-memory.cjs');

const NOTE_TYPE = 'note';

// { args, filter } to search with: `args` may gain `namespace: 'project'` (resolved by the caller's reach to
// project/<p>), `filter` may gain types ['note']. Returns the inputs unchanged when the default does not apply.
function notesDefaults(E, caller, args, filter) {
  if (!caller || !caller.run_id || (caller.role !== 'worker' && caller.role !== 'orchestrator')) return { args, filter }; // the operator's window is not scoped
  const lv = leversOf(E, caller);
  if (!lv || lv.notes !== true || !projectOf(E, caller)) return { args, filter };
  const named = (args.namespace !== undefined && args.namespace !== null) || (args.namespaces !== undefined && args.namespaces !== null);
  if (named) return { args, filter };
  if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) return { args, filter }; // a malformed filter is refused by filterSql, not hidden
  return { args: { ...args, namespace: 'project' }, filter: filter.types === undefined ? { ...filter, types: [NOTE_TYPE] } : filter };
}

// Whether the default search of run `runId` leaves out the run's own namespace (it goes to the project's notes: notesDefaults' own rule). A turn
// row of such a run is read by the briefing, not by a default search, so a heavy tier does not embed it (ADR 0044 amendment of 2026-11-02).
function defaultSearchSkipsRun(E, runId) {
  return notesDefaults(E, { run_id: runId, role: 'orchestrator' }, {}, {}).args.namespace === 'project';
}

// A predicate over a memory row (type and namespace): true for a turn row a heavy tier leaves out. One answer per run.
function heavyExemptFn(E) {
  const memo = new Map();
  return (r) => {
    if (r.type !== 'turn' || typeof r.namespace !== 'string' || !r.namespace.startsWith('run/')) return false;
    const id = r.namespace.slice(4);
    if (!memo.has(id)) memo.set(id, defaultSearchSkipsRun(E, id));
    return memo.get(id);
  };
}

module.exports = { notesDefaults, defaultSearchSkipsRun, heavyExemptFn, NOTE_TYPE };
