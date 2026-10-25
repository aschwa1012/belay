'use strict';
// wait-eval.cjs — worker_wait's view of a release evaluation in flight (ADR 0058 decision 5). A turn that ended with a hand-back is
// answered at once with `evaluating`; a later wait on the same worker, its turn already over, holds until that evaluation ends and
// answers with its result (gap 9 of the second 0.3.1 try: before, every later wait answered `already` at once, and the only way to
// learn the result was to poll task_list). The wake path is not touched: it carries the result as it did (release-eval.cjs).

// The task ids still being evaluated for the worker's last turn, or null. The same facts release-eval.cjs evalOf reports.
function evaluatingOf(w) {
  const v = require('./release-eval.cjs').evalOf(w);
  return v.evaluating && v.evaluating.length ? v.evaluating : null;
}

// Resolves once no evaluation of the worker's last turn is in flight. One that is about to start (its ids noted at the turn's end,
// started from the worker's queue once the turn's row is written) is waited for through the queue first. Never rejects.
async function evaluationEnded(w) {
  for (let i = 0; i < 2 && evaluatingOf(w); i += 1) {
    const ev = w.evaluation;
    if (ev && !ev.done && ev.promise) await Promise.race([ev.promise.catch(() => {}), ev.cancelSignal || new Promise(() => {})]);
    else await w.queue.catch(() => {});
  }
}

module.exports = { evaluatingOf, evaluationEnded };
