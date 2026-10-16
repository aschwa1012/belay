'use strict';
// memory-reach.cjs — which namespaces a caller may read and write (ADR 0040 §2, worker scope), and the `project`
// alias they are named through (ADR 0041 §5). A read module: every statement is a SELECT, and it requires nothing
// but the error module, so memory.index and memory.corpus can load it on the read path.
//
// The store is machine-wide. Without a reach, a worker of one run could read another run's or another project's
// memory, or plant a row there. A worker reaches its own run's namespace and its run's project, and nothing else;
// the orchestrator and the operator are not restricted (the run manager writes project copies as the orchestrator,
// and the CLI is the operator's window onto every namespace).

const { err } = require('./errors.cjs');
const { checkNamespaces } = require('./memory-note-gate.cjs');

// The run's project name is the `project` column of its run row, which run.attach set from the spec's
// `memory.project`. It is never derived from a folder, a cwd or a git remote. A store copy that predates the column,
// a caller with no run and a run with no project are all "no project", not an error.
function projectOf(E, caller) {
  if (!caller || !caller.run_id) return null;
  try {
    const r = E.store.p('SELECT project FROM run WHERE id = ? ORDER BY seq DESC LIMIT 1').get(caller.run_id);
    return r && r.project ? r.project : null;
  } catch { return null; }
}

// In any namespace argument the literal "project" means `project/<run.project>` when the caller's run has a
// project. With none it stays the literal namespace it has always been, so a run without a project reads and
// writes exactly what it did before.
function resolveNamespace(E, caller, ns) {
  if (ns !== 'project') return ns;
  const p = projectOf(E, caller);
  return p ? `project/${p}` : ns;
}

// The set of namespaces a caller reaches, or null for no limit.
function reachOf(E, caller) {
  if (!caller || caller.role !== 'worker') return null;
  return new Set([`run/${caller.run_id}`, resolveNamespace(E, caller, 'project')]);
}

// E_ROLE naming the first namespace outside the caller's reach; `verb` says what was attempted.
function checkReach(E, caller, namespaces, verb) {
  if (verb === 'read') checkNamespaces(caller, namespaces); // the lifecycle namespaces are not for a tool-channel caller (memory-note-gate.cjs)
  const reach = reachOf(E, caller);
  if (!reach) return;
  for (const ns of namespaces) {
    if (!reach.has(ns)) {
      throw err('E_ROLE', `a worker may ${verb} only its own run's namespace and its run's project (${[...reach].join(', ')}); ${ns} is neither`, { namespace: ns, allowed: [...reach], role: caller.role });
    }
  }
}

// The embedder mode of the LIVE run a worker or orchestrator caller belongs to: { live, mode, source }. With the owner's guard (the run's own
// process) the guard's mode is the truth; without it (a copy, a standalone engine) the run row's embedder_mode is (written by run.attach and by
// a resume that switches it), then the row's memory levers, then the default, required. Not live (an operator, no run attached, a run that
// ended, a store without run rows): { live: false, mode: null }.
function runEmbedderMode(E, caller) {
  const none = { live: false, mode: null, source: null };
  if (!caller || (caller.role !== 'worker' && caller.role !== 'orchestrator') || !caller.run_id) return none;
  const EM = require('./embedder-mode.cjs');
  if (E.owner && E.owner.opts && typeof E.owner.opts.embedderMode === 'function') return { live: true, mode: EM.normalize(E.embedderMode()) || EM.DEFAULT_MODE, source: 'guard' };
  let row;
  try { row = E.store.p('SELECT memory_levers, embedder_mode, ended_at FROM run WHERE id = ? ORDER BY seq DESC LIMIT 1').get(caller.run_id); } catch { return none; }
  if (!row || row.ended_at != null) return none;
  let lv = null;
  try { lv = typeof row.memory_levers === 'string' ? JSON.parse(row.memory_levers) : row.memory_levers; } catch { lv = null; }
  return { live: true, mode: EM.normalize(row.embedder_mode) || EM.normalize(lv && lv.on_embedder_failure) || EM.DEFAULT_MODE, source: 'row' };
}

module.exports = { runEmbedderMode, projectOf, resolveNamespace, reachOf, checkReach };
