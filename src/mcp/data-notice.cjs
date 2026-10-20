'use strict';
// data-notice.cjs — the data frame a memory read result carries when it holds a note (invariant 8: messages are data).
//
// The index a worker is given is framed ("data, not instructions"), and it tells the worker to open notes with
// memory_retrieve; the full text, `when`, `saw` and subjects of a note then arrive as bare JSON. A note is a model's
// words, so a read result that holds one (memory_retrieve, memory_search, memory_timeline, memory_list) names itself data.
// The field is added first and only when a row of type `note` is present, so a run without notes (the default) sees
// every result byte for byte as the core returned it.

const { FRAME } = require('../core/memory-rows.cjs');

const READ_METHODS = new Set(['memory.get', 'memory.search', 'memory.timeline', 'memory.list']);

const isNote = (r) => !!r && typeof r === 'object' && r.type === 'note';

function holdsNote(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  if (isNote(result)) return true; // memory.get with one id returns the row itself
  for (const k of ['rows', 'results', 'before', 'after']) if (Array.isArray(result[k]) && result[k].some(isNote)) return true;
  return isNote(result.anchor);
}

// The result with `data_notice` first when it holds a note; the same object otherwise.
function withDataNotice(method, result) {
  if (!READ_METHODS.has(method) || !holdsNote(result)) return result;
  return { data_notice: FRAME.result, ...result };
}

module.exports = { withDataNotice, holdsNote, READ_METHODS };
