'use strict';
// notes-scope-rule.cjs — the one rule for where a run's default search goes (ADR 0047 decision 6): to its project's notes when it has the
// notes lever on and a project. Pure, so the CLI can apply the same rule to a run row without loading the core's memory methods.

// The project whose notes the default search covers, from a run row's `project` column and its `memory_levers` (JSON text or object);
// null when the default search reads the run's own namespace instead.
function defaultSearchProject(projectColumn, rawLevers) {
  let lv = null;
  try { lv = typeof rawLevers === 'string' ? JSON.parse(rawLevers) : rawLevers; } catch { return null; }
  if (!lv || typeof lv !== 'object' || lv.notes !== true) return null;
  const p = (typeof projectColumn === 'string' && projectColumn) || (typeof lv.project === 'string' && lv.project) || null;
  return p;
}

module.exports = { defaultSearchProject };
