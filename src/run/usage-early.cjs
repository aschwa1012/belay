'use strict';
// usage-early.cjs — a ledger run's usage row for a turn starts at the turn's end, ahead of the worker's memory queue (turn-record.cjs
// queueMemory calls it before it chains the turn's observation, embeds and jobs). A budget reads that row to decide on a pause, and
// the queue can hold a turn behind seconds of embedding. The queue still drains this write before shutdown (it is chained into
// `memoryQueue`), and memory-jobs.cjs's usageJob writes a turn once, so the queued pass finds the row done and does nothing.

function start(w, ctx, snap) {
  const MJ = require('./memory-jobs.cjs');
  const u = (w.usageQueue = (w.usageQueue || Promise.resolve()).then(() => MJ.usageJob(MJ.jobCtx(ctx, ctx.memoryLevers, w, null, true), snap)).catch((e) => { w.lastError = { where: 'memory-jobs.usage', code: e && e.code, message: e && e.message }; }));
  w.memoryQueue = (w.memoryQueue || Promise.resolve()).then(() => u);
  return u;
}

module.exports = { start };
