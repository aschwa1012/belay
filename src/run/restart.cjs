'use strict';
// restart.cjs — build step 6c, design item 2. `decideBranch`
// and `restartFirstText` moved verbatim out of manager.cjs, along with the two resume-window constants,
// to bring that file under the repository's 500-line rule. Bodies unchanged (contract §5, ADR 0007 §5);
// `restartFirstText` takes `core` as a parameter now instead of closing over manager.cjs's own.

const fs = require('node:fs');
const path = require('node:path');
const L = require('./launch.cjs');

const CLAUDE_RESUME_WINDOW_MS = 55 * 60 * 1000; // ADR 0001 §6/§7: 1 h cache, 5 min of margin
const CODEX_RESUME_WINDOW_MS = 25 * 60 * 1000; // ~30 min server-side window, 5 min of margin
const now = () => Date.now();

// Contract §5 branch rule. `reason` states the numbers it decided on.
function decideBranch(w) {
  const window_ms = w.substrate === 'codex' ? CODEX_RESUME_WINDOW_MS : CLAUDE_RESUME_WINDOW_MS;
  const age_ms = w.lastEventAt ? now() - w.lastEventAt : null;
  if (!w.sessionId) return { branch: 'replace', reason: 'no session or thread id is known for this worker', age_ms, window_ms };
  if (age_ms === null) return { branch: 'replace', reason: 'no event has ever been seen, so there is no age to compare with the window', age_ms, window_ms };
  if (age_ms <= window_ms) return { branch: 'resume', reason: `last event ${age_ms} ms ago, inside the ${window_ms} ms ${w.substrate} window`, age_ms, window_ms };
  return { branch: 'replace', reason: `last event ${age_ms} ms ago, outside the ${window_ms} ms ${w.substrate} window`, age_ms, window_ms };
}

async function restartFirstText(w, branch, { core }) {
  if (branch === 'resume') {
    const rl = w.taskId ? await core.continuity.resumeLine({ task_id: w.taskId }).catch(() => null) : null;
    return 'You were interrupted and resumed. Continue from where you left off.' + (rl && rl.text ? '\n\n' + rl.text : '');
  }
  const key = w.taskId ? { task_id: w.taskId } : { worker_id: w.id };
  try {
    const doc = await core.continuity.resumeDoc(key);
    if (doc && doc.text) fs.writeFileSync(L.fwd(path.join(w.dir, 'resume.md')), doc.text);
  } catch (e) {
    w.lastError = { where: 'continuity.resumeDoc', code: e && e.code, message: e && e.message };
  }
  const rl = await core.continuity.resumeLine(key).catch(() => null);
  return (rl && rl.text ? rl.text + '\n\n' : '') +
    'This is a fresh session replacing an interrupted one. Read resume.md in your worker directory, then continue.';
}

module.exports = { decideBranch, restartFirstText, CLAUDE_RESUME_WINDOW_MS, CODEX_RESUME_WINDOW_MS };
