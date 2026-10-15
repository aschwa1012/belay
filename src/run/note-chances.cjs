'use strict';
// note-chances.cjs — the run side of the notes sink record. While a worker runs, each memory_search / memory_retrieve
// answer the stream carried (parsers.cjs adds `shown`) is kept on the worker record. When the worker's lease_release
// answers without an error, the task has ended: the manager hands the core what the stream showed and the files the
// worker edited, and the core derives and writes the facts (core/memory-chances.cjs). With `notes_sink` off, nothing
// here keeps anything or calls anything. A failure never stops the worker; it is named on the worker (`lastError`).

const { relativeTo } = require('./observe.cjs');

const isRelease = (tool) => /(^|__)lease_release$/.test(String(tool || ''));

function onEvent(w, e, ctx) {
  if (e.kind !== 'tool_result') return;
  const lv = ctx.memoryLevers; // read at spawn; absent means the defaults, which are off
  if (!lv || lv.notes !== true || !lv.notes_sink || lv.notes_sink === 'off') return;
  if (e.shown) {
    (w.noteShown || (w.noteShown = [])).push({ route: e.shown.route, ids: e.shown.ids, at: e.at });
  } else if (isRelease(e.tool) && !e.is_error && w.taskId && w.noteChancesTask !== w.taskId) {
    w.noteChancesTask = w.taskId;
    w.queue = w.queue.then(() => send(w, ctx)).catch(() => {});
  }
}

async function send(w, ctx) {
  const shown = (w.noteShown || []).splice(0);
  const changed = [...(w.filesTouched || [])].map((f) => relativeTo(f, w.worktree));
  try {
    await ctx.core.memory.recordChances({ task_id: w.taskId, worker_id: w.id, shown, changed_files: changed });
  } catch (err) {
    w.lastError = { where: 'memory.recordChances', code: err && err.code, message: err && err.message };
  }
}

module.exports = { onEvent };
