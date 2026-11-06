'use strict';
// time-wake.cjs — the time-bound wake (ADR 0074 amendment 4, phase B). A headless run with a timeout tells its orchestrator once, when 80% of
// the bound has passed, so an orchestrator that plans and goes hands off is not stopped by the deadline without a word. The time counted is
// the run's own clock (run-hold.cjs getTimeoutRemaining): a pause stops it, and while paused nothing is said. One wake per run.

const FRACTION = 0.8;

// `totalMs`: the run's timeout_ms (0: no bound, no wake). `remaining()`: ms left on the run's clock, or null while it is stopped.
function createTimeWake({ totalMs, remaining, fraction = FRACTION }) {
  let sent = false;
  function poll() {
    if (sent || !(totalMs > 0)) return [];
    const left = remaining();
    if (left == null || totalMs - left < totalMs * fraction) return []; // elapsed on the run's clock below the fraction (exact in integers: no 1 - 0.8 rounding)
    sent = true;
    const s = (ms) => Math.round(ms / 1000);
    return [{
      event: 'time_bound', worker_id: 'time:run', turn: 0, seq: null, left_ms: left, total_ms: totalMs,
      text: `belay: the run's time bound is near: ${s(left)} s of ${s(totalMs)} s left (paused time not counted). Decide what to finish and what to name as open before it ends.`,
    }];
  }
  return { poll, sent: () => sent };
}

module.exports = { createTimeWake, FRACTION };
