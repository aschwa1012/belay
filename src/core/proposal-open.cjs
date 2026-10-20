'use strict';
// proposal-open.cjs — the scrub proposals still open in a project (`propose` mode writes one per mark and applies nothing). Nothing closes a
// proposal row; one stops mattering when its note is settled, so a reader asks about the note, not the row. A read.

const { parse } = require('./memory-facts.cjs');

// [{ id, note_id, of, at, entry }] oldest first.
function openProposals(E, project) {
  let rows;
  try {
    rows = E.store.p("SELECT id, created_at, body FROM memory_entries WHERE namespace = ? AND type = 'proposal' AND json_extract(body, '$.state') = 'open' ORDER BY created_at, id").all(`proposal/${project}`);
  } catch { return []; }
  return rows.map((r) => { const b = parse(r.body); return { id: r.id, note_id: b.note_id, of: (b.entry && b.entry.of) || null, at: r.created_at, entry: b.entry || {} }; });
}

// The fields that make two marks the same mark (the reason and cites are the model's wording, not the verdict).
const SIGNATURE = ['action', 'kind', 'resolve', 'relation', 'of', 'keep', 'ground'];
const sameMark = (a, b) => a.id === b.id && SIGNATURE.every((k) => (a[k] || null) === (b[k] || null));

module.exports = { openProposals, sameMark };
