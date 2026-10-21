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

module.exports = { notesDefaults, NOTE_TYPE };
