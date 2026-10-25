'use strict';
// run-levers.cjs — ADR 0031 decisions 3, 5 and 6: the two run-spec levers (`max_fix_rounds`,
// `fix_cutoff`), their substitution into the orchestrator's prompt text, and the receipt's
// `review_rounds` audit. Used only by cmd-run.cjs.

const fs = require('node:fs');
const path = require('node:path');
const CP = require('../run/compaction.cjs');
const ML = require('../run/memory-levers.cjs');
const MN = require('../core/memory-notice.cjs'); // pure; the shared wording of the no-project notice

const FIX_CUTOFFS = ['orchestrator', 'cap-only'];
const DEFAULT_MAX_FIX_ROUNDS = 2;
const DEFAULT_FIX_CUTOFF = 'orchestrator';
const EM = require('../core/embedder-mode.cjs');
const DEFAULT_ON_EMBEDDER_FAILURE = EM.DEFAULT_MODE; // ADR 0034 decision 2, amendment 1
const MEMORY_RULES_FILE = path.join(__dirname, '..', 'run', 'prompts', 'memory-rules.md');
// The one sentence that asks the orchestrator for `memory_queries`. Its only reader is the first-message index
// (memory-preface.cjs), so it is told to the orchestrator only when that lever is on; off, the placeholder is ''
// and the prompt asks for nothing the run never reads.
const MEMORY_REPORT_LINE = ' If a note is wrong, out of date or contradicted by the evaluation of a task or the code, report it with `mcp__belay__memory_report` and say why (it holds the note for the archive review); you need not wait for the operator.';
// ADR 0047 amendment (2026-10-22), decision 7: in a notes run the orchestrator's memory bullet says four things, and a run outcome is a summary. The
// template keeps the text a run without notes always had, between {{memory_use}} ... {{/memory_use}} (and {{memory_outcome}} ... {{/memory_outcome}}); a run
// with notes replaces the span, a run without drops only the markers, so its prompt is byte for byte what it was.
const MEMORY_USE_NOTES = [
  "- Use belay's notes yourself.",
  '  - Search before you plan: before you create any task, call `mcp__belay__memory_search` with a `query` on the brief\'s subject and no namespace (it searches the',
  "    project's notes) and use what it returns in your plan and prompts (empty on a first run is normal).",
  '  - Store a note only for what the code and the markdown of the project cannot tell the next run and it would trip on: `mcp__belay__memory_store` with `namespace: "project"`',
  '    and `kind`, `title`, `when`, `basis` (and `evidence` when you observed it). Nothing is the normal answer.',
  '  - Record your decisions and the outcome with `namespace: "summary"` (a `title` and `text`); they are found on demand with `mcp__belay__memory_summaries`.',
  '  - Never tell a worker to write memory with `memory_store`: what it learns that is worth keeping goes in the `notes` of its `lease_release`.',
].join('\n');
const MEMORY_OUTCOME_NOTES = 'record the outcome with `namespace: "summary"`';
const MEMORY_VERIFY_RULE = ' Use `mcp__belay__memory_verify` only with a receipt.'; // a notes run's orchestrator has no memory_verify
const MEMORY_QUERIES_LINE = ' Also give 1 to 3 `memory_queries`: task lines (each under 160 bytes) naming the situations the worker will be in, such as "add a migration" or "dedupe email addresses", not the finding you expect it to make.';

// The time-bound condition is observable only if the orchestrator is told the bound and can read elapsed time
// (the waited_ms of its worker_wait answers), so it is written in from timeout_ms and dropped when that is 0.
// `mode` is 'headless' (the default, byte-identical to before) or 'interactive' (ADR 0037 decision 4: the run
// does not end, so stop-and-surface is stop, store, tell the operator, then wait).
function cutoffRule(fixCutoff, timeoutMs, mode = 'headless') {
  if (fixCutoff === 'cap-only') return 'Do not stop fix rounds before the cap.';
  const timeCond = timeoutMs > 0
    ? `; the run's time bound (${timeoutMs} ms from its start) is near, judged from the waited_ms your worker_wait answers report`
    : '';
  const interactive = mode === 'interactive';
  const surface = interactive
    ? '(stop, record the outcome, tell the operator the open blocking findings, then wait for them)'
    : '(end the run and name the open blocking findings for the human)';
  return `You may stop fix rounds before the cap, only towards stop-and-surface ${surface}, `
    + 'and only when one of these holds: the same blocking finding '
    + 'survived a fix round; a fix round introduced a new regression; the fix needs files outside the task\'s '
    + `owned set${timeCond}. Name the condition and its evidence when you ${interactive ? 'stop' : 'close'}. Never `
    + 'extend past the cap and never report a refuted step as passing or mark it done.'
    + (timeoutMs > 0 ? '' : ' The run has no time bound.');
}

// The memory block a run uses: the config file's `memory` block as project defaults, the run spec's own block over it
// key by key. `config` is { path, memory } or null. Returns { block, sources } or { error }; `sources` names, for every
// lever, 'default', the config path or 'spec'. The merged block is validated once, by parseMemoryBlock, in parseLevers.
//
// Two settings traps (audit L23). A spec whose `memory` is an explicit null says "no memory block": every lever at its
// default, the config's block not inherited (an absent `memory` inherits it; `{}` is an empty override and inherits too). And a spec that
// turns `notes` off drops the levers it would inherit from the config that need notes (notes_reflection and the
// rest), rather than being refused for levers it never wrote; `dropped` names them. A dependent the spec itself sets is still refused.
function mergeMemory(specBlock, config) {
  if (specBlock === null) {
    const sources = {};
    for (const k of Object.keys(ML.DEFAULTS)) sources[k] = 'default';
    return { block: undefined, sources, fromConfig: false, defaultsOnly: true };
  }
  const cfg = config && config.memory !== undefined && config.memory !== null ? config.memory : null;
  if (cfg !== null && (typeof cfg !== 'object' || Array.isArray(cfg))) return { error: `${config.path}: memory must be an object` };
  if (cfg !== null) {
    const eo = require('../core/memory-levers.cjs').EVAL_ONLY.filter((k) => Object.prototype.hasOwnProperty.call(cfg, k));
    if (eo.length) return { error: `${config.path}: memory.${eo.join(', memory.')} ${eo.length > 1 ? 'are' : 'is'} eval-only (a run spec's top-level key), not a project default` };
  }
  const own = specBlock !== undefined && specBlock !== null && typeof specBlock === 'object' && !Array.isArray(specBlock) ? specBlock : null;
  if (own === null && specBlock !== undefined && specBlock !== null) return { block: specBlock, sources: null }; // not an object: parseMemoryBlock says so
  const block = { ...(cfg || {}), ...(own || {}) };
  const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  const dropped = [];
  if (cfg !== null && own !== null && own.notes === false) {
    for (;;) { // one dependent at a time: parseMemoryBlock names the first lever that needs notes
      const bad = /^memory[.]([a-z_]+) needs memory[.]notes$/.exec((ML.parseMemoryBlock(block).error) || '');
      if (!bad || has(own, bad[1]) || !has(cfg, bad[1])) break;
      delete block[bad[1]]; dropped.push(bad[1]);
    }
  }
  const sources = {};
  for (const k of Object.keys(ML.DEFAULTS)) sources[k] = has(own, k) ? 'spec' : has(cfg, k) && !dropped.includes(k) ? config.path : 'default';
  return { block: cfg === null && own === null ? undefined : block, sources, fromConfig: cfg !== null && Object.keys(cfg).length > 0, ...(dropped.length ? { dropped } : {}) };
}

// The eval-only spec keys `native_memory` (an absolute folder) and `handback_question` (boolean), both off by default. They are
// recorded as memory levers (the run row is how the worker adapter's manager learns them); a key also given inside `memory` is refused.
function evalKeys(spec) {
  const fold = {};
  const inBlock = spec.memory && typeof spec.memory === 'object' ? spec.memory : {};
  for (const k of ['native_memory', 'handback_question']) {
    if (spec[k] === undefined) continue;
    if (inBlock[k] !== undefined) return { error: `${k} is given both at the top of the spec and inside memory` };
    if (k === 'native_memory' && (typeof spec[k] !== 'string' || !spec[k])) return { error: 'native_memory must be an absolute directory path' };
    if (k === 'handback_question' && typeof spec[k] !== 'boolean') return { error: 'handback_question must be true or false' };
    fold[k] = spec[k];
  }
  return { fold: Object.keys(fold).length ? fold : null };
}

// Returns { max_fix_rounds, fix_cutoff, on_embedder_failure[, compact_at_tokens] } or { error }. `compact_at_tokens` (ADR 0007 decision 3,
// null by default) is present only when set, so a run without it has the receipt it always had.
function parseLevers(spec, opts = {}) {
  let maxFixRounds = DEFAULT_MAX_FIX_ROUNDS;
  if (spec.max_fix_rounds !== undefined) {
    const v = spec.max_fix_rounds;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
      return { error: 'max_fix_rounds must be a non-negative integer' };
    }
    maxFixRounds = v;
  }
  let fixCutoff = DEFAULT_FIX_CUTOFF;
  if (spec.fix_cutoff !== undefined) {
    if (!FIX_CUTOFFS.includes(spec.fix_cutoff)) {
      return { error: `fix_cutoff must be one of ${FIX_CUTOFFS.join(', ')}` };
    }
    fixCutoff = spec.fix_cutoff;
  }
  // ADR 0034 amendment 1: the run spec's own on_embedder_failure wins, then the memory block's, then the config file's
  // (`opts.config.memory`, discovered by the caller), then the default. The old values stop and continue are accepted as required and keyword.
  let onEmbedderFailure = DEFAULT_ON_EMBEDDER_FAILURE;
  const memGiven = spec.memory && typeof spec.memory === 'object' ? spec.memory.on_embedder_failure : undefined;
  const given = spec.on_embedder_failure !== undefined ? ['on_embedder_failure', spec.on_embedder_failure]
    : memGiven !== undefined ? ['memory.on_embedder_failure', memGiven] : null;
  if (given) {
    const m = EM.normalize(given[1]);
    if (m === null) return { error: `${given[0]} must be one of ${EM.describe()}` };
    onEmbedderFailure = m;
  } else if (spec.memory !== null && opts.config && opts.config.memory && opts.config.memory.on_embedder_failure !== undefined) { // an explicit `memory: null` inherits nothing from the config
    onEmbedderFailure = EM.normalize(opts.config.memory.on_embedder_failure) || DEFAULT_ON_EMBEDDER_FAILURE; // a bad config value is refused by parseMemoryBlock below
  }
  const out = { max_fix_rounds: maxFixRounds, fix_cutoff: fixCutoff, on_embedder_failure: onEmbedderFailure };
  const ca = CP.parseCompactAt(spec.compact_at_tokens);
  if (ca.error) return { error: ca.error };
  if (ca.value !== null) out.compact_at_tokens = ca.value;
  // ADR 0058 decision 8: off by default, and absent from the levers (and the receipt) unless the spec turns it on.
  if (spec.stop_idle_on_done !== undefined && typeof spec.stop_idle_on_done !== 'boolean') return { error: 'stop_idle_on_done must be true or false' };
  if (spec.stop_idle_on_done === true) out.stop_idle_on_done = true;
  // ADR 0054 amendment 1: the run close deletes the reviewers' scratch folders; this opt-in keeps them. Absent unless on.
  if (spec.keep_review_scratch !== undefined && typeof spec.keep_review_scratch !== 'boolean') return { error: 'keep_review_scratch must be true or false' };
  if (spec.keep_review_scratch === true) out.keep_review_scratch = true;
  // ADR 0041 decision 1: the memory block. Present on the result only when it differs from the defaults, so a
  // run without it has the levers, the receipt and the run row it always had.
  // The config's `memory` block is the project default under the spec's own (opts.config = { path, memory }).
  const ev = evalKeys(spec); // eval-only top-level keys, folded into the memory block
  if (ev.error) return { error: ev.error };
  const shapeOk = spec.memory === undefined || spec.memory === null || (typeof spec.memory === 'object' && !Array.isArray(spec.memory)); // a bad block is refused as it is alone, never folded into an object by an eval key
  const merged = mergeMemory(ev.fold && shapeOk ? { ...(spec.memory || {}), ...ev.fold } : spec.memory, spec.memory === null ? null : opts.config) // `memory: null` inherits no config, eval keys or not;
  if (merged.error) return { error: merged.error };
  const mem = ML.parseMemoryBlock(merged.block);
  if (mem.error) return { error: merged.fromConfig ? `${mem.error} (memory defaults come from ${opts.config.path}, the spec's own memory block over them)` : mem.error };
  if (mem.value.native_memory !== null) { // the spawn's own check, here at spec load, so a bad folder refuses the run before anything launches
    try { require('../run/native-memory.cjs').checkFolder(mem.value.native_memory); } catch (e) { return { error: `native_memory: ${e.message}` }; }
  }
  // on_embedder_failure is resolved above (spec top level, spec memory block, config, default) and recorded on its own: the
  // run's memory_levers never carries it, so the row cannot contradict the receipt, a config that sets only this lever does not
  // make every run row carry memory_levers, and an older core (which refuses the unknown key) still reads the block.
  const recorded = { ...mem.value }; delete recorded.on_embedder_failure;
  const supplied = (k) => (ev.fold && k in ev.fold) || (spec.memory && typeof spec.memory === 'object' && Object.prototype.hasOwnProperty.call(spec.memory, k));
  for (const k of ML.EVAL_ONLY) { // an eval-only lever nobody supplied is not recorded: a run without them has the levers, receipt and run row it always had
    if (!supplied(k)) { delete recorded[k]; if (merged.sources) delete merged.sources[k]; }
  }
  if (merged.sources) merged.sources.on_embedder_failure = given ? 'spec' : (spec.memory !== null && opts.config && opts.config.memory && opts.config.memory.on_embedder_failure !== undefined ? opts.config.path : 'default');
  if (!ML.isDefault({ ...ML.DEFAULTS, ...recorded })) {
    out.memory_levers = recorded;
    if (merged.sources) out.memory_sources = merged.sources; // each lever's origin; absent for a default block, like memory_levers
    if (mem.value.rules) {
      // Read only when the lever is on; a missing file is a refusal that names it, never a silent empty rules text.
      const file = opts.rulesFile || MEMORY_RULES_FILE;
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
        return { error: `memory.rules is true but the rules text could not be read (${file}): ${(e && e.code) || (e && e.message)}` };
      }
      Object.defineProperty(out, 'rules_text', { value: text, enumerable: false }); // not part of the receipt
    }
  }
  // Notes default on but need a project: say so when there is none. Not enumerable, so the receipt is unchanged; `belay run` prints it.
  // An explicit `memory: null` is silent, whether the spec says it or the config file does (an inherited one, unless the spec's own block overrides it).
  const off = spec.memory === null || (spec.memory === undefined && !!opts.config && opts.config.memory === null);
  Object.defineProperty(out, 'memory_notice', { value: MN.noticeFor(off ? null : merged.block), enumerable: false });
  if (merged.dropped) out.memory_dropped = merged.dropped; // config levers a spec's `notes: false` left out, so the receipt says what did not apply
  return out;
}

// The columns run.attach records for the memory levers. A default block records explicit nulls, never nothing: run.attach carries
// an absent field forward from an unended epoch (a rule meant for the orchestrator's own adapter), so a re-run over a run that
// never ended would otherwise inherit the previous run's levers and project (audit D55).
function attachMemory(levers) {
  const m = levers && levers.memory_levers;
  const memory_notice = levers && levers.memory_notice ? levers.memory_notice.code : null; // the run records its own notice (status and the panel read it)
  return m ? { memory_levers: JSON.stringify(m), project: m.project === undefined ? null : m.project, memory_notice } : { memory_levers: null, project: null, memory_notice };
}

// The receipt line's suffix, empty for a default block.
function memoryText(levers) {
  return (levers && levers.memory_levers ? `; memory_levers: ${JSON.stringify(levers.memory_levers)}` : '') + (levers && levers.memory_dropped ? `; config levers dropped by notes false: ${levers.memory_dropped.join(', ')}` : '');
}

const TRAILING_EOL = /\r?\n$/;
// The rules text with its line endings made the prompt's own, so a CRLF prompt gets no stray bare LF.
function matchEol(text, prompt) {
  const nl = prompt.includes('\r\n') ? '\r\n' : '\n';
  return text.split(/\r\n|\n/).join(nl);
}

// A prompt without a placeholder passes through unchanged.
// Returns { text, substituted: { max_fix_rounds, fix_cutoff_rule } }, the replacement counts.
// `opts.mode` is 'headless' (default) or 'interactive'; it selects the wording of the cutoff rule only.
function substituteLevers(text, levers, timeoutMs = 0, opts = {}) {
  const rule = cutoffRule(levers.fix_cutoff, timeoutMs, (opts && opts.mode) || 'headless');
  const a = String(text).split('{{max_fix_rounds}}');
  const b = a.join(String(levers.max_fix_rounds)).split('{{fix_cutoff_rule}}');
  const withRule = b.join(rule);
  // ADR 0040 decision 6: the rules text goes in only when memory.rules is on, trailing newline trimmed and
  // line endings matched to the prompt's; off, the placeholder becomes '' and the prompt is the base prompt.
  const on = !!(levers.memory_levers && levers.memory_levers.rules && levers.rules_text != null);
  const notesOn = !!(levers.memory_levers && levers.memory_levers.notes);
  const spans = { memory_use: 0, memory_outcome: 0 };
  const span = (t, name, replacement) => {
    const open = `{{${name}}}`, close = `{{/${name}}}`;
    const parts = t.split(open);
    let out = parts[0];
    for (const rest of parts.slice(1)) {
      const at = rest.indexOf(close);
      if (at < 0) { out += rest; continue; } // an unclosed marker is left as written
      spans[name] += 1;
      out += (notesOn ? replacement : rest.slice(0, at)) + rest.slice(at + close.length);
    }
    return out;
  };
  const spanned = span(span(withRule, 'memory_use', MEMORY_USE_NOTES), 'memory_outcome', MEMORY_OUTCOME_NOTES);
  const r = spanned.split('{{memory_report_line}}');
  const q = r.join(notesOn ? MEMORY_REPORT_LINE : '').split('{{memory_queries_line}}');
  const queriesOn = !!(levers.memory_levers && levers.memory_levers.first_message_index);
  const c = q.join(queriesOn ? MEMORY_QUERIES_LINE : '').split('{{memory_rules}}');
  let rules = '';
  if (on) {
    rules = matchEol(String(levers.rules_text).replace(TRAILING_EOL, ''), withRule);
    if (notesOn) rules = rules.split(MEMORY_VERIFY_RULE).join('');
  }
  const substituted = { max_fix_rounds: a.length - 1, fix_cutoff_rule: b.length - 1 };
  if (on) substituted.memory_rules = c.length - 1;
  if (queriesOn) substituted.memory_queries_line = q.length - 1;
  if (notesOn) {
    substituted.memory_report_line = r.length - 1;
    if (spans.memory_use) substituted.memory_use = spans.memory_use;
    if (spans.memory_outcome) substituted.memory_outcome = spans.memory_outcome;
  }
  return { text: c.join(rules), substituted };
}

// The number of this run's tasks whose acceptance.verdict is true, read from the store, or
// { value: null, reason } when the read fails.
async function countReviewRounds(core, runId) {
  try {
    const out = await core.task.list({});
    let n = 0;
    for (const t of out.tasks || []) {
      if (t.run_id !== runId) continue;
      let acc = t.acceptance;
      if (typeof acc === 'string') { try { acc = JSON.parse(acc); } catch { acc = null; } }
      if (acc && acc.verdict === true) n += 1;
    }
    return { value: n, reason: null };
  } catch (e) {
    return { value: null, reason: `task.list failed: ${(e && e.message) || String(e)}` };
  }
}

module.exports = { MEMORY_REPORT_LINE, MEMORY_QUERIES_LINE, MEMORY_USE_NOTES, MEMORY_OUTCOME_NOTES, MEMORY_VERIFY_RULE, mergeMemory, parseLevers, attachMemory, memoryText, substituteLevers, countReviewRounds, cutoffRule, FIX_CUTOFFS };
