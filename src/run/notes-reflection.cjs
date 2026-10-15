'use strict';
// notes-reflection.cjs — ADR 0047, write ablation: with `memory.notes` and `memory.notes_reflection` on, once a worker's
// task has ended, belay asks the end-of-task question again as a turn of its own (the worker answers with a second
// `lease_release` carrying only notes; the core writes them and leaves the release as it was). Once per
// (task, worker), after the turn in which the task was seen ended. The outcome is a `reflection` receipt, ok or with
// the code that failed it: a worker that is gone, paused or busy is a failed receipt, never silence.

const NC = require('./notes-contract.cjs');

const codeOf = (e) => (e && typeof e.code === 'string' && e.code.startsWith('E_') ? e.code : 'E_INTERNAL');

// J: the memory-jobs context. `event(J, fields)` writes a receipt. Returns true when a message was sent.
async function reflect(J, { taskId, workerId }, event) {
  const { lv, s, ctx } = J;
  const key = `${taskId}|${workerId}`;
  if (!lv.notes || !lv.notes_reflection || s.reflectDone.has(key)) return false;
  s.reflectDone.add(key); // once, whatever happens: a failed send is a receipt, not a retry loop
  const base = { kind: 'reflection', worker_id: workerId, task_id: taskId, key: `task:${taskId}` };
  if (typeof ctx.message !== 'function') {
    await event(J, { ...base, ok: false, code: 'E_INTERNAL', message: 'the run manager gave the memory jobs no way to message a worker' });
    return false;
  }
  try {
    const sent = await ctx.message({ worker_id: workerId, text: NC.reflection(lv) });
    await event(J, { ...base, ok: true, bytes: sent && sent.bytes, message: `asked ${workerId} the end-of-task question again after the hand-back of ${taskId}` });
    return true;
  } catch (e) {
    await event(J, { ...base, ok: false, code: codeOf(e), message: String((e && e.message) || e).slice(0, 300) });
    return false;
  }
}

module.exports = { reflect };
