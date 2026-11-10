'use strict';
// cmd-status.cjs — build step 4a, design item 3. CLI
// slice, mode R: read state without writing anything, and never `mkdir owner.lock`. The contract is
// in src/cli/belay.cjs: run(ctx) -> { code, text, json }, never printing, never calling process.exit.
//
// No --deep: status.cjs already records the deep probe as out of scope, and this command leaves it
// so — the flag is not accepted here either, so nothing pretends to a check it does not make.

const C = require('./config.cjs');
const { openCore } = require('../core/index.cjs');

function usageError(message) {
  return {
    code: 2,
    text: `belay status: ${message}\n\nusage: belay status [run-id] [--data <dir>] [--json]\n`,
    json: { error: message },
  };
}

// Zero or one positional argument, and nothing that looks like an unrecognised flag (--deep
// included: it is not a flag this command accepts, so it is a usage error rather than silently
// treated as a run id).
function parseArgs(argv) {
  if (argv.length > 1) return { error: `belay status takes zero or one argument, a run id; got ${argv.length}` };
  const arg = argv[0];
  if (arg !== undefined && arg.startsWith('-')) return { error: `unknown option ${arg}` };
  return { runId: arg };
}

function renderText(receipt) {
  const lines = receipt.rungs.map(r => `${r.rung}  ${r.established ? 'established' : 'not established'}  ${r.by}`);
  lines.push(`verdict: ${receipt.verdict}`);
  lines.push(`established_by: ${receipt.established_by}`);
  if (receipt.run) {
    const r = receipt.run;
    // Fix round: a run row can be alive, properly ended, or neither — still open (ended_at null) but
    // its adapter pid is dead. That third case is exactly what api.md §4's run.attach sentence says
    // must be "reported as it stands"; printing "ended at null: null" would fabricate an ending nothing
    // ever wrote.
    let life;
    if (r.alive) life = 'alive';
    else if (r.ended_at != null) life = `ended at ${r.ended_at}: ${r.exit_reason}`;
    else life = `not running: adapter pid ${r.adapter_pid} is not alive, and the run was never ended`;
    lines.push(`run: ${r.id} epoch ${r.epoch} ${life}`);
    // ADR 0034: a run paused by an embedder failure says so, with the worker, the call and the cause.
    if (r.embed_bounds) lines.push(`embedder: ${r.embed_bounds} index-query embed${r.embed_bounds === 1 ? '' : 's'} hit the ${require('../core/spawn-bounds.cjs').SPAWN_EMBED_MS} ms spawn bound (E_EMBED_BOUND); those workers' index was built from the texts that had embedded (when none had, nothing is listed and the worker is told the notes could not be ranked)`);
    if (r.index_bounds) lines.push(`index: ${r.index_bounds} first-message index${r.index_bounds === 1 ? '' : 'es'} hit the index bound (E_INDEX_BOUND): refused under on_embedder_failure required, or built without its vector lists otherwise; fix the embedder (belay doctor checks it)`);
    if (r.budget) lines.push(`budget: ${require('../core/run-budget.cjs').textOf(r.budget)}`);
    if (r.paused_at != null && r.ended_at == null) lines.push(`run paused at ${new Date(r.paused_at).toISOString()} by ${r.paused_by}${/embedder-failure [(]/.test(r.paused_by || '') ? ` (an embedder failure, on_embedder_failure required: fix the embedder and belay resume, or choose: belay resume ${r.id} --embedder keyword | --embedder off, which also saves the choice; belay settings memory.on_embedder_failure keyword | off saves it for later runs; or leave it paused)` : ''}`);
  }
  if (receipt.run && receipt.run.orch_model_fallback) lines.push(require('../core/model-switch.cjs').line('orchestrator', receipt.run.orch_model_fallback));
  for (const w of receipt.workers || []) if (w.model_fallback) lines.push(require('../core/model-switch.cjs').line(`worker ${w.id}`, w.model_fallback));
  lines.push(...require('../core/status-plans.cjs').lines(receipt)); // ADR 0071 decision 5
  lines.push(...require('../core/policy-log.cjs').statusLines(receipt)); // 0.4.0: the newest policy steps, facts only
  for (const w of receipt.workers || []) { // a turn that has not ended: an estimate from the worker's stream, apart from the reported cost
    if (w.cost_in_flight_usd != null) lines.push(`worker ${w.id}: $${w.cost_in_flight_usd.toFixed(2)} ${w.cost_in_flight_source}${w.cost_in_flight_partial ? ' (partial: stream not yet read to its end)' : ''}, not in its reported cost ${w.cost_usd == null ? 'not recorded' : `$${Number(w.cost_usd).toFixed(2)}`}`);
  }
  if (receipt.store) {
    const st = receipt.store;
    lines.push(st.schema_version === null
      ? 'store: schema 1, unstamped (written before the stamp existed)'
      : `store: schema ${st.schema_version}, last written by ${st.written_by || 'unknown'}`);
  }
  if (receipt.notes_unembedded && receipt.notes_unembedded.total > 0) lines.push(require('./panel-common.cjs').unembeddedText(receipt.notes_unembedded));
  if (receipt.notes_held && receipt.notes_held.total > 0) lines.push(require('./panel-common.cjs').heldText(receipt.notes_held));
  if (receipt.retrieval) lines.push(...require('../core/retrieval-view.cjs').lines(receipt.retrieval));
  if (receipt.notes_held && receipt.notes_held.malformed > 0) lines.push(require('./panel-common.cjs').unreadableText({ count: receipt.notes_held.malformed, closed_projects: receipt.notes_held.closed_projects }));

  for (const k of receipt.check_flake || []) lines.push(require('../core/check-flake.cjs').line(k)); // 0.4.0: the checks that changed outcome on one tree; facts, no verdict
  if ((receipt.check_flake_total || 0) > (receipt.check_flake || []).length) lines.push(`flaky check: ${receipt.check_flake_total - receipt.check_flake.length} more flipped keys not shown (${receipt.check_flake_total} in all)`);
  if (receipt.memory_notice) lines.push(`warning: ${receipt.memory_notice.title}. ${receipt.memory_notice.why} ${receipt.memory_notice.fix}`);
  lines.push('');
  return lines.join('\n');
}

async function run(ctx) {
  const parsed = parseArgs(ctx.argv);
  if (parsed.error) return usageError(parsed.error);

  const found = C.discover(ctx.cwd);
  const dataDir = C.dataDirOf(found, ctx);

  // Mode R: never created. A read against an absent data dir is not an error — status.get's first
  // rung says so, and the copy path against an absent memory.db self-heals in a throwaway.
  const core = await openCore({ dataDir, caller: { role: 'operator', run_id: parsed.runId || 'cli', pid: process.pid } });
  try {
    let runId = parsed.runId;
    let runIdSource = parsed.runId ? 'argument' : null;
    const { runs } = await core.run.list({});
    if (runId && !runs.some(r => r.id === runId)) {
      const message = `no run row exists for ${runId}`;
      return { code: 1, text: `belay status: ${message}\n`, json: { error: { code: 'E_NOT_FOUND', message, run_id: runId } } };
    }
    if (!runId) {
      if (runs.length) {
        // Fix round: run.list orders by the row most recently WRITTEN, not by which run is actually
        // alive — a run that ended a second ago can outrank one still running and never named. The
        // CLI's own way to find "the current run" (api.md §3) prefers a run flagged alive; only when
        // none is does it fall back to the newest written row.
        const chosen = runs.find(r => r.alive) || runs[0];
        runId = chosen.id; runIdSource = 'run.list';
      } else runIdSource = 'none';
    }
    const st = await core.status.get(runId ? { run_id: runId } : {});
    const flaked = await core.check.flake({ limit: 10 }); const flakes = flaked.keys; // 0.4.0: the newest ten flipped keys through a partial index, and how many there are
    const notice = require('../core/memory-notice.cjs').noticeForRun(runs.find(r => r.id === runId) || null, found); // a live run's own levers win over the config file
    const retrieval = require('../core/retrieval-view.cjs').describe(runs.find(r => r.id === runId) || null, core.ownerInfo()); // the pinned routing and any fallback in force, from the run row
    const receipt = { ...st, run_id_source: runIdSource, ...(flakes.length ? { check_flake: flakes, check_flake_total: flaked.total } : {}), ...(notice ? { memory_notice: notice } : {}), ...(retrieval ? { retrieval } : {}) };
    // Exit 0 whenever the ladder was read, whatever the verdict: a dead system is a valid answer.
    return { code: 0, text: renderText(receipt), json: receipt };
  } catch (e) {
    const detail = { code: e.code || 'E_INTERNAL', message: e.message };
    return { code: 1, text: `belay status: ${e.message}\n`, json: { error: detail } };
  } finally {
    await core.close();
  }
}

module.exports = { run };
