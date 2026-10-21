'use strict';
// memory-notice.cjs (core) — the one source of truth for "memory notes would be on, but the run has no project, so
// they are off". `notes` defaults on (0.3.0) but notes live in a project namespace and the project is never derived
// (ADR 0041), so without `memory.project` nothing is written or injected and, before this, nothing said so. Every
// surface (`belay run`, `belay status`, `belay doctor`, `belay settings`, the panel) takes its words from here.
// Pure: it requires nothing, so a read command pays nothing for it and no embedder is reached.

const NAME_RULE = '^[a-z0-9][a-z0-9._-]{0,63}$';
const CODE = 'memory_project_unset';
const TITLE = 'Memory is off for this project';
const WHY = 'Memory notes are on by default, but they are kept per project and belay never guesses a project name, so with none set nothing is saved or recalled.';
const FIX_LINE = '"memory": { "project": "<name>" }';
const FIX = `Add ${FIX_LINE} to belay.config.json (or to the run spec), or run: belay settings memory.project <name>. A name is lowercase letters, digits, dot, underscore or dash (${NAME_RULE}). To turn notes off and silence this: belay settings memory.notes false.`;

// `block` is the memory block as written (config file's, or the spec's over it); anything else counts as no block.
// Returns null when notes are explicitly off or a project is set, else the notice.
function noticeFor(block) {
  const b = block !== null && typeof block === 'object' && !Array.isArray(block) ? block : {};
  if (b.notes === false) return null;
  if (typeof b.project === 'string' && b.project !== '') return null;
  return { code: CODE, title: TITLE, why: WHY, fix: FIX, config_line: FIX_LINE, name_rule: NAME_RULE };
}

// From a discovered config ({ found, config }), as `belay doctor` and `belay status` hold it.
function noticeForConfig(found) {
  return noticeFor(found && found.found && found.config ? found.config.memory : undefined);
}

// The notice as plain lines; `prefix` marks them on a stream.
function noticeLines(n, prefix = '') {
  return [`${prefix}${n.title}.`, `${prefix}${n.why}`, `${prefix}${n.fix}`];
}

module.exports = { NAME_RULE, CODE, noticeFor, noticeForConfig, noticeLines };
