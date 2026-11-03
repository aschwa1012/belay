'use strict';
// run-render.cjs — the text form of the `belay run` receipt (moved out of cmd-run.cjs to keep it under 500 lines).

const RI = require('./run-interactive.cjs'); // ADR 0037: interactive mode's CLI helpers
const { memoryText } = require('./run-levers.cjs');

// 5a-4 item 4: the two no-write paths (a refusal, an election failure) return before run.json is ever
// attempted, so the old unconditional last line told an operator to go read a receipt that was never
// written, in a directory that was never created. `receipt.receipt_path` is the path written, or
// `null`, and the line prints only when it is not.
function renderText(receipt) {
  // A refusal fills an all-null orchestrator block: no process ever existed, so there is no pid, session,
  // turn count or exit code to print. Say that, with the reason, rather than a row of "null".
  const neverStarted = receipt.orchestrator.pid == null && receipt.orchestrator.session_id == null;
  const lines = [
    `run_id: ${receipt.run_id}`,
    ...(neverStarted
      ? [`never started: ${receipt.ended_by}`]
      : [
        `orchestrator pid ${receipt.orchestrator.pid}, session ${receipt.orchestrator.session_id}, ${receipt.orchestrator.turns} turn(s)`,
        `ended_by: ${receipt.ended_by}`,
        `exit_code: ${receipt.orchestrator.exit_code}`,
      ]),
    `holds: ${receipt.holds.length}`,
    `polls: ${receipt.polls}`,
  ];
  if (receipt.mode === 'interactive') lines.splice(1, 0, `mode: ${receipt.mode}`); // the headless text is unchanged
  // 5c: named only when a `belay stop` actually ended this run — the operator's proof that the CLI
  // exit they are looking at was an intervention, not the orchestrator ending on its own.
  if (receipt.stop) lines.push(`stopped by: pid ${receipt.stop.caller_pid}`);
  // ADR 0029: named only when the run itself closed a worker row or killed a process.
  const wc = receipt.workers_closed;
  if (wc && (wc.killed.length || (wc.marked_dead || []).length)) {
    lines.push(`workers closed: ${wc.killed.length} killed, ${(wc.marked_dead || []).length} marked dead`);
  }
  if (receipt.mode === 'interactive' && wc && (wc.left_parked || []).length) lines.push(`left parked: ${wc.left_parked.join(', ')}`); // ADR 0023 amendment 5
  const pl = receipt.mode === 'interactive' && receipt.orchestrator && receipt.orchestrator.interactive && receipt.orchestrator.interactive.plugin;
  if (pl && pl.unreadable) lines.push('plugin copy unreadable at exit');
  else if (pl && pl.unchanged === false) lines.push(`plugin copy changed after spawn: ${(pl.changed_files || []).join(', ') || 'unreadable'}`); // ADR 0037 amendment 5 decision 4
  if (receipt.levers) {
    const rr = receipt.review_rounds === null ? `unknown (${receipt.review_rounds_reason})` : receipt.review_rounds;
    lines.push(`levers: max_fix_rounds ${receipt.levers.max_fix_rounds}${receipt.levers.max_follow_ups !== undefined ? `, max_follow_ups ${receipt.levers.max_follow_ups}` : ''}${receipt.levers.fix_hard_cap === undefined ? '' : `, fix_hard_cap ${receipt.levers.fix_hard_cap === null ? 'none' : `${receipt.levers.fix_hard_cap} (${receipt.levers.fix_hard_cap_source})`}`}, fix_cutoff ${receipt.levers.fix_cutoff}, on_embedder_failure ${receipt.levers.on_embedder_failure}${receipt.levers.max_parallel_evaluations ? `, max_parallel_evaluations ${receipt.levers.max_parallel_evaluations}` : ''}${memoryText(receipt.levers)}; review_rounds: ${rr}`);
  }
  lines.push(...RI.embedderLines(receipt), ...require('../run/review-scratch.cjs').lines(receipt), ...require('./run-trees.cjs').lines(receipt), ...require('./run-checks.cjs').lines(receipt)); // ADR 0054 amendment 1: what the close removed
  if (receipt.receipt_path) lines.push(`receipt: ${receipt.receipt_path}`);
  lines.push('');
  return lines.join('\n');
}

module.exports = { renderText };
