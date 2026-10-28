'use strict';
// task-cycle.cjs — the walk over a task's depends_on edges (split from methods-task.cjs).

const rows = require('./rows.cjs');
const dependsOf = (task) => (Array.isArray(task && task.depends_on) ? task.depends_on : []);

// ADR 0013 §1: a model told in prose to wait does not wait, it goes looking, and what it finds is a
// person to ask. The edges are data on the task row and the refusal is computed here, so the store
// answers the question the worker would otherwise aim at the orchestrator.
//
// Acyclicity does not rest on this walk. `create` refuses a dependency that has no row, and refuses an
// id that already has one, so an edge can only ever point at a task created earlier and a cycle cannot
// be built through the only method that writes `depends_on`. The walk is the invariant stated as a
// check rather than as an argument: it fires if a row reaches the table by any other route, and it is
// what a future writer of dependency edges will have to keep passing.
function findCycle(store, id, dependsOn) {
  const edges = (taskId) => (taskId === id ? dependsOn : dependsOf(rows.current(store, 'task', taskId)));
  const path = [], onPath = new Set(), done = new Set();
  const walk = (at) => {
    if (onPath.has(at)) return [...path.slice(path.indexOf(at)), at];
    if (done.has(at)) return null;
    onPath.add(at); path.push(at);
    for (const next of edges(at)) {
      const cycle = walk(next);
      if (cycle) return cycle;
    }
    onPath.delete(at); path.pop(); done.add(at);
    return null;
  };
  return walk(id);
}

module.exports = { findCycle };
