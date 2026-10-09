'use strict';
// background.cjs — build step 6e-4, ADR 0023 amendment 1
// decision 1, item 5. A worker's Claude-Code-only background Bash tasks, tracked from the parser's own
// `bg_task` event (parsers.cjs), and the one thing a park does about them: stop every task still running
// (`stop_task` over stdin, the same synchronous stdin-liveness check pause.cjs's own interrupt uses —
// never a write to an ended stdin). `onInitWhilePaused` (the unsolicited-turn interception) is gone with
// the live-paused design it belonged to (ADR 0023 amendment 2 decision 4): a parked worker has no process
// left to start a turn on its own.

const crypto = require('node:crypto');

const TERMINAL_TASK_STATUSES = ['completed', 'killed', 'failed', 'stopped'];

function resolveBgTaskWaiters(w, taskId) {
  const arr = w.bgTaskWaiters.get(taskId);
  if (!arr) return;
  w.bgTaskWaiters.delete(taskId);
  for (const r of arr) r();
}

function setStatus(w, taskId, status, at) {
  const t = w.bgTasks.get(taskId);
  if (t) t.status = status;
  else w.bgTasks.set(taskId, { task_id: taskId, description: null, status, started_at: at });
  if (TERMINAL_TASK_STATUSES.includes(status)) resolveBgTaskWaiters(w, taskId);
}

// `started` adds a running task (only ever called for `is_backgrounded: true`, the parser's own gate);
// `status`/`notified` set its status, ignoring one with none to act on; `list` replaces the whole set
// with the substrate's own listing (ADR 0023 amendment 2 item 5: a task that drops out of
// `background_tasks_changed` is removed outright, not merely flagged, and any waiter on it is resolved).
function noteBgTask(w, e) {
  if (e.op === 'started') {
    if (!w.bgTasks.has(e.task_id)) w.bgTasks.set(e.task_id, { task_id: e.task_id, description: e.description || null, status: 'running', started_at: e.at });
    return;
  }
  if (e.op === 'status' || e.op === 'notified') {
    if (!e.status) return;
    setStatus(w, e.task_id, e.status, e.at);
    return;
  }
  if (e.op === 'list') {
    const listed = new Set(e.tasks || []);
    for (const id of [...w.bgTasks.keys()]) {
      if (!listed.has(id)) { w.bgTasks.delete(id); resolveBgTaskWaiters(w, id); }
    }
    for (const id of listed) {
      if (!w.bgTasks.has(id)) w.bgTasks.set(id, { task_id: id, description: null, status: 'running', started_at: e.at });
    }
  }
}

function runningTasks(w) {
  return [...w.bgTasks.values()].filter((t) => !TERMINAL_TASK_STATUSES.includes(t.status));
}

// Bounded, within what is left of `ms`, for `taskId`'s own status to turn terminal — the
// control_response only says the stop request was accepted, not that the task has actually stopped
// (bg-probe.cjs receipts/bg-midturn: control_response success arrives before the task_updated killed
// line). Resolves at once if it already has.
function waitTaskTerminal(w, taskId, ms) {
  return new Promise((res) => {
    if (TERMINAL_TASK_STATUSES.includes((w.bgTasks.get(taskId) || {}).status)) return res(null);
    const fn = () => { clearTimeout(t); res(null); };
    const t = setTimeout(() => {
      const arr = w.bgTaskWaiters.get(taskId);
      if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
      res(null);
    }, Math.max(0, ms));
    if (t.unref) t.unref();
    if (!w.bgTaskWaiters.has(taskId)) w.bgTaskWaiters.set(taskId, []);
    w.bgTaskWaiters.get(taskId).push(fn);
  });
}

async function stopOne(w, task, boundMs, t0) {
  const requestId = 'belay-stop-task-' + crypto.randomUUID();
  let controlResolve;
  const controlP = new Promise((res) => { controlResolve = res; });
  w.controlWaiters.set(requestId, controlResolve);
  // The same synchronous stdin re-check pause.cjs's own interrupt uses: this either sends cleanly or
  // correctly reports sent:false — never a stale sent:true for a write that in fact failed.
  const stdin = w.child && w.child.stdin;
  let sent = !!stdin && !stdin.destroyed && !stdin.writableEnded;
  if (sent) {
    try {
      stdin.write(JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'stop_task', task_id: task.task_id } }) + '\n');
    } catch { sent = false; }
  }
  const timer = new Promise((res) => { const t = setTimeout(() => res(null), Math.max(0, boundMs - (Date.now() - t0))); if (t.unref) t.unref(); });
  const controlEv = sent ? await Promise.race([controlP, timer]) : null;
  w.controlWaiters.delete(requestId);
  await waitTaskTerminal(w, task.task_id, boundMs - (Date.now() - t0));
  return {
    task_id: task.task_id, description: task.description, request_id: requestId, sent,
    response_subtype: controlEv ? controlEv.subtype : null,
    response_error: controlEv ? controlEv.error : null,
    status_after: (w.bgTasks.get(task.task_id) || task).status,
  };
}

// One `stop_task` per running task, bounded together with the pause's own interrupt — the caller passes
// the same `boundMs` and starts its clock at the same instant. `not_supported` or any other error
// response is recorded in the result, never thrown; the park proceeds regardless.
async function stopTasks(w, { boundMs }) {
  const running = runningTasks(w);
  if (!running.length) return [];
  const t0 = Date.now();
  return Promise.all(running.map((t) => stopOne(w, t, boundMs, t0)));
}

module.exports = { TERMINAL_TASK_STATUSES, noteBgTask, runningTasks, stopTasks };
