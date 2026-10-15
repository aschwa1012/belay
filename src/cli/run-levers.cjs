'use strict';
// run-levers.cjs — ADR 0031 decisions 3, 5 and 6: the two run-spec levers (`max_fix_rounds`,
// `fix_cutoff`), their substitution into the orchestrator's prompt text, and the receipt's
// `review_rounds` audit. Used only by cmd-run.cjs.

const fs = require('node:fs');
const path = require('node:path');
const CP = require('../run/compaction.cjs');
const ML = require('../run/memory-levers.cjs');

const FIX_CUTOFFS = ['orchestrator', 'cap-only'];
const DEFAULT_MAX_FIX_ROUNDS = 2;
const DEFAULT_FIX_CUTOFF = 'orchestrator';
const EM = require('../core/embedder-mode.cjs');
const DEFAULT_ON_EMBEDDER_FAILURE = EM.DEFAULT_MODE; // ADR 0034 decision 2, amendment 1
const MEMORY_RULES_FILE = path.join(__dirname, '..', 'run', 'prompts', 'memory-rules.md');

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
    ? '(stop, store the outcome in memory, tell the operator the open blocking findings, then wait for them)'
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
function mergeMemory(specBlock, config) {
  const cfg = config && config.memory !== undefined && config.memory !== null ? config.memory : null;
  if (cfg !== null && (typeof cfg !== 'object' || Array.isArray(cfg))) return { error: `${config.path}: memory must be an object` };
  const own = specBlock !== undefined && specBlock !== null && typeof specBlock === 'object' && !Array.isArray(specBlock) ? specBlock : null;
  if (own === null && specBlock !== undefined && specBlock !== null) return { block: specBlock, sources: null }; // not an object: parseMemoryBlock says so
  const block = { ...(cfg || {}), ...(own || {}) };
  const sources = {};
  for (const k of Object.keys(ML.DEFAULTS)) sources[k] = own && Object.prototype.hasOwnProperty.call(own, k) ? 'spec' : cfg && Object.prototype.hasOwnProperty.call(cfg, k) ? config.path : 'default';
  return { block: cfg === null && own === null ? undefined : block, sources, fromConfig: cfg !== null && Object.keys(cfg).length > 0 };
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
  } else if (opts.config && opts.config.memory && opts.config.memory.on_embedder_failure !== undefined) {
    onEmbedderFailure = EM.normalize(opts.config.memory.on_embedder_failure) || DEFAULT_ON_EMBEDDER_FAILURE; // a bad config value is refused by parseMemoryBlock below
  }
  const out = { max_fix_rounds: maxFixRounds, fix_cutoff: fixCutoff, on_embedder_failure: onEmbedderFailure };
  const ca = CP.parseCompactAt(spec.compact_at_tokens);
  if (ca.error) return { error: ca.error };
  if (ca.value !== null) out.compact_at_tokens = ca.value;
  // ADR 0041 decision 1: the memory block. Present on the result only when it differs from the defaults, so a
  // run without it has the levers, the receipt and the run row it always had.
  // The config's `memory` block is the project default under the spec's own (opts.config = { path, memory }).
  const merged = mergeMemory(spec.memory, opts.config);
  if (merged.error) return { error: merged.error };
  const mem = ML.parseMemoryBlock(merged.block);
  if (mem.error) return { error: merged.fromConfig ? `${mem.error} (memory defaults come from ${opts.config.path}, the spec's own memory block over them)` : mem.error };
  // on_embedder_failure is resolved above (spec top level, spec memory block, config, default) and recorded on its own: the
  // run's memory_levers never carries it, so the row cannot contradict the receipt, a config that sets only this lever does not
  // make every run row carry memory_levers, and an older core (which refuses the unknown key) still reads the block.
  const recorded = { ...mem.value }; delete recorded.on_embedder_failure;
  if (merged.sources) merged.sources.on_embedder_failure = given ? 'spec' : (opts.config && opts.config.memory && opts.config.memory.on_embedder_failure !== undefined ? opts.config.path : 'default');
  if (!ML.isDefault({ ...recorded, on_embedder_failure: ML.DEFAULTS.on_embedder_failure })) {
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
  return out;
}

// The columns run.attach records for the memory levers; nothing at all for a default block.
function attachMemory(levers) {
  const m = levers && levers.memory_levers;
  return m ? { memory_levers: JSON.stringify(m), project: m.project } : {};
}

// The receipt line's suffix, empty for a default block.
function memoryText(levers) {
  return levers && levers.memory_levers ? `; memory_levers: ${JSON.stringify(levers.memory_levers)}` : '';
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
  const c = withRule.split('{{memory_rules}}');
  let rules = '';
  if (on) {
    rules = matchEol(String(levers.rules_text).replace(TRAILING_EOL, ''), withRule);
  }
  const substituted = { max_fix_rounds: a.length - 1, fix_cutoff_rule: b.length - 1 };
  if (on) substituted.memory_rules = c.length - 1;
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

module.exports = { mergeMemory, parseLevers, attachMemory, memoryText, substituteLevers, countReviewRounds, cutoffRule, FIX_CUTOFFS };
