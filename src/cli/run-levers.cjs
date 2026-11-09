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
const DEFAULT_MAX_FOLLOW_UPS = 1; // ADR 0064 decision 5; 0 refuses every follow-up
const DEFAULT_FIX_HARD_CAP = 5; // ADR 0031 amendment 3: the safety net of a run with no time bound; a run with a timeout is notice-only
const HARD_CAP_DEFAULT_SOURCE = 'default, no run timeout';
const DEFAULT_FIX_CUTOFF = 'orchestrator';
const EM = require('../core/embedder-mode.cjs');
const DEFAULT_ON_EMBEDDER_FAILURE = EM.DEFAULT_MODE; // ADR 0034 decision 2, amendment 1
const MEMORY_RULES_FILE = path.join(__dirname, '..', 'run', 'prompts', 'memory-rules.md');
// The one sentence that asks the orchestrator for `memory_queries`. Its only reader is the first-message index
// (memory-preface.cjs), so it is told to the orchestrator only when that lever is on; off, the placeholder is ''
// and the prompt asks for nothing the run never reads.
const MEMORY_REPORT_LINE = ' If a note is wrong, out of date or contradicted by the evaluation of a task or the code, report it with `mcp__belay__memory_report` and say why (it holds the note for the archive review); you need not wait for the operator.';
// The Rules of thumb line for a run with the permission channel on (run lever permission_prompt); '' otherwise.
const PERMISSION_LINE = '- Answer permission requests (`mcp__belay__permission_list`, `mcp__belay__permission_decide`) only when the request is inside the plan.\n';
// ADR 0047 amendment (2026-10-22), decision 7: in a notes run the orchestrator's memory bullet says four things, and a run outcome is a summary. The
// template keeps the text a run without notes always had, between {{memory_use}} ... {{/memory_use}} (and {{memory_outcome}} ... {{/memory_outcome}}); a run
// with notes replaces the span, a run without drops only the markers (the base text of each span is what a run with notes off is told: search, and no store).
const MEMORY_USE_NOTES = [
  "- Use belay's notes yourself.",
  '  - Search before you plan: before you create any task, call `mcp__belay__memory_search` with a `query` on the brief\'s subject and no namespace (it searches the',
  "    project's notes) and use what it returns in your plan and prompts (empty on a first run is normal).",
  '  - Store a note only for what the code and the markdown of the project cannot tell the next run and it would trip on: `mcp__belay__memory_store` with `namespace: "project"`',
  '    and `kind`, `title`, `when`, `basis` (and `evidence` when you observed it). Nothing is the normal answer.',
  '  - Record your decisions and the outcome with `namespace: "summary"` (a `title` and `text`); they are found on demand with `mcp__belay__memory_summaries`.',
  '  - Never tell a worker to write memory with `memory_store`: what it learns that is worth keeping goes in the `notes` of its `lease_release`.',
].join('\n');
const MEMORY_OUTCOME_NOTES = 'record the outcome with `namespace: "summary"`, ';
const MEMORY_VERIFY_RULE = ' Use `mcp__belay__memory_verify` only with a receipt.'; // a notes run's orchestrator has no memory_verify
const MEMORY_QUERIES_LINE = ' Also give 1 to 3 `memory_queries`: task lines (each under 160 bytes) naming the situations the worker will be in, such as "add a migration" or "dedupe email addresses", not the finding you expect it to make.';

// The time-bound condition is observable only if the orchestrator is told the bound and can read elapsed time. `belay run` renders the run's
// start and deadline into it as absolute UTC times (`opts.startedAt`), so the rule carries them through a compaction and needs no call the
// model must remember; it reads the time now from a shell (`date -u`). An orchestrator that waits by the wake has no worker_wait answer to
// read waited_ms from (ADR 0037 amendment 7). A pause stops the run's clock (ADR 0023 amendment 3), so the deadline moves later by it.
// Without a start (a prompt check, not a launch) the times are left out. Written in from timeout_ms and dropped when that is 0.
// `mode` is 'headless' (the default, byte-identical to before) or 'interactive' (ADR 0037 decision 4: the run
// does not end, so stop-and-surface is stop, store, tell the operator, then wait).
function cutoffRule(fixCutoff, timeoutMs, mode = 'headless', startedAt = null) {
  if (fixCutoff === 'cap-only') return 'Do not stop fix rounds before the fix-round limit.';
  const timeCond = timeoutMs > 0
    ? `; the run's time bound (${timeoutMs} ms from its start${Number.isFinite(startedAt) ? `, ${new Date(startedAt).toISOString()}, so ${new Date(startedAt + timeoutMs).toISOString()}, later by any time the run is paused` : ''}) is near, judged by the time now (\`date -u\` in a shell)`
    : '';
  const interactive = mode === 'interactive';
  const surface = interactive
    ? '(stop, record the outcome, tell the operator the open blocking findings, then wait for them)'
    : '(end the run and name the open blocking findings for the human)';
  return `You may stop fix rounds before the fix-round limit, only towards stop-and-surface ${surface}, `
    + 'and only when one of these holds: the same blocking finding '
    + 'survived a fix round; a fix round introduced a new regression; the fix needs files outside the task\'s '
    + `owned set${timeCond}. Name the condition and its evidence when you ${interactive ? 'stop' : 'close'}. Never `
    + 'report a refuted step as passing or mark it done.'
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

// Returns { max_fix_rounds, fix_cutoff, on_embedder_failure, fix_hard_cap, fix_hard_cap_source[, compact_at_tokens] } or { error }. `compact_at_tokens` (ADR 0007 decision 3,
// null by default) is present only when set, so a run without it has the receipt it always had.
// { name, source } when this run's project is to be derived, else null. Needs `opts.projectDir` (a prompt check or a test that gives none derives nothing).
function deriveProject(spec, merged, opts) {
  if (!opts.projectDir || !merged.sources || spec.memory === null) return null;
  if (spec.memory === undefined && opts.config && opts.config.memory === null) return null;
  const b = merged.block;
  if (b !== undefined && (typeof b !== 'object' || b === null || Array.isArray(b))) return null;
  if (b && (Object.prototype.hasOwnProperty.call(b, 'project') || b.notes === false || b.redact === false)) return null;
  return require('./default-project.cjs').derive(opts.projectDir);
}

function parseLevers(spec, opts = {}) {
  let maxFixRounds = DEFAULT_MAX_FIX_ROUNDS;
  if (spec.max_fix_rounds !== undefined) {
    const v = spec.max_fix_rounds;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
      return { error: 'max_fix_rounds must be a non-negative integer' };
    }
    maxFixRounds = v;
  }
  let maxFollowUps = DEFAULT_MAX_FOLLOW_UPS;
  if (spec.max_follow_ups !== undefined) {
    const v = spec.max_follow_ups;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return { error: 'max_follow_ups must be a non-negative integer' };
    maxFollowUps = v;
  }
  // ADR 0031 amendment 3: the user's fix_hard_cap wins (null says no cap); unset, a run with no time bound (timeout_ms 0, the default) gets
  // DEFAULT_FIX_HARD_CAP and a run with a timeout gets none. The source is recorded beside the cap.
  // The time bound is run-spec.cjs's parsed number when it is given (a numeric string counts), else the raw key, 0 when absent.
  const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : (spec.timeout_ms === undefined ? 0 : Number(spec.timeout_ms));
  let fixHardCap = null, fixHardCapSource = null;
  if (spec.fix_hard_cap !== undefined) {
    const v = spec.fix_hard_cap;
    if (v !== null && (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)) return { error: 'fix_hard_cap must be a non-negative integer, or null for no cap' };
    fixHardCap = v; fixHardCapSource = 'run spec';
  } else if (!(timeoutMs > 0)) { fixHardCap = DEFAULT_FIX_HARD_CAP; fixHardCapSource = HARD_CAP_DEFAULT_SOURCE; }
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
  const out = { max_fix_rounds: maxFixRounds, max_follow_ups: maxFollowUps, fix_cutoff: fixCutoff, on_embedder_failure: onEmbedderFailure };
  out.fix_hard_cap = fixHardCap; out.fix_hard_cap_source = fixHardCapSource; // null: no cap
  const ca = CP.parseCompactAt(spec.compact_at_tokens);
  if (ca.error) return { error: ca.error };
  if (ca.value !== null) out.compact_at_tokens = ca.value;
  // ADR 0058 decision 8: off by default, and absent from the levers (and the receipt) unless the spec turns it on.
  if (spec.stop_idle_on_done !== undefined && typeof spec.stop_idle_on_done !== 'boolean') return { error: 'stop_idle_on_done must be true or false' };
  if (spec.stop_idle_on_done === true) out.stop_idle_on_done = true;
  // The most task evaluations (release-time, called, and integration re-runs) the store owner runs at once; absent unless set, so a run without it has the receipt it always had.
  if (spec.max_parallel_evaluations !== undefined) {
    const v = spec.max_parallel_evaluations;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) return { error: 'max_parallel_evaluations must be a positive integer' };
    out.max_parallel_evaluations = v;
  }
  // ADR 0020 decision 1 as amended: the permission tools are listed to the orchestrator, and their prompt line given, only for a run that turns the channel on.
  if (spec.permission_prompt !== undefined && typeof spec.permission_prompt !== 'boolean') return { error: 'permission_prompt must be true or false' };
  if (spec.permission_prompt === true) out.permission_prompt = true;
  // Merging into a branch the user owns: "ask" (the default; absent from the levers unless the spec says it) or "allowed". Fixed for the run.
  if (spec.merge_into !== undefined && spec.merge_into !== 'ask' && spec.merge_into !== 'allowed') return { error: 'merge_into must be "ask" or "allowed"' };
  if (spec.merge_into !== undefined) out.merge_into = spec.merge_into;
  // Merging another run's tasks, or into another run's integrate branch: off unless the spec says true. Fixed for the run.
  if (spec.cross_run_merge !== undefined && typeof spec.cross_run_merge !== 'boolean') return { error: 'cross_run_merge must be true or false' };
  if (spec.cross_run_merge === true) out.cross_run_merge = true;
  if (spec.max_parallel_builds !== undefined) { // ADR 0074 amendment 4: the cap on a plan's builds in flight; unset, the executor's default (4)
    const v = spec.max_parallel_builds;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) return { error: 'max_parallel_builds must be a positive integer' };
    out.max_parallel_builds = v;
  }
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
  // ADR 0041 amendment (ADR 0088): a run that names no project and has not turned notes off takes one from the project folder (the git remote, else
  // the folder name). An explicit setting always wins: a project, `notes: false`, `redact: false`, `memory: null`, or a config whose memory is null.
  const derived = deriveProject(spec, merged, opts);
  if (derived) {
    merged.block = { ...(merged.block || {}), project: derived.name };
    merged.sources.project = `derived: ${derived.source}`;
  }
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
  if (derived) out.memory_project = { name: derived.name, source: derived.source, derived: true }; // the receipt names the project and where it came from
  // Notes default on but need a project: say so when there is none. Not enumerable, so the receipt is unchanged; `belay run` prints it.
  // An explicit `memory: null` is silent, whether the spec says it or the config file does (an inherited one, unless the spec's own block overrides it).
  const off = spec.memory === null || (spec.memory === undefined && !!opts.config && opts.config.memory === null);
  Object.defineProperty(out, 'memory_notice', { value: MN.noticeFor(off ? null : merged.block), enumerable: false });
  if (merged.dropped) out.memory_dropped = merged.dropped; // config levers a spec's `notes: false` left out, so the receipt says what did not apply
  const bud = require('./run-budget-levers.cjs').applyBudget(out, spec, opts); // the run's dollar budget; turns the usage ledger on
  if (bud.error) return bud;
  const pol = require('./run-policy-levers.cjs').applyPolicy(out, spec, opts); // the user's default task plan (ADR 0071)
  if (pol.error) return pol;
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
  return (levers && levers.memory_project ? `; project ${levers.memory_project.name} (derived from ${levers.memory_project.source})` : '') + (levers && levers.memory_levers ? `; memory_levers: ${JSON.stringify(levers.memory_levers)}` : '') + (levers && levers.memory_dropped ? `; config levers dropped by notes false: ${levers.memory_dropped.join(', ')}` : '');
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
// The template's header markers are for belay, not the model: `<!-- belay-prompt X.Y.Z -->` (run-prompt-check.cjs) and `<!-- belay-mode: ... -->`
// (run-interactive.cjs) are read from the template or the operator's copy before this runs. The shipped title line that carries the first
// is dropped whole; a copy's own title keeps its words and loses only the comment. Applied to the rendered prompt, never to the file.
function stripMarkers(text) {
  return String(text)
    .replace(/^# Orchestrator prompt template[ \t]*<!--\s*belay-prompt\s+[\d.]+\s*-->[ \t]*\r?\n(\r?\n)?/, '')
    .replace(/[ \t]*<!--\s*belay-prompt\s+[\d.]+\s*-->/, '')
    .replace(/^[ \t]*<!--\s*belay-mode:[^>]*-->[ \t]*\r?\n(\r?\n)?/m, '');
}

// ADR 0037 amendment 8: the orchestrator is told the run's plan, the one every work task takes at create unless it states its own (run-policy-levers.cjs).
// With a plan it carries the plan-first directive (plan the work, then go hands off); without one, the flow where the orchestrator takes each step.
const PLAN_FIRST = 'Plan the work first: create every work task with `task_create`, an independent one with `worktree: true`, and a dependent one with its `depends_on` and no tree (belay cuts its tree from `belay/integrate/<run>` once its dependencies are merged, so they are in it). Then end your turn and rely on the wakes: act on an exception or an escalation, and on the done wake decide whether you are done. Do not spawn or assign a task whose plan builds it; handle a step yourself only when you have a specific reason, and say why in your reply to the user. If a builder dies, belay restarts it once; you are woken only if that did not work, and then restart it or assign the task yourself.';
const NO_PLAN = 'This run has no run plan: a task has a plan only if you give it a `policy`; otherwise you assign, review, fix and merge it yourself.';
function runPlanLine(levers) {
  const p = levers && levers.policy_default;
  if (!p || typeof p !== 'object' || !Object.keys(p).length) return NO_PLAN;
  return `This run's plan, which every work task you create takes unless you give it a \`policy\` of its own (a field you leave out takes this plan; a field set to null keeps that step yours) or \`policy: null\`, is \`${JSON.stringify(p)}\`. ${PLAN_FIRST}`;
}

function substituteLevers(text, levers, timeoutMs = 0, opts = {}) {
  const rule = cutoffRule(levers.fix_cutoff, timeoutMs, (opts && opts.mode) || 'headless', opts && Number.isFinite(opts.startedAt) ? opts.startedAt : null);
  const a = String(text).split('{{run_plan}}').join(runPlanLine(levers)).split('{{max_fix_rounds}}');
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
  const permOn = levers.permission_prompt === true;
  const pl = q.join(queriesOn ? MEMORY_QUERIES_LINE : '').split('{{permission_line}}');
  const c = pl.join(permOn ? PERMISSION_LINE : '').split('{{memory_rules}}');
  let rules = '';
  if (on) {
    rules = matchEol(String(levers.rules_text).replace(TRAILING_EOL, ''), withRule);
    if (notesOn) rules = rules.split(MEMORY_VERIFY_RULE).join('');
  }
  const substituted = { max_fix_rounds: a.length - 1, fix_cutoff_rule: b.length - 1 };
  if (on) substituted.memory_rules = c.length - 1;
  if (queriesOn) substituted.memory_queries_line = q.length - 1;
  if (permOn) substituted.permission_line = pl.length - 1;
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

module.exports = { runPlanLine, PLAN_FIRST, NO_PLAN, stripMarkers, MEMORY_REPORT_LINE, MEMORY_QUERIES_LINE, MEMORY_USE_NOTES, MEMORY_OUTCOME_NOTES, MEMORY_VERIFY_RULE, mergeMemory, parseLevers, attachMemory, memoryText, substituteLevers, countReviewRounds, cutoffRule, FIX_CUTOFFS };
