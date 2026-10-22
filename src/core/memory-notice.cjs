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

// The compact fix, for the panel and band: the same two commands the full text names, in one line.
const SHORT = 'set one: belay settings memory.project <name> · or turn notes off: belay settings memory.notes false';

const REDACT_CODE = 'memory_redact_off';
const REDACT_TITLE = 'Memory notes are off: redaction is disabled';
const REDACT_WHY = 'A memory block with memory.redact false never writes notes, because the project namespace outlives the run and must not hold unredacted text.';
const REDACT_SHORT = 'remove "redact": false from the memory block · or turn notes off: belay settings memory.notes false';
const REDACT_LINE = '"memory": { "redact": true }';
const REDACT_FIX = 'Remove "redact": false from the memory block (or set it to true) to have notes on with the project set. To silence this: belay settings memory.notes false.';

// `block` is the memory block as written (config file's, or the spec's over it). `null` is an explicit `memory: null`
// (memory off, nothing to warn about); `undefined` or any other non-object is no block. Returns null when notes are
// explicitly off or on, else the notice that says why they are off.
function noticeFor(block) {
  if (block === null) return null;
  const b = typeof block === 'object' && !Array.isArray(block) ? block : {};
  if (b.notes === false) return null;
  if (typeof b.project === 'string' && b.project !== '') {
    if (b.redact === false && b.notes !== true) return { code: REDACT_CODE, title: REDACT_TITLE, why: REDACT_WHY, fix: REDACT_FIX, short: REDACT_SHORT, config_line: REDACT_LINE, name_rule: NAME_RULE };
    return null;
  }
  return { code: CODE, title: TITLE, why: WHY, fix: FIX, short: SHORT, config_line: FIX_LINE, name_rule: NAME_RULE };
}

const CODES = Object.freeze([CODE, REDACT_CODE]);

// The notice a code names, or null (no code, or one this build does not know).
function byCode(code) {
  if (code === CODE) return noticeFor({});
  if (code === REDACT_CODE) return noticeFor({ project: 'p', redact: false });
  return null;
}

// The notice for the run a command is about. A run answers for itself, whatever the config says now: the code its launch recorded
// (null for notes on, explicitly off, or memory null; a run from before the column has none either). The config's notice is
// only for a command with no run selected. `row` is the run row or null for no run.
function noticeForRun(row, found) {
  return row ? byCode(row.memory_notice) : noticeForConfig(found);
}

// From a discovered config ({ found, config }), as `belay doctor` and `belay status` hold it.
function noticeForConfig(found) {
  return noticeFor(found && found.found && found.config ? found.config.memory : undefined);
}

// The notice as plain lines; `prefix` marks them on a stream.
function noticeLines(n, prefix = '') {
  return [`${prefix}${n.title}.`, `${prefix}${n.why}`, `${prefix}${n.fix}`];
}

module.exports = { NAME_RULE, CODE, REDACT_CODE, CODES, byCode, noticeFor, noticeForConfig, noticeForRun, noticeLines };
