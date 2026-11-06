'use strict';
// digest-quiet.cjs — when the interactive wake publisher sends the digest on its own (ADR 0074 amendment 2). A digest rides every published
// wake; a step after the last wake (often the final merge) had none to ride, so an orchestrator waiting by the wake never saw it. The run is
// quiet when no worker of the run is mid-turn and the plan holds nothing (policy-close-hold.cjs: no step due, in flight or just finished,
// the same rule the headless idle close uses). Then, if the finished steps differ from the last time this asked, the digest is claimed and
// published; a claim that finds nothing new publishes nothing. No store read: the watcher's snapshot and the poll's worker rows.

const { isMidTurn } = require('./wake.cjs');
const { createPolicyCloseHold } = require('./policy-close-hold.cjs');

const reopened = (s) => s.outcome === 'skipped' && /^E_(PAUSED|NOT_NOW)/.test(s.error || '');

function createQuiet() { return { hold: createPolicyCloseHold(), lastKey: '' }; }

// -> true when the digest should be asked for now.
function due(q, snap, workers, runId) {
  if (!snap || snap.failed || snap.readFailed || !Array.isArray(snap.tasks)) return false;
  if ((workers || []).some((w) => w.run_id === runId && isMidTurn(w))) return false;
  if (q.hold.holds(snap).length) return false;
  const key = (snap.steps || []).filter((s) => s.run_id === runId && s.outcome && s.outcome !== 'started' && !reopened(s)).map((s) => `${s.seq}|${s.finished_at}`).join(',');
  if (key === q.lastKey) return false;
  q.lastKey = key;
  return key !== '';
}

module.exports = { createQuiet, due };
