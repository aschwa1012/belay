'use strict';
// proposal-open.cjs — the scrub proposals still open in a project (`propose` mode writes one per mark and applies nothing). Nothing closes a
// proposal row; one stops mattering when its note is settled, so a reader asks about the note, not the row. A read.

const { parse, loadNote } = require('./memory-facts.cjs');
const { keyOf } = require('./memory-relate.cjs');

// What each note a mark names was made of when the mark was proposed: its text, vector model and dimension, and template (the key a pair
// judgement records, memory-relate.cjs keyOf). Stored on the proposal row; a mark proposed before this was recorded has none.
function keysFor(E, ids) {
  const keys = {};
  for (const id of ids) { const n = id ? loadNote(E, id) : null; if (n) keys[id] = keyOf(n); }
  return keys;
}

// A proposal is about the notes as they were: once either note's text, vector or template has changed, it says nothing about them now
// (a re-embedded pair is a new question, and a verdict made on the old vectors does not close it).
const fresh = (E, keys) => Object.entries(keys || {}).every(([id, key]) => { const n = loadNote(E, id); return !!n && keyOf(n) === key; });

// [{ id, note_id, of, at, entry }] oldest first, the proposals whose notes are unchanged since.
function openProposals(E, project) {
  let rows;
  try {
    rows = E.store.p("SELECT id, created_at, body FROM memory_entries WHERE namespace = ? AND type = 'proposal' AND json_extract(body, '$.state') = 'open' ORDER BY created_at, id").all(`proposal/${project}`);
  } catch { return []; }
  return rows.map((r) => ({ r, b: parse(r.body) })).filter(({ b }) => fresh(E, b.keys))
    .map(({ r, b }) => ({ id: r.id, note_id: b.note_id, of: (b.entry && b.entry.of) || null, at: r.created_at, entry: b.entry || {} }));
}

// The fields that make two marks the same mark (the reason and cites are the model's wording, not the verdict).
const SIGNATURE = ['action', 'kind', 'resolve', 'relation', 'of', 'keep', 'ground'];
const sameMark = (a, b) => a.id === b.id && SIGNATURE.every((k) => (a[k] || null) === (b[k] || null));

module.exports = { openProposals, sameMark, keysFor };
