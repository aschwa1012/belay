'use strict';
// memory-capture.cjs — the turn's event buffer and the observation row (ADR 0041 decisions 2, 3 and 7).
// worker.cjs holds one-line hooks into this file; turn-record.cjs calls `plan` and `finish` on the worker's
// own memoryQueue. Every entry point reads its lever first and returns before doing any work when the lever
// is off, so a run at the defaults buffers nothing, stores nothing and records nothing.
//
// `onEvent` runs on the stream's ingest path and is synchronous and cheap: it keeps the tool events of the
// turn in progress. When the turn ends the buffer moves, keyed by the turn_end event itself, so a turn the
// compaction hook swallows leaves nothing behind and a late turn cannot take the next turn's events.

const crypto = require('node:crypto');

// A turn of unusual length must not grow the buffer without bound; the overflow is counted and the
// observation's receipt says events were dropped.
const MAX_TURN_EVENTS = 4000;

const batches = new WeakMap(); // turn_end event -> { events, dropped }

const wants = (lv) => !!(lv && lv.capture && (lv.observations || jobLevers(lv)));
const jobLevers = (lv) => !!(lv && ((lv.summaries && lv.summaries !== 'off') || lv.project_writes || lv.cost_ledger || lv.wrapup));

const codeOf = (e) => (e && typeof e.code === 'string' && e.code.startsWith('E_') ? e.code : 'E_INTERNAL');
const noteError = (w, where, e) => { w.lastError = { where, code: e && e.code, message: e && e.message }; };

// Called for every parsed stream event, with the run's levers (undefined before they are read).
function onEvent(w, e, lv) {
  if (!wants(lv)) return;
  // A relaunch installs a fresh parser; whatever a previous life buffered without a turn_end is not this turn's.
  if (!w.memBuf || w.memBuf.parser !== w.parser) w.memBuf = { parser: w.parser, events: [], dropped: 0 };
  if (e.kind === 'tool_use' || e.kind === 'tool_result') {
    if (w.memBuf.events.length >= MAX_TURN_EVENTS) w.memBuf.dropped += 1;
    else w.memBuf.events.push(e);
  } else if (e.kind === 'turn_end') {
    batches.set(e, { events: w.memBuf.events, dropped: w.memBuf.dropped });
    w.memBuf = { parser: w.parser, events: [], dropped: 0 };
  } else if (e.kind === 'turn_failed') {
    w.memBuf = { parser: w.parser, events: [], dropped: 0 };
  }
}

// The events of the turn that `e` (its turn_end) closed; [] when nothing was buffered. Without `e`, whatever
// the worker has buffered so far.
function takeTurn(w, e) {
  if (e) {
    const b = batches.get(e);
    batches.delete(e);
    return b ? b.events : [];
  }
  const events = w.memBuf ? w.memBuf.events : [];
  w.memBuf = null;
  return events;
}

// What the turn's queued work needs, decided synchronously at turn end: null when every lever that uses the
// capture is off.
function plan(w, e, ctx) {
  const lv = ctx.memoryLevers;
  if (!lv || !(lv.observations || jobLevers(lv))) return null;
  const b = batches.get(e);
  batches.delete(e);
  return { levers: lv, events: b ? b.events : [], dropped: b ? b.dropped : 0 };
}

async function record(ctx, w, fields) {
  try {
    await ctx.core.memory.recordEvent({ worker_id: w.id, task_id: w.taskId || undefined, ...fields });
    return true;
  } catch (err) {
    noteError(w, 'memory.recordEvent', err);
    return false;
  }
}

// The observation row for the turn (ADR 0041 decision 3): one per turn, `embed: false`, source `harness`.
// A failure is a memory_event with ok 0 and its code, never retried. Returns the stored row, or null.
async function storeObservation(w, e, ctx, p) {
  if (!p.levers.observations) return null;
  const turn = w.turns;
  let obs;
  try {
    const { buildObservation } = require('./observe.cjs');
    obs = buildObservation({
      turn, worker_id: w.id, task_id: w.taskId || null, substrate: w.substrate,
      events: p.events, final_text: e.text || w.lastAssistantText || '',
    });
  } catch (err) {
    noteError(w, 'memory.observe', err);
    await record(ctx, w, { kind: 'observation', ok: 0, code: codeOf(err), message: String((err && err.message) || err).slice(0, 300) });
    return null;
  }
  const args = { type: 'observation', title: obs.title, text: obs.text, body: obs.body, embed: false, source: 'harness', turn };
  if (w.taskId) args.task_id = w.taskId;
  let row;
  try {
    row = await ctx.core.memory.store(args);
  } catch (err) {
    noteError(w, 'memory.store', err);
    await record(ctx, w, { kind: 'observation', ok: 0, code: codeOf(err), message: String((err && err.message) || err).slice(0, 300), dropped: p.dropped > 0 ? 1 : 0 });
    return null;
  }
  const id = row && row.id;
  await record(ctx, w, {
    kind: 'observation', ok: 1, row_ids: id ? [id] : [], newest_row_id: id || undefined,
    bytes: Buffer.byteLength(obs.text, 'utf8'), sha256: crypto.createHash('sha256').update(obs.text).digest('hex'),
    dropped: p.dropped > 0 ? 1 : 0,
  });
  return row;
}

// The jobs that follow a turn (summary, project copies, usage, wrap-up) belong to memory-jobs.cjs; this only
// calls it, lever-gated, on the same queue. `ctx.modules.jobs` lets a test inject it.
async function afterTurn(w, ctx, p, extra) {
  if (!jobLevers(p.levers)) return;
  try {
    const mod = (ctx.modules && ctx.modules.jobs) || require('./memory-jobs.cjs');
    await mod.afterTurn(w, ctx, { turnEvents: p.events, ...extra });
  } catch (err) {
    noteError(w, 'memory.afterTurn', err);
  }
}

// The whole after-turn memory work for a planned turn, in order: the observation, then the jobs.
async function finish(w, e, ctx, p, extra) {
  const row = await storeObservation(w, e, ctx, p);
  await afterTurn(w, ctx, p, { ...extra, observationId: row ? row.id : null });
}

module.exports = { onEvent, takeTurn, plan, finish, storeObservation, MAX_TURN_EVENTS };
