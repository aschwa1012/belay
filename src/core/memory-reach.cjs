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
// The alias `summary` is the orchestrator's alone (ADR 0047 amendment of 2026-10-22): it resolves to `summary/<project>`, where the run's decisions
// and outcomes go. A worker's `summary` stays the literal namespace, which is outside its reach.
function resolveNamespace(E, caller, ns) {
  if (ns !== 'project' && !(ns === 'summary' && caller && caller.role === 'orchestrator')) return ns;
  const p = projectOf(E, caller);
  return p ? `${ns}/${p}` : ns;
}

// A WRITE by the orchestrator on the tool channel (its reads stay unlimited): not another project's notes, and not `summary/` except through the
// alias, which names its own project's. The harness channel is not restricted (the run manager writes summaries and project copies).
function checkOrchestratorWrite(E, caller, ns, named) {
  if (!caller || caller.role !== 'orchestrator' || caller.channel === 'harness' || typeof ns !== 'string') return;
  const p = projectOf(E, caller);
  if (!p) return; // a run with no project has no notes and no alias to hold it to: the literal namespaces it has always had
  if (ns.startsWith('project/') && ns !== `project/${p}`) {
    throw err('E_ROLE', `the orchestrator writes only its own run's project (project/${p}); ${ns} is another`, { namespace: ns, role: caller.role });
  }
  if (ns.startsWith('summary/') && !(named === 'summary' && ns === `summary/${p}`)) {
    throw err('E_ROLE', `the orchestrator writes a run outcome with namespace "summary" (summary/${p}); ${ns} named directly is refused`, { namespace: ns, role: caller.role });
  }
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

module.exports = { runEmbedderMode, projectOf, resolveNamespace, reachOf, checkReach, checkOrchestratorWrite };
