'use strict';
// restart.cjs — build step 6c, design item 2. `decideBranch`
// and `restartFirstText` moved verbatim out of manager.cjs, along with the two resume-window constants,
// to bring that file under the repository's 500-line rule. Bodies unchanged (contract §5, ADR 0007 §5);
// `restartFirstText` takes `core` as a parameter now instead of closing over manager.cjs's own.

const fs = require('node:fs');
const crypto = require('node:crypto');
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

const OBS_MAX = 200; // observations fetched for a bottle: the newest turns matter most, and the page is bounded
const GET_MANY_MAX = 50;

// The turn observations stored for this worker's task, oldest first, for the bottle's exit data. Never throws:
// an unavailable store gives `{ rows: [], note }` and the bottle is built without them, which the event says.
async function storedObservations(w, core, lv) {
  if (!lv.observations) return { rows: [], note: 'observations lever off' };
  if (!w.taskId) return { rows: [], note: 'no task, so no observations are looked up' };
  try {
    const listed = await core.memory.list({ filter: { types: ['observation'], task_id: w.taskId }, order: 'newest', limit: OBS_MAX, view: 'index' });
    const ids = ((listed && listed.rows) || []).map((r) => r.id).reverse();
    const rows = [];
    for (let i = 0; i < ids.length; i += GET_MANY_MAX) {
      const got = await core.memory.get_many({ ids: ids.slice(i, i + GET_MANY_MAX), view: 'full' });
      for (const r of (got && got.rows) || []) if (r && r.found !== false) rows.push(r);
    }
    return { rows, note: `${rows.length} observations` };
  } catch (e) {
    w.lastError = { where: 'memory.list', code: e && e.code, message: e && e.message };
    return { rows: [], note: `observations unavailable (${(e && e.code) || 'E_INTERNAL'})` };
  }
}

// ADR 0042 decision 4: on the replace branch with `memory.bottle` on, resume.md is the bottle, written
// atomically. True when it was written; false when the caller must fall back to today's resume document, and
// then a `bottle` event with ok 0 names why. Every outcome is a receipt; nothing is silent.
async function writeBottle(w, ctx, core, lv) {
  const B = require('./bottle.cjs');
  const SL = require('./sent-log.cjs');
  const event = async (fields) => {
    try { await core.memory.recordEvent({ worker_id: w.id, task_id: w.taskId || undefined, kind: 'bottle', ...fields }); }
    catch (e) { w.lastError = { where: 'memory.recordEvent', code: e && e.code, message: e && e.message }; }
  };
  await SL.flush(w, ctx);
  const obs = await storedObservations(w, core, lv);
  const built = B.buildBottle({ streamPath: w.streamPath, sentPath: SL.sentPath(w), observations: obs.rows, maxBytes: lv.bottle_bytes });
  const detail = `user_messages=${built.user_messages}; ${obs.note}`;
  if (built.fallback) {
    await event({ ok: 0, code: built.fallback, dropped: built.dropped > 0 ? 1 : 0, over_budget: built.over_budget ? 1 : 0, message: `fell back to the resume document; ${detail}` });
    return false;
  }
  try {
    B.writeAtomic(L.fwd(path.join(w.dir, 'resume.md')), built.text);
  } catch (e) {
    w.lastError = { where: 'bottle.writeAtomic', code: e && e.code, message: e && e.message };
    await event({ ok: 0, code: 'E_BOTTLE_WRITE', message: `fell back to the resume document; ${detail}` });
    return false;
  }
  w.bottleCarriesFirst = built.spec_pinned === true; // only a bottle that holds the recorded first message carries the opening index
  w.bottleText = built.text; // the memory preface keeps only the shown rows whose lines this text holds
  await event({
    ok: 1, bytes: built.bytes, sha256: crypto.createHash('sha256').update(built.text).digest('hex'),
    dropped: built.dropped > 0 ? 1 : 0, over_budget: 0,
    message: `${detail}; messages=${built.messages}; tool_calls=${built.tool_calls_replaced}; dropped=${built.dropped}`,
  });
  return true;
}

// `ctx` is optional: without it (or with `memory.bottle` off) the replace branch is exactly what it was.
async function restartFirstText(w, branch, { core, ctx }) {
  if (branch === 'resume') {
    const rl = w.taskId ? await core.continuity.resumeLine({ task_id: w.taskId }).catch(() => null) : null;
    return 'You were interrupted and resumed. Continue from where you left off.' + (rl && rl.text ? '\n\n' + rl.text : '');
  }
  const key = w.taskId ? { task_id: w.taskId } : { worker_id: w.id };
  w.bottleText = null;
  w.bottleCarriesFirst = false; // set true by writeBottle only; every other replace starts a conversation that holds nothing of the old one's index
  const lv = ctx ? await require('./memory-preface.cjs').levers(ctx, w) : null;
  const bottled = !!(lv && lv.bottle) && await writeBottle(w, ctx, core, lv);
  if (!bottled) {
    try {
      const doc = await core.continuity.resumeDoc(key);
      if (doc && doc.text) fs.writeFileSync(L.fwd(path.join(w.dir, 'resume.md')), doc.text);
    } catch (e) {
      w.lastError = { where: 'continuity.resumeDoc', code: e && e.code, message: e && e.message };
    }
  }
  const rl = await core.continuity.resumeLine(key).catch(() => null);
  return (rl && rl.text ? rl.text + '\n\n' : '') +
    'This is a fresh session replacing an interrupted one. Read resume.md in your worker directory, then continue.' + require('./task-body.cjs').PROCESS_LINE; // a new session has not seen the standing line
}

// ADR 0046 decision 1: a worker launched again (restart, resume, a Codex turn) may have been adopted from a run that has
// ended. Before any process starts, the core makes its task's files held for this adapter's live run (the task and its
// lease move here), or refuses E_FILES_OVERLAP / E_RUN_NOT_LIVE and nothing is launched.
// Returns ensureHold's answer (null without a task). ADR 0026 amendment 2: a worker whose death released its lease gets it back
// (`regranted`) when nobody has been given the task since, and is otherwise told it holds none (`lease_lost`).
async function holdForLaunch(w, core) {
  return w.taskId ? core.task.ensureHold({ task_id: w.taskId, worker_id: w.id }) : null;
}

// What the relaunch's receipt says about the lease its death released: granted back, or lost. Empty otherwise.
function leaseField(hold) {
  if (!hold || !(hold.regranted || hold.reason === 'lease_lost')) return {};
  return { lease: { task_id: hold.task_id, lease_id: hold.lease_id, regranted: !!hold.regranted, ...(hold.regranted ? {} : { task_state: hold.task_state, current_holder: hold.current_holder, note: 'released when the previous process died; this worker holds no lease and must not hand the task back' }) } };
}

// The line the worker's first text gains when it lost its lease: it must not act as the task's holder.
function leaseNote(hold) {
  if (!hold || hold.reason !== 'lease_lost') return '';
  return `

Your lease ${hold.lease_id} on task ${hold.task_id} was released when your previous process died, and the task is now ${hold.task_state}${hold.current_holder ? `, leased to ${hold.current_holder}` : ''}. You hold no lease on it: do not hand it back (lease_release) or write checkpoints for it.`;
}

module.exports = { decideBranch, restartFirstText, holdForLaunch, leaseField, leaseNote, CLAUDE_RESUME_WINDOW_MS, CODEX_RESUME_WINDOW_MS };
