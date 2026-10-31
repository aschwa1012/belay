'use strict';
// planned.cjs — ADR 0074: whether the run is under a plan, decided ONE way on every path that delivers a wake (the headless run, the interactive
// pipe, the adapter's worker_wait): from the store. A run is planned when its row carries a default plan or any of its tasks carries one. A
// plan is never taken back (an amend to `policy: null` hands one task back, it does not unplan the run), so a yes is kept. A no is read again
// at the next `check()`; callers ask only when a wake that has a second delivery path (a worker death, a stale record) is about to be sent,
// so a run with no plan pays nothing and one with a plan pays one indexed read per such wake. `value()` is the last answer, for the callers that
// cannot await.

function createPlanned({ core, runId }) {
  let yes = false;
  async function check() {
    if (yes) return true;
    try {
      if (core.run && typeof core.run.get === 'function') {
        const r = await core.run.get({});
        if (r && r.run && r.run.policy_default) { yes = true; return true; }
      }
    } catch { /* the tasks decide */ }
    try {
      const t = await core.task.list({});
      if (((t && t.tasks) || []).some((x) => x.run_id === runId && x.policy)) yes = true;
    } catch { /* unknown is not planned; the next check reads again */ }
    return yes;
  }
  return { check, value: () => yes };
}

module.exports = { createPlanned };
